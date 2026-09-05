BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE SCHEMA IF NOT EXISTS source_momence;
COMMENT ON SCHEMA source_momence IS 'Typed Momence staging and governed native-field projections.';
REVOKE ALL ON SCHEMA source_momence FROM PUBLIC;
GRANT USAGE ON SCHEMA source_momence TO ingest_rw, transform_rw, diagnostic_ro, semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_momence GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_momence GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;

CREATE TABLE IF NOT EXISTS "source_momence"."momence_profile" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_profile" IS 'Typed momence momence_profile staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_profile_connection_watermark_idx"
  ON "source_momence"."momence_profile" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_profile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_profile";
CREATE POLICY tenant_scope ON "source_momence"."momence_profile"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_members" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_members" IS 'Typed momence momence_members staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_members_connection_watermark_idx"
  ON "source_momence"."momence_members" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_members";
CREATE POLICY tenant_scope ON "source_momence"."momence_members"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_memberships" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_memberships" IS 'Typed momence momence_memberships staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_memberships_connection_watermark_idx"
  ON "source_momence"."momence_memberships" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_memberships";
CREATE POLICY tenant_scope ON "source_momence"."momence_memberships"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_appointments" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_appointments" IS 'Typed momence momence_appointments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_appointments_connection_watermark_idx"
  ON "source_momence"."momence_appointments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_appointments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_appointments";
CREATE POLICY tenant_scope ON "source_momence"."momence_appointments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_sessions" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_sessions" IS 'Typed momence momence_sessions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_sessions_connection_watermark_idx"
  ON "source_momence"."momence_sessions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_sessions";
CREATE POLICY tenant_scope ON "source_momence"."momence_sessions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_session_details" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_session_details" IS 'Typed momence momence_session_details staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_session_details_connection_watermark_idx"
  ON "source_momence"."momence_session_details" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_session_details" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_session_details" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_session_details";
CREATE POLICY tenant_scope ON "source_momence"."momence_session_details"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_session_bookings" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_session_bookings" IS 'Typed momence momence_session_bookings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_session_bookings_connection_watermark_idx"
  ON "source_momence"."momence_session_bookings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_session_bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_session_bookings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_session_bookings";
CREATE POLICY tenant_scope ON "source_momence"."momence_session_bookings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_bought_memberships" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_bought_memberships" IS 'Typed momence momence_bought_memberships staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_bought_memberships_connection_watermark_idx"
  ON "source_momence"."momence_bought_memberships" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_bought_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_bought_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_bought_memberships";
CREATE POLICY tenant_scope ON "source_momence"."momence_bought_memberships"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_member_sessions" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_member_sessions" IS 'Typed momence momence_member_sessions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_member_sessions_connection_watermark_idx"
  ON "source_momence"."momence_member_sessions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_member_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_member_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_member_sessions";
CREATE POLICY tenant_scope ON "source_momence"."momence_member_sessions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_member_appointments" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_member_appointments" IS 'Typed momence momence_member_appointments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_member_appointments_connection_watermark_idx"
  ON "source_momence"."momence_member_appointments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_member_appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_member_appointments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_member_appointments";
CREATE POLICY tenant_scope ON "source_momence"."momence_member_appointments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_member_notes" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_member_notes" IS 'Typed momence momence_member_notes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_member_notes_connection_watermark_idx"
  ON "source_momence"."momence_member_notes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_member_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_member_notes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_member_notes";
CREATE POLICY tenant_scope ON "source_momence"."momence_member_notes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_tags" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_tags" IS 'Typed momence momence_tags staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_tags_connection_watermark_idx"
  ON "source_momence"."momence_tags" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_tags";
CREATE POLICY tenant_scope ON "source_momence"."momence_tags"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_public_locations" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_public_locations" IS 'Typed momence momence_public_locations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_public_locations_connection_watermark_idx"
  ON "source_momence"."momence_public_locations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_public_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_public_locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_public_locations";
CREATE POLICY tenant_scope ON "source_momence"."momence_public_locations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_public_memberships" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_public_memberships" IS 'Typed momence momence_public_memberships staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_public_memberships_connection_watermark_idx"
  ON "source_momence"."momence_public_memberships" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_public_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_public_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_public_memberships";
CREATE POLICY tenant_scope ON "source_momence"."momence_public_memberships"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_public_sessions" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_public_sessions" IS 'Typed momence momence_public_sessions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_public_sessions_connection_watermark_idx"
  ON "source_momence"."momence_public_sessions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_public_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_public_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_public_sessions";
CREATE POLICY tenant_scope ON "source_momence"."momence_public_sessions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_sales" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_sales" IS 'Typed momence momence_sales staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_sales_connection_watermark_idx"
  ON "source_momence"."momence_sales" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_sales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_sales";
CREATE POLICY tenant_scope ON "source_momence"."momence_sales"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_momence"."momence_payment_transactions" (
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
  "record_id" text,
  "parent_id" text,
  "endpoint" text,
  "payload_json" jsonb,
  "field_index" jsonb,
  "name" text,
  "status" text,
  "occurred_at" timestamptz,
  "member_id" text,
  "session_id" text,
  "currency" text,
  "amount" numeric(19,4),
  "quantity" numeric(19,4),
  "is_cancelled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_momence"."momence_payment_transactions" IS 'Typed momence momence_payment_transactions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "momence_payment_transactions_connection_watermark_idx"
  ON "source_momence"."momence_payment_transactions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_momence"."momence_payment_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_momence"."momence_payment_transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_momence"."momence_payment_transactions";
CREATE POLICY tenant_scope ON "source_momence"."momence_payment_transactions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

-- This migration owns only the Momence schema. Other connector migrations own
-- their grants and may run later in the ordered analytical stream.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_momence" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_momence" TO transform_rw, diagnostic_ro, semantic_ro;

COMMIT;
