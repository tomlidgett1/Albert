BEGIN;

-- Semantic release qualification runs under the protected, NOLOGIN migration
-- owner after the deployer has explicitly SET ROLE. Semantic V2 release
-- artifacts use FORCE ROW LEVEL SECURITY, so table ownership alone correctly
-- does not make their immutable evidence visible. Grant the release pipeline
-- only the rows and mutation it needs: read the exact publication lineage and
-- profile evidence, then append one immutable activation qualification.

CREATE POLICY semantic_v2_drafts_release_qualification_read
  ON control_plane.semantic_v2_drafts
  FOR SELECT TO albert_control_migration_owner
  USING (true);

CREATE POLICY semantic_v2_draft_revisions_release_qualification_read
  ON control_plane.semantic_v2_draft_revisions
  FOR SELECT TO albert_control_migration_owner
  USING (true);

CREATE POLICY semantic_v2_profile_receipts_release_qualification_read
  ON control_plane.semantic_v2_profile_receipts
  FOR SELECT TO albert_control_migration_owner
  USING (true);

CREATE POLICY semantic_v2_publications_release_qualification_read
  ON control_plane.semantic_v2_publications
  FOR SELECT TO albert_control_migration_owner
  USING (true);

CREATE POLICY semantic_v2_activation_qualifications_release_append
  ON control_plane.semantic_v2_activation_qualifications
  FOR INSERT TO albert_control_migration_owner
  WITH CHECK (true);

COMMIT;
