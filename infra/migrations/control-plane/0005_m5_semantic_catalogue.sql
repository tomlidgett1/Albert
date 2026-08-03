BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION
      'Albert catalogue search requires pgvector. Enable the vector extension before applying M5.'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS control_plane.catalogue_document_kind_lookup (
  kind text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.catalogue_document_kind_lookup (kind,description) VALUES
  ('topic','A governed semantic Topic'),
  ('metric','A governed metric contract'),
  ('field','A governed semantic dimension'),
  ('source_field','A connector-manifest source extension, resolved through the tenant allowlist before disclosure')
ON CONFLICT (kind) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.catalogue_documents (
  publication_id text NOT NULL
    REFERENCES control_plane.semantic_publications(publication_id) ON DELETE RESTRICT,
  document_id text NOT NULL CHECK (
    document_id ~ '^(topic|metric|field):[a-z0-9_.]+$'
    OR document_id ~ '^source_field:[a-z0-9-]+:[a-z_][a-z0-9_]*:[a-z_][a-z0-9_]*$'
  ),
  kind text NOT NULL REFERENCES control_plane.catalogue_document_kind_lookup(kind),
  registry_version text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 20000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding_model text NOT NULL CHECK (embedding_model = 'text-embedding-3-large'),
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 1536),
  embedding extensions.vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig,coalesce(title,'')),'A') ||
    setweight(to_tsvector('english'::regconfig,coalesce(content,'')),'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id,document_id),
  UNIQUE (publication_id,content_hash)
);

CREATE INDEX IF NOT EXISTS catalogue_documents_keyword_idx
  ON control_plane.catalogue_documents USING gin (search_document);
CREATE INDEX IF NOT EXISTS catalogue_documents_embedding_idx
  ON control_plane.catalogue_documents
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16,ef_construction = 64);

CREATE OR REPLACE FUNCTION control_plane.reject_catalogue_document_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'control_plane.catalogue_documents is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS catalogue_documents_reject_mutation
  ON control_plane.catalogue_documents;
CREATE TRIGGER catalogue_documents_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.catalogue_documents
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_catalogue_document_mutation();

REVOKE ALL ON TABLE
  control_plane.catalogue_document_kind_lookup,
  control_plane.catalogue_documents
FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE
  control_plane.catalogue_document_kind_lookup,
  control_plane.catalogue_documents
TO service_role;

GRANT USAGE ON SCHEMA control_plane TO albert_semantic_control;
GRANT SELECT ON TABLE
  control_plane.tenant_overlays,
  control_plane.semantic_publications,
  control_plane.catalogue_document_kind_lookup,
  control_plane.catalogue_documents
TO albert_semantic_control;
GRANT INSERT,UPDATE ON TABLE control_plane.tenant_overlays
  TO albert_semantic_control;
GRANT INSERT ON TABLE control_plane.audit_log TO albert_semantic_control;

DROP POLICY IF EXISTS semantic_runtime_tenant_read
  ON control_plane.tenant_overlays;
CREATE POLICY semantic_runtime_tenant_read
  ON control_plane.tenant_overlays
  FOR SELECT TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true));
DROP POLICY IF EXISTS semantic_runtime_tenant_insert
  ON control_plane.tenant_overlays;
CREATE POLICY semantic_runtime_tenant_insert
  ON control_plane.tenant_overlays
  FOR INSERT TO albert_semantic_control
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
DROP POLICY IF EXISTS semantic_runtime_tenant_update
  ON control_plane.tenant_overlays;
CREATE POLICY semantic_runtime_tenant_update
  ON control_plane.tenant_overlays
  FOR UPDATE TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));

DROP POLICY IF EXISTS semantic_runtime_publication_read
  ON control_plane.semantic_publications;
CREATE POLICY semantic_runtime_publication_read
  ON control_plane.semantic_publications
  FOR SELECT TO albert_semantic_control
  USING (true);

DROP POLICY IF EXISTS semantic_runtime_audit_insert
  ON control_plane.audit_log;
CREATE POLICY semantic_runtime_audit_insert
  ON control_plane.audit_log
  FOR INSERT TO albert_semantic_control
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));

REVOKE ALL ON FUNCTION control_plane.reject_catalogue_document_mutation() FROM PUBLIC;

-- A bounded, narrative-only conversation context keeps production turns
-- independent of provider-side response retention. Tool payloads, SQL and
-- hidden reasoning are deliberately excluded.
CREATE OR REPLACE FUNCTION public.albert_model_context(
  p_conversation_id text,
  p_turn_limit integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF p_turn_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'model context turn limit must be between 1 and 24'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM control_plane.conversations AS conversation
    WHERE conversation.tenant_id=selected_tenant
      AND conversation.conversation_id=p_conversation_id
      AND conversation.created_by=actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH recent AS (
    SELECT turn.tenant_id,turn.turn_id,turn.turn_number,turn.user_message,turn.status
    FROM control_plane.conversation_turns AS turn
    WHERE turn.tenant_id=selected_tenant
      AND turn.conversation_id=p_conversation_id
      AND turn.created_by=actor
    ORDER BY turn.turn_number DESC
    LIMIT p_turn_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'turn_number',recent.turn_number,
    'user_message',recent.user_message,
    'status',recent.status,
    'assistant_event',(
      SELECT event.event
      FROM control_plane.conversation_turn_events AS event
      WHERE event.tenant_id=recent.tenant_id
        AND event.turn_id=recent.turn_id
        AND event.event->>'type' IN ('answer','clarification')
      ORDER BY event.sequence_number DESC
      LIMIT 1
    )
  ) ORDER BY recent.turn_number),'[]'::jsonb)
  INTO result
  FROM recent;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_model_context(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_model_context(text,integer) TO authenticated;

COMMIT;
