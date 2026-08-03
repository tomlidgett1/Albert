BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE TABLE IF NOT EXISTS "source_lightspeed"."vendors" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "vendor_id" text,
  "name" text,
  "archived" boolean,
  "time_stamp" timestamptz,
  "account_number" text,
  "price_level" text,
  "update_price" boolean,
  "update_cost" boolean,
  "update_description" boolean,
  "share_sell_through" boolean,
  "b2b_seller_uid" text,
  "contact" jsonb,
  "purchasing_currency" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."vendors" IS 'Typed lightspeed-r vendors staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "vendors_connection_watermark_idx"
  ON "source_lightspeed"."vendors" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."vendors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."vendors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."vendors";
CREATE POLICY tenant_scope ON "source_lightspeed"."vendors"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_lightspeed" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_lightspeed" TO transform_rw, diagnostic_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_xero" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_xero" TO transform_rw, diagnostic_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_deputy" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_deputy" TO transform_rw, diagnostic_ro;

COMMIT;
