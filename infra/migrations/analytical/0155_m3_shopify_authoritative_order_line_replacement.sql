-- Shopify order edits can remove mutable children without destroying the
-- parent Order. Only a complete, non-capped child collection is replacement
-- evidence; a partial page is never absence evidence.

BEGIN;

-- Cube and the control plane run against separate databases. A control-only
-- readiness block therefore cannot hide stale analytical rows when Shopify's
-- one-year destroy-event ledger is no longer continuous. This durable,
-- connection-wide publication fence is written before the control mutation
-- and is removed only by the verified connection/tenant deletion lifecycle.
CREATE TABLE IF NOT EXISTS quality.shopify_connection_queryability_blocks (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation>=1),
  sync_run_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'shopify_deletion_continuity_unproven',
    'shopify_deletion_watermark_missing',
    'shopify_deletion_retention_gap',
    'shopify_deletion_feed_unavailable'
  )),
  blocked_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,connection_id)
);

CREATE INDEX IF NOT EXISTS shopify_connection_queryability_blocks_generation_idx
  ON quality.shopify_connection_queryability_blocks (
    tenant_id,connection_id,connection_generation,blocked_at DESC
  );

ALTER TABLE quality.shopify_connection_queryability_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.shopify_connection_queryability_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON quality.shopify_connection_queryability_blocks;
CREATE POLICY tenant_scope ON quality.shopify_connection_queryability_blocks
  USING (tenant_id=(SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id=(SELECT ingestion.current_tenant_id()));

GRANT SELECT,INSERT ON quality.shopify_connection_queryability_blocks TO ingest_rw;
GRANT UPDATE (connection_generation,sync_run_id,reason,blocked_at)
  ON quality.shopify_connection_queryability_blocks TO ingest_rw;
GRANT SELECT ON quality.shopify_connection_queryability_blocks TO semantic_ro,diagnostic_ro,deletion_rw;

COMMENT ON TABLE quality.shopify_connection_queryability_blocks IS
  'Fail-closed Shopify publication fence. All private Shopify cubes exclude an exact tenant/connection while deletion-event continuity is unprovable; only verified deletion purge removes the fence.';

ALTER TABLE source_shopify.shopify_order_lines
  ADD COLUMN IF NOT EXISTS collection_scan_id text,
  ADD COLUMN IF NOT EXISTS collection_complete boolean;

ALTER TABLE source_shopify.shopify_order_lines
  DROP CONSTRAINT IF EXISTS shopify_order_lines_collection_evidence_check;
ALTER TABLE source_shopify.shopify_order_lines
  ADD CONSTRAINT shopify_order_lines_collection_evidence_check CHECK (
    (collection_scan_id IS NULL AND collection_complete IS NULL)
    OR (
      collection_scan_id ~ '^[0-9a-f]{64}$'
      AND collection_complete IS NOT NULL
      AND order_id IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS shopify_order_lines_collection_scan_idx
  ON source_shopify.shopify_order_lines (
    tenant_id,connection_id,order_id,collection_scan_id
  );

ALTER TABLE source_shopify.shopify_transactions
  ADD COLUMN IF NOT EXISTS collection_scan_id text,
  ADD COLUMN IF NOT EXISTS collection_complete boolean;
ALTER TABLE source_shopify.shopify_refund_lines
  ADD COLUMN IF NOT EXISTS collection_scan_id text,
  ADD COLUMN IF NOT EXISTS collection_complete boolean;
ALTER TABLE source_shopify.shopify_fulfillments
  ADD COLUMN IF NOT EXISTS collection_scan_id text,
  ADD COLUMN IF NOT EXISTS collection_complete boolean;
ALTER TABLE source_shopify.shopify_returns
  ADD COLUMN IF NOT EXISTS collection_scan_id text,
  ADD COLUMN IF NOT EXISTS collection_complete boolean;

DO $constraints$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'shopify_transactions','shopify_refund_lines',
    'shopify_fulfillments','shopify_returns'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE source_shopify.%I DROP CONSTRAINT IF EXISTS %I',
      table_name,table_name||'_collection_evidence_check'
    );
    EXECUTE format(
      'ALTER TABLE source_shopify.%I ADD CONSTRAINT %I CHECK (
         (collection_scan_id IS NULL AND collection_complete IS NULL)
         OR (
           collection_scan_id ~ ''^[0-9a-f]{64}$''
           AND collection_complete IS NOT NULL
           AND order_id IS NOT NULL
         )
       )',
      table_name,table_name||'_collection_evidence_check'
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON source_shopify.%I (
         tenant_id,connection_id,order_id,collection_scan_id
       )',
      table_name||'_collection_scan_idx',table_name
    );
  END LOOP;
END;
$constraints$;

CREATE TABLE IF NOT EXISTS quality.shopify_order_child_collection_replacements (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation>=1),
  replacement_batch_id text NOT NULL,
  sync_run_id text NOT NULL,
  collection_scan_id text NOT NULL CHECK (collection_scan_id ~ '^[0-9a-f]{64}$'),
  stream text NOT NULL CHECK (stream IN (
    'shopify_order_lines','shopify_transactions','shopify_refund_lines',
    'shopify_fulfillments','shopify_returns'
  )),
  source_object_type text NOT NULL,
  order_id text NOT NULL,
  source_record_id text NOT NULL,
  retired_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,replacement_batch_id,source_record_id),
  FOREIGN KEY (tenant_id,replacement_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS shopify_order_child_collection_replacements_parent_idx
  ON quality.shopify_order_child_collection_replacements (
    tenant_id,connection_id,stream,order_id,retired_at DESC
  );

ALTER TABLE quality.shopify_order_child_collection_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.shopify_order_child_collection_replacements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON quality.shopify_order_child_collection_replacements;
CREATE POLICY tenant_scope ON quality.shopify_order_child_collection_replacements
  USING (tenant_id=(SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id=(SELECT ingestion.current_tenant_id()));

GRANT SELECT,INSERT ON quality.shopify_order_child_collection_replacements TO ingest_rw;
GRANT SELECT ON quality.shopify_order_child_collection_replacements TO transform_rw,diagnostic_ro;

-- A refund-line allocation that disappears from a later complete Order
-- observation must no longer contribute a reversal to canonical sales.
ALTER TABLE core.commerce_refund_line
  ADD COLUMN IF NOT EXISTS voided boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.commerce_refund_line.voided IS
  'True when exact source evidence retired this refund allocation; voided refunds are excluded from analytical sales.';

CREATE OR REPLACE VIEW mart.commerce_sales_event
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  line.tenant_id,line.id,'sale'::text AS event_kind,
  line.order_id AS sale_order_id,line.location_id,line.register_id,
  line.channel_id,line.product_variant_id,category.product_category_id,
  line.customer_account_id,line.worker_id,line.business_date,
  line.quantity AS signed_quantity,line.gross_amount,line.discount_amount,
  line.net_amount_inc_tax AS sale_amount_inc_tax,
  line.net_amount_inc_tax AS signed_net_amount_inc_tax,
  line.net_amount_ex_tax AS signed_net_amount_ex_tax,
  line.total_cost AS signed_total_cost,
  0::numeric(19,4) AS refund_amount_inc_tax,line.voided,
  line.internal_transaction,line.currency,line.order_status,
  (line.total_cost IS NOT NULL) AS cost_observed
FROM core.commerce_order_line AS line
JOIN core.commerce_order AS order_header
  ON order_header.tenant_id=line.tenant_id AND order_header.id=line.order_id
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id=line.tenant_id
    AND assignment.product_variant_id=line.product_variant_id
    AND assignment.effective_from<=now()
    AND (assignment.effective_to IS NULL OR assignment.effective_to>now())
  ORDER BY assignment.effective_from DESC,assignment.id DESC LIMIT 1
) AS category ON true
WHERE line.order_status='completed' AND NOT line.voided
  AND NOT line.internal_transaction AND NOT order_header.voided
  AND order_header.status='completed'
UNION ALL
SELECT
  refund.tenant_id,refund.id,'refund'::text,original.order_id,
  refund.location_id,original.register_id,original.channel_id,
  refund.product_variant_id,category.product_category_id,
  original.customer_account_id,refund.worker_id,refund.business_date,
  -refund.quantity,0::numeric(19,4),0::numeric(19,4),
  0::numeric(19,4),-refund.refund_amount_inc_tax,
  -refund.refund_amount_ex_tax,-refund.total_cost_reversed,
  refund.refund_amount_inc_tax,false,original.internal_transaction,
  refund.currency,original.order_status,
  (refund.total_cost_reversed IS NOT NULL)
FROM core.commerce_refund_line AS refund
JOIN core.commerce_order_line AS original
  ON original.tenant_id=refund.tenant_id
 AND original.id=refund.original_order_line_id
JOIN core.commerce_order AS order_header
  ON order_header.tenant_id=original.tenant_id
 AND order_header.id=original.order_id
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id=refund.tenant_id
    AND assignment.product_variant_id=refund.product_variant_id
    AND assignment.effective_from<=now()
    AND (assignment.effective_to IS NULL OR assignment.effective_to>now())
  ORDER BY assignment.effective_from DESC,assignment.id DESC LIMIT 1
) AS category ON true
WHERE original.order_status IN ('completed','refunded')
  AND NOT original.voided AND NOT original.internal_transaction
  AND NOT refund.voided AND NOT order_header.voided
  AND order_header.status IN ('completed','refunded');

-- The immutable replacement audit references ingestion.batch_manifests. It
-- must therefore be purged before the predecessor wrapper deletes manifests,
-- and independently verified so privacy deletion cannot strand evidence.
ALTER FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  RENAME TO purge_connection_before_shopify_child_replacements;
ALTER FUNCTION deletion_internal.purge_tenant_pre_capability(text)
  RENAME TO purge_tenant_before_shopify_child_replacements;
ALTER FUNCTION deletion_internal.verify_connection_pre_capability(text,text)
  RENAME TO verify_connection_before_shopify_child_replacements;
ALTER FUNCTION deletion_internal.verify_tenant_pre_capability(text)
  RENAME TO verify_tenant_before_shopify_child_replacements;

CREATE FUNCTION deletion_internal.purge_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed bigint;blocked_removed bigint;result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  DELETE FROM quality.shopify_order_child_collection_replacements
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  DELETE FROM quality.shopify_connection_queryability_blocks
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS blocked_removed=ROW_COUNT;
  removed:=removed+blocked_removed;
  result:=deletion_internal.purge_connection_before_shopify_child_replacements(
    p_tenant_id,p_connection_id
  );
  RETURN jsonb_set(result,'{rowsRemoved}',
    to_jsonb(coalesce((result->>'rowsRemoved')::bigint,0)+removed),true);
END;
$$;

CREATE FUNCTION deletion_internal.purge_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed bigint;blocked_removed bigint;result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  DELETE FROM quality.shopify_order_child_collection_replacements
   WHERE tenant_id=p_tenant_id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  DELETE FROM quality.shopify_connection_queryability_blocks
   WHERE tenant_id=p_tenant_id;
  GET DIAGNOSTICS blocked_removed=ROW_COUNT;
  removed:=removed+blocked_removed;
  result:=deletion_internal.purge_tenant_before_shopify_child_replacements(p_tenant_id);
  RETURN jsonb_set(result,'{rowsRemoved}',
    to_jsonb(coalesce((result->>'rowsRemoved')::bigint,0)+removed),true);
END;
$$;

CREATE FUNCTION deletion_internal.verify_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE residual bigint;blocked_residual bigint;base jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  base:=deletion_internal.verify_connection_before_shopify_child_replacements(
    p_tenant_id,p_connection_id
  );
  SELECT count(*) INTO residual
    FROM quality.shopify_order_child_collection_replacements
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  SELECT count(*) INTO blocked_residual
    FROM quality.shopify_connection_queryability_blocks
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  residual:=residual+blocked_residual;
  base:=jsonb_set(base,'{residuals,otherAnalyticalRows}',
    to_jsonb(coalesce((base#>>'{residuals,otherAnalyticalRows}')::bigint,0)+residual),false);
  base:=jsonb_set(base,'{remainingRows}',
    to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+residual),false);
  RETURN jsonb_set(base,'{verified}',
    to_jsonb(coalesce((base->>'verified')::boolean,false) AND residual=0),false);
END;
$$;

CREATE FUNCTION deletion_internal.verify_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE residual bigint;blocked_residual bigint;base jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  base:=deletion_internal.verify_tenant_before_shopify_child_replacements(p_tenant_id);
  SELECT count(*) INTO residual
    FROM quality.shopify_order_child_collection_replacements
   WHERE tenant_id=p_tenant_id;
  SELECT count(*) INTO blocked_residual
    FROM quality.shopify_connection_queryability_blocks
   WHERE tenant_id=p_tenant_id;
  residual:=residual+blocked_residual;
  base:=jsonb_set(base,'{residuals,otherAnalyticalRows}',
    to_jsonb(coalesce((base#>>'{residuals,otherAnalyticalRows}')::bigint,0)+residual),false);
  base:=jsonb_set(base,'{remainingRows}',
    to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+residual),false);
  RETURN jsonb_set(base,'{verified}',
    to_jsonb(coalesce((base->>'verified')::boolean,false) AND residual=0),false);
END;
$$;

-- Rebind stable capability entry points so cached deletion-worker plans see
-- the new wrapper chain immediately after rolling migration.
CREATE OR REPLACE FUNCTION deletion_internal.purge_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_purge');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'connection'
     OR evidence->>'connection_id' IS DISTINCT FROM p_connection_id THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM capability_internal.record_tenant_revocation(p_tenant_id);
  RETURN deletion_internal.purge_connection_pre_capability(p_tenant_id,p_connection_id);
END;
$$;
CREATE OR REPLACE FUNCTION deletion_internal.purge_tenant(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_purge');evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'tenant'
     OR evidence->'connection_id' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM capability_internal.record_tenant_revocation(p_tenant_id);
  RETURN deletion_internal.purge_tenant_pre_capability(p_tenant_id);
END;
$$;
CREATE OR REPLACE FUNCTION deletion_internal.verify_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_verify');evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'connection'
     OR evidence->>'connection_id' IS DISTINCT FROM p_connection_id THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_connection_pre_capability(p_tenant_id,p_connection_id);
END;
$$;
CREATE OR REPLACE FUNCTION deletion_internal.verify_tenant(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_verify');evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'tenant'
     OR evidence->'connection_id' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_tenant_pre_capability(p_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_shopify_child_replacements(text,text),
  deletion_internal.purge_tenant_before_shopify_child_replacements(text),
  deletion_internal.verify_connection_before_shopify_child_replacements(text,text),
  deletion_internal.verify_tenant_before_shopify_child_replacements(text),
  deletion_internal.purge_connection_pre_capability(text,text),
  deletion_internal.purge_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text),
  deletion_internal.verify_tenant_pre_capability(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION
  deletion_internal.purge_connection_pre_capability(text,text),
  deletion_internal.purge_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text),
  deletion_internal.verify_tenant_pre_capability(text)
TO albert_migration_owner;
REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT USAGE ON SCHEMA deletion_internal TO deletion_rw;
GRANT EXECUTE ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
TO deletion_rw;

COMMENT ON TABLE quality.shopify_order_child_collection_replacements IS
  'Immutable, generation-bound evidence that a complete Shopify order child collection retired an exact previously observed child identity; partial or capped pages never write here.';

COMMIT;
