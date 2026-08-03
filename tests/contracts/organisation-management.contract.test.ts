import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("organisation selection and membership mutation remain server-authoritative", async () => {
  const migration = await read("infra/migrations/control-plane/0016_m1_organisation_management.sql");
  const concurrency = await read(
    "infra/migrations/control-plane/0036_m1_concurrency_safe_owner_invariant.sql",
  );
  const explicitTargets = await read(
    "infra/migrations/control-plane/0055_m1_m8_explicit_organisation_mutation_targets.sql",
  );
  const userRateLimit = await read(
    "infra/migrations/control-plane/0056_m1_user_bound_organisation_creation_rate_limit.sql",
  );
  assert.match(migration, /FOREIGN KEY \(tenant_id,user_id\)[\s\S]*memberships\(tenant_id,user_id\)/u);
  assert.match(migration, /membership\.status='active'/u);
  assert.match(migration, /tenant\.status='active'/u);
  assert.match(migration, /DROP POLICY IF EXISTS tenant_owners_insert/u);
  assert.match(migration, /REVOKE INSERT,UPDATE,DELETE ON control_plane\.memberships FROM authenticated/u);
  assert.match(migration, /the organisation must retain an active owner/u);
  assert.match(
    concurrency,
    /FROM control_plane\.tenants[\s\S]*tenant_id = selected_tenant[\s\S]*FOR UPDATE[\s\S]*has_tenant_role/u,
  );
  assert.match(
    concurrency,
    /existing\.role = 'owner'[\s\S]*other_owner_count = 0[\s\S]*the organisation must retain an active owner/u,
  );
  assert.match(migration, /registered confirmed Albert user was not found/u);
  assert.match(migration, /email_confirmed_at IS NOT NULL/u);
  assert.doesNotMatch(migration, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*user_active_tenants[^;]*authenticated/iu);
  assert.match(explicitTargets, /require_expected_active_tenant\([\s\S]*pg_advisory_xact_lock/u);
  assert.match(explicitTargets, /selected_tenant IS DISTINCT FROM p_expected_tenant_id/u);
  assert.match(explicitTargets, /organisation context changed; refresh before retrying/u);
  assert.match(explicitTargets, /FOR UPDATE[\s\S]*membership\.role = ANY\(p_roles\)/u);
  assert.match(
    explicitTargets,
    /albert_select_organisation\(p_tenant_id text\)[\s\S]*pg_advisory_xact_lock[\s\S]*FOR UPDATE/u,
  );
  for (const signature of [
    "albert_rename_organisation(text)",
    "albert_add_organisation_member(text,text)",
    "albert_update_organisation_member(uuid,text,text)",
    "albert_request_tenant_deletion(text)",
    "albert_approve_tenant_deletion(text,text)",
    "albert_cancel_tenant_deletion(text)",
  ]) {
    assert.match(explicitTargets, new RegExp(`DROP FUNCTION public\\.${signature.replace(/[()]/gu, "\\$&")}`, "u"));
  }
  assert.match(userRateLimit, /user_rate_limit_buckets[\s\S]*FORCE ROW LEVEL SECURITY/u);
  assert.match(userRateLimit, /albert:user-rate-limit:v1:/u);
  assert.match(userRateLimit, /consume_organisation_creation_rate_limit\(\)/u);
  assert.doesNotMatch(
    userRateLimit,
    /consume_albert_rate_limit\('organisation\.create'/u,
  );
  assert.match(userRateLimit, /tenant_deletion_receipts[\s\S]*rate_allowed/u);
});

test("organisation APIs validate mutations and enforce same-origin requests", async () => {
  const [organisations, members, selection] = await Promise.all([
    read("app/api/organisations/route.ts"),
    read("app/api/organisations/members/route.ts"),
    read("app/api/organisations/select/route.ts"),
  ]);
  for (const source of [organisations, members, selection]) {
    assert.match(source, /assertSameOriginMutation\(request\)/u);
    assert.match(source, /safeParse\(await readBoundedJsonBody\(request\)\)/u);
    assert.match(source, /Cache-Control/u);
  }
  assert.match(members, /z\.enum\(\["owner", "manager", "bookkeeper"\]\)/u);
  assert.match(selection, /\^\[0-9A-HJKMNP-TV-Z\]\{26\}\$/u);
  assert.match(organisations, /tenantId:\s*tenantIdSchema/u);
  assert.match(members, /tenantId:\s*tenantIdSchema/u);
  assert.match(organisations, /renameOrganisation\(body\.data\.tenantId/u);
  assert.match(members, /addOrganisationMember\(body\.data\.tenantId/u);
});

test("organisation workspace exposes switching, roles, and two-step deletion without bypasses", async () => {
  const [component, page, css] = await Promise.all([
    read("app/dash/components/OrganizationWorkspace.tsx"),
    read("app/dash/page.tsx"),
    read("app/dash/dash.module.css"),
  ]);
  assert.match(component, /\/api\/organisations\/select/u);
  assert.match(component, /\/api\/organisations\/members/u);
  assert.match(component, /DELETE \{workspace\?\.settings\.tenant\.name\}/u);
  assert.match(component, /ERASE \{workspace\?\.settings\.tenant\.name\}/u);
  assert.match(component, /\/api\/tenant\/deletion\/approve/u);
  assert.match(component, /\/api\/tenant\/deletion\/cancel/u);
  assert.match(component, /tenantId:\s*workspace\?\.settings\.tenant\.tenantId/u);
  assert.match(page, /<OrganizationWorkspace/u);
  assert.match(page, /accountOrganisation\.name/u);
  assert.match(css, /var\(--dash-control-height\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.organizationPanel/u);
});
