type MigrationForAuthCompatibility = Readonly<{
  id: string;
  checksum: string;
  body: string;
}>;

type AuthCompatibilitySpec = Readonly<{
  checksum: string;
  authUserReferences: number;
  authUserReads: number;
  authUidCalls: number;
  authJwtCalls: number;
}>;

type StorageCompatibilitySpec = Readonly<{
  checksum: string;
  rawBucketMutations: number;
}>;

const LEGACY_AUTH_COMPATIBILITY = new Map<string, AuthCompatibilitySpec>([
  ["0001_m1_control_plane_foundation.sql", Object.freeze({ checksum: "5fa669ed38df962ea76c66b398761fab9d45ffa662f891cb5fd492462bed9b3a", authUserReferences: 13, authUserReads: 0, authUidCalls: 8, authJwtCalls: 0 })],
  ["0002_m1_public_runtime.sql", Object.freeze({ checksum: "64a8d57e68dd0697624f287d8e6bacdb4f601b5cab6b8a5ab5f62d9418b27425", authUserReferences: 8, authUserReads: 0, authUidCalls: 20, authJwtCalls: 3 })],
  ["0003_m2_ingestion_operations.sql", Object.freeze({ checksum: "b191ca30638c3928358a91b34b6608698e298e18bdaec83233737373d2b959e6", authUserReferences: 1, authUserReads: 0, authUidCalls: 4, authJwtCalls: 0 })],
  ["0004_m4_canonical_projections.sql", Object.freeze({ checksum: "d6dfd0afb15a32e9962b9db4c5fc9bc85954093a31af8a70782df731ef5e0577", authUserReferences: 0, authUserReads: 0, authUidCalls: 2, authJwtCalls: 0 })],
  ["0005_m5_semantic_catalogue.sql", Object.freeze({ checksum: "f3324f2393f5b59cdefc76e8472f2a81e03195074d36759eb6a459b21acbe6d4", authUserReferences: 0, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0006_m8_deletion_lifecycle.sql", Object.freeze({ checksum: "e80c660b41482828c67bd0bc04e2c9adc60b5c3244daf0f3243bf011fa27d087", authUserReferences: 1, authUserReads: 0, authUidCalls: 3, authJwtCalls: 0 })],
  ["0013_m7_identity_decision_projection.sql", Object.freeze({ checksum: "70b921f68c5ce0f231b18b594ed236304671d79bac6c0c6f13f605e71e0ada8d", authUserReferences: 1, authUserReads: 0, authUidCalls: 2, authJwtCalls: 0 })],
  ["0014_m7_blocking_question_allowlist.sql", Object.freeze({ checksum: "17e2ea1a70f864ece0cc75f05bed733292591febcf04359ea2195cf19f49b8ad", authUserReferences: 0, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0015_m8_immutable_answer_artifact_lineage.sql", Object.freeze({ checksum: "b28af617fc159715f1e967e23a67cea2dfdf68f7d2d5b9767fef35e7648f2ac6", authUserReferences: 0, authUserReads: 0, authUidCalls: 2, authJwtCalls: 0 })],
  ["0016_m1_organisation_management.sql", Object.freeze({ checksum: "048f471f3b5c9bf364cfe97b6d57fd3a1b8660c8de42742840410af2d8c13bbc", authUserReferences: 1, authUserReads: 2, authUidCalls: 15, authJwtCalls: 1 })],
  ["0017_m2_operator_pipeline_console.sql", Object.freeze({ checksum: "2f8cea40b203c0745b9517523b140072e702ad566f4733ec72462d3c2aa5affa", authUserReferences: 0, authUserReads: 0, authUidCalls: 3, authJwtCalls: 0 })],
  ["0018_m8_conversation_finalization_fences.sql", Object.freeze({ checksum: "142f0fa1e77459b5a63de870d1d9587a815b4ac5f89afb9e87230403b7ddc277", authUserReferences: 0, authUserReads: 0, authUidCalls: 3, authJwtCalls: 0 })],
  ["0021_m1_concurrency_safe_tenant_bootstrap.sql", Object.freeze({ checksum: "42076afb2c801bfe00ed5903947bed19d2a450eff91ba42ab3d0ebaaad22be92", authUserReferences: 0, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0023_m6_one_use_clarification_confirmations.sql", Object.freeze({ checksum: "8d8b116af6b888f71019c0c82d2f4f70cc1788c743b3f3838a5472c0c9fefaa1", authUserReferences: 1, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0024_m6_durable_provider_usage_outcomes.sql", Object.freeze({ checksum: "402b9b58ddf81d2ec0157ee3653c6f81ee9d3874c413767417c3b72d0168eb8f", authUserReferences: 1, authUserReads: 0, authUidCalls: 0, authJwtCalls: 0 })],
  ["0028_m7_deputy_read_only_webhook_boundary.sql", Object.freeze({ checksum: "58b1710ad97a1a3f16d1e91af0b686eab9a8f1537b64a9166e2689c910226d3c", authUserReferences: 0, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0030_m2_operator_diagnostic_reveals.sql", Object.freeze({ checksum: "24226443c25d0e2c28baa1aa94ed2d5b0911e196133ffd492cac23da202450bb", authUserReferences: 1, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0034_m8_connection_lifecycle_authority.sql", Object.freeze({ checksum: "c80c9f46b9f5cbeb7a801dddad7004f572552257140b8c8f49272ba2050f7d11", authUserReferences: 0, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0036_m1_concurrency_safe_owner_invariant.sql", Object.freeze({ checksum: "7a54a3a33265bfae1aa7eb29762b3542cf4907329d2e972640f9a53654611e15", authUserReferences: 0, authUserReads: 1, authUidCalls: 2, authJwtCalls: 0 })],
  ["0052_m6_flagship_employee_performance_lenses.sql", Object.freeze({ checksum: "e16b931001c5f444688fdf4c15b71ee77c4758c2731fc53046db7536cdb41216", authUserReferences: 0, authUserReads: 0, authUidCalls: 1, authJwtCalls: 0 })],
  ["0053_m8_user_bound_tenant_deletion_receipts.sql", Object.freeze({ checksum: "9d579c254de7f4f20e8894b1a96c9816ae1a02ea2ba9534745b8e64825ccf6cf", authUserReferences: 1, authUserReads: 0, authUidCalls: 6, authJwtCalls: 0 })],
]);

const LEGACY_STORAGE_COMPATIBILITY = new Map<string, StorageCompatibilitySpec>([
  ["0003_m2_ingestion_operations.sql", Object.freeze({
    checksum: "b191ca30638c3928358a91b34b6608698e298e18bdaec83233737373d2b959e6",
    rawBucketMutations: 1,
  })],
]);

const AUTHORIZATION_CONNECTOR_BRIDGE = Object.freeze({
  id: "0085_m1_authorization_only_connector_providers.sql",
  checksum: "570efd8ac294890cb9808d1ab5b70164e412aeb4bae5ea54c30c3e554d8462ba",
});

const LIGHTSPEED_X_VENDOR_ATTESTOR_BRIDGE = Object.freeze({
  id: "0124_m1_lightspeed_x_connector_admission.sql",
  checksum: "729fcb66c7bbbe66a3ee7b2744eea6fefbbe1e3f8ea9158aa31d036e65efa76b",
});

const PROTECTED_DOGFOOD_ACL_COMPATIBILITY = Object.freeze({
  id: "0091_m3_spec_driven_stream_expectations.sql",
  checksum: "e5fb7f265ccebc5764b804fb8cb75a34dbc988b7c0397730bdb97786c027e692",
});

const AUTH_USER_REFERENCE = /\s+REFERENCES\s+auth\.users\s*\(\s*id\s*\)\s+ON\s+DELETE\s+(?:SET\s+NULL|CASCADE|RESTRICT)/giu;
const AUTH_USER_DIRECTORY_JOIN = /JOIN\s+auth\.users\s+AS\s+auth_user\s+ON\s+auth_user\.id\s*=\s*member\.user_id/giu;
const AUTH_USER_EMAIL_LOOKUP = /SELECT\s+id\s+INTO\s+invited_user\s+FROM\s+auth\.users\s+WHERE\s+lower\(email\)\s*=\s*normalized_email\s+AND\s+email_confirmed_at\s+IS\s+NOT\s+NULL\s+LIMIT\s+1;/giu;
const AUTH_UID_CALL = /\bauth\.uid\s*\(\s*\)/giu;
const AUTH_JWT_CALL = /\bauth\.jwt\s*\(\s*\)/giu;
const DIRECT_AUTH_DEPENDENCY = /\bauth\.(?:users\b|uid\s*\(|jwt\s*\()/iu;
const RAW_BUCKET_MUTATION = /\bINSERT\s+INTO\s+storage\.buckets\s*\(\s*id\s*,\s*name\s*,\s*public\s*,\s*file_size_limit\s*,\s*allowed_mime_types\s*\)\s*VALUES\s*\([\s\S]*?\)\s*ON\s+CONFLICT\s*\(\s*id\s*\)\s*DO\s+UPDATE\s+SET[\s\S]*?allowed_mime_types\s*=\s*EXCLUDED\.allowed_mime_types\s*;/giu;
const DIRECT_STORAGE_BUCKET_MUTATION = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+storage\.buckets\b/iu;

function replaceAndCount(
  value: string,
  pattern: RegExp,
  replacement: string,
): Readonly<{ value: string; count: number }> {
  let count = 0;
  return Object.freeze({
    value: value.replace(pattern, () => {
      count += 1;
      return replacement;
    }),
    get count() {
      return count;
    },
  });
}

function assertCount(id: string, dependency: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `${id} changed its reviewed ${dependency} count: expected ${expected}, received ${actual}.`,
    );
  }
}

/**
 * Supabase's managed postgres login can reference auth.users but cannot grant
 * that privilege to Albert's NOLOGIN migration owner. Historical migrations
 * remain checksum-immutable: only their exact reviewed bytes are converted to
 * the fixed Auth bridge installed by the administrator upgrade stream.
 */
export function controlPlaneMigrationBody(
  migration: MigrationForAuthCompatibility,
): string {
  if (migration.id === AUTHORIZATION_CONNECTOR_BRIDGE.id) {
    if (migration.checksum !== AUTHORIZATION_CONNECTOR_BRIDGE.checksum)
      throw new Error(
        `${migration.id} changed after its administrator-ownership compatibility review.`,
      );
    return "SELECT extensions.albert_install_authorization_connector_providers();";
  }
  if (migration.id === LIGHTSPEED_X_VENDOR_ATTESTOR_BRIDGE.id) {
    if (migration.checksum !== LIGHTSPEED_X_VENDOR_ATTESTOR_BRIDGE.checksum)
      throw new Error(
        `${migration.id} changed after its administrator-ownership compatibility review.`,
      );
    const challenges = replaceAndCount(
      migration.body,
      /ALTER TABLE control_plane\.live_vendor_attestation_challenges[\s\S]*?\n\s*\);/u,
      "SELECT extensions.albert_install_lightspeed_x_vendor_attestor_provider();",
    );
    const results = replaceAndCount(
      challenges.value,
      /ALTER TABLE control_plane\.live_vendor_attestation_results[\s\S]*?\n\s*\);/u,
      "-- Administrator bridge widened live_vendor_attestation_results;",
    );
    assertCount(migration.id, "administrator-owned challenge provider check", challenges.count, 1);
    assertCount(migration.id, "administrator-owned result provider check", results.count, 1);
    return results.value;
  }
  if (migration.id === PROTECTED_DOGFOOD_ACL_COMPATIBILITY.id) {
    if (migration.checksum !== PROTECTED_DOGFOOD_ACL_COMPATIBILITY.checksum)
      throw new Error(
        `${migration.id} changed after its protected-dogfood ACL compatibility review.`,
      );

    // Administrator upgrade 0010 has already transferred the public
    // acceptance collector to postgres and established this exact deny-all /
    // operator-only ACL. Historical migration 0091 repeats those two ACL
    // statements, which a deliberately non-owner migration role cannot issue.
    // Remove only the checksum-pinned duplicates; the rest of 0091 still runs.
    const revoke = replaceAndCount(
      migration.body,
      /,\s*control_plane\.capture_protected_dogfood_acceptance\(\s*text\s*,\s*text\s*,\s*text\s*,\s*jsonb\s*,\s*text\s*,\s*integer\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\)\s*(?=FROM PUBLIC)/giu,
      "\n",
    );
    const grant = replaceAndCount(
      revoke.value,
      /GRANT EXECUTE ON FUNCTION control_plane\.capture_protected_dogfood_acceptance\(\s*text\s*,\s*text\s*,\s*text\s*,\s*jsonb\s*,\s*text\s*,\s*integer\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\) TO albert_operator_diagnostic_control\s*;/giu,
      "-- ACL already fixed by administrator upgrade 0010;",
    );
    assertCount(migration.id, "administrator-owned collector revoke", revoke.count, 1);
    assertCount(migration.id, "administrator-owned collector grant", grant.count, 1);
    return grant.value;
  }
  const specification = LEGACY_AUTH_COMPATIBILITY.get(migration.id);
  const storageSpecification = LEGACY_STORAGE_COMPATIBILITY.get(migration.id);
  if (!specification && DIRECT_AUTH_DEPENDENCY.test(migration.body)) {
    throw new Error(
      `${migration.id} introduces an unreviewed direct Supabase Auth dependency.`,
    );
  }
  if (!storageSpecification && DIRECT_STORAGE_BUCKET_MUTATION.test(migration.body)) {
    throw new Error(
      `${migration.id} introduces an unreviewed direct Supabase Storage bucket mutation.`,
    );
  }
  if (!specification && !storageSpecification) {
    return migration.body;
  }
  if (specification && migration.checksum !== specification.checksum) {
    throw new Error(`${migration.id} changed after its Auth compatibility review.`);
  }

  let body = migration.body;
  if (specification) {
    const references = replaceAndCount(body, AUTH_USER_REFERENCE, "");
    body = references.value;

    let authUserReads = 0;
    const directoryJoin = replaceAndCount(
      body,
      AUTH_USER_DIRECTORY_JOIN,
      "JOIN LATERAL extensions.albert_auth_users_by_ids(ARRAY[member.user_id]) AS auth_user ON auth_user.id=member.user_id",
    );
    body = directoryJoin.value;
    authUserReads += directoryJoin.count;
    const emailLookup = replaceAndCount(
      body,
      AUTH_USER_EMAIL_LOOKUP,
      "SELECT resolved.id INTO invited_user FROM extensions.albert_auth_confirmed_user_by_email(normalized_email) AS resolved;",
    );
    body = emailLookup.value;
    authUserReads += emailLookup.count;

    const userIds = replaceAndCount(body, AUTH_UID_CALL, "extensions.albert_auth_uid()");
    body = userIds.value;
    const jwtClaims = replaceAndCount(body, AUTH_JWT_CALL, "extensions.albert_auth_jwt()");
    body = jwtClaims.value;

    assertCount(migration.id, "auth.users foreign-key", references.count, specification.authUserReferences);
    assertCount(migration.id, "auth.users read", authUserReads, specification.authUserReads);
    assertCount(migration.id, "auth.uid()", userIds.count, specification.authUidCalls);
    assertCount(migration.id, "auth.jwt()", jwtClaims.count, specification.authJwtCalls);
    if (DIRECT_AUTH_DEPENDENCY.test(body)) {
      throw new Error(`${migration.id} retains a direct Supabase Auth dependency after review.`);
    }
  }

  if (storageSpecification) {
    if (migration.checksum !== storageSpecification.checksum) {
      throw new Error(`${migration.id} changed after its Storage compatibility review.`);
    }
    const rawBucket = replaceAndCount(
      body,
      RAW_BUCKET_MUTATION,
      "-- The fixed administrator capability installs raw-payloads in migration 0042;",
    );
    body = rawBucket.value;
    assertCount(
      migration.id,
      "storage.buckets mutation",
      rawBucket.count,
      storageSpecification.rawBucketMutations,
    );
    if (DIRECT_STORAGE_BUCKET_MUTATION.test(body)) {
      throw new Error(`${migration.id} retains a direct Storage bucket mutation after review.`);
    }
  }
  return body;
}

export function reviewedControlPlaneAuthMigrations(): readonly string[] {
  return Object.freeze([...LEGACY_AUTH_COMPATIBILITY.keys()]);
}
