import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const page = read("app/dash/page.tsx");
const workspace = read("app/dash/components/MyDataWorkspace.tsx");
const styles = read("app/dash/components/my-data-workspace.module.css");
const catalogueRoute = read("app/api/my-data/route.ts");
const rowsRoute = read("app/api/my-data/rows/route.ts");
const repository = read("services/control-plane/src/my-data-repository.ts");
const controlMigration = read("infra/migrations/control-plane/0154_m6_fivetran_my_data_browser.sql");
const analyticalMigration = read("infra/migrations/analytical/0174_m6_fivetran_my_data_schema_read.sql");
const adr = read("docs/adr/0100-fivetran-my-data-browser.md");
const environment = read("packages/config/src/env.ts");
const runtimeContract = read("deploy/runtime-contract.json");

test("My Data is a first-class dash view with a non-semantic data-dashboard workspace", () => {
  assert.match(page, /import MyDataWorkspace from "\.\/components\/MyDataWorkspace"/u);
  assert.match(page, /type ActiveItem =[^;]*"My Data"/su);
  assert.match(page, /requestedView === "MyData"[\s\S]*setActiveItem\("My Data"\)/u);
  assert.match(page, /aria-label="My Data"[\s\S]*aria-current=\{activeItem === "My Data" \? "page"/u);
  assert.match(page, /activeItem === "My Data"[\s\S]*<MyDataWorkspace/u);

  assert.match(workspace, /aria-label="Connected data summary"/u);
  assert.match(workspace, /aria-label="Schemas and tables"/u);
  assert.match(workspace, /aria-label="Connected Fivetran schemas"/u);
  assert.match(workspace, /placeholder="Search schemas or tables"/u);
  assert.match(workspace, /aria-current=\{selected \? "page" : undefined\}/u);
  assert.match(workspace, /Rows per page/u);
  assert.match(workspace, />\s*Previous\s*<\/button>/u);
  assert.match(workspace, />\s*Next\s*<\/button>/u);
  assert.doesNotMatch(
    workspace,
    /SemanticLayerExplorer|SemanticMeasureBuilder|SemanticRelationshipGraph|react-grid-layout|ResponsiveGridLayout/u,
  );
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/u);
});

test("the workspace loads a catalogue and only the selected bounded table page", () => {
  assert.match(workspace, /fetch\("\/api\/my-data",\s*\{[\s\S]*method: "GET"/u);
  assert.match(workspace, /fetch\("\/api\/my-data\/rows",\s*\{[\s\S]*method: "POST"/u);
  assert.match(workspace, /credentials: "same-origin"/g);
  assert.match(workspace, /cache: "no-store"/g);
  assert.match(workspace, /const controller = new AbortController\(\)/g);
  assert.match(workspace, /requestId !== catalogueRequestRef\.current/u);
  assert.match(workspace, /requestId !== rowsRequestRef\.current/u);
  assert.match(workspace, /schemaName: requested\.schemaName,[\s\S]*tableName: requested\.tableName,[\s\S]*offset: requested\.offset,[\s\S]*limit: requested\.limit/u);
  assert.doesNotMatch(workspace, /tenantId|tenant_id/u);
  assert.match(workspace, /const PAGE_SIZES = \[25, 50\] as const/u);
  assert.match(workspace, /rows\.length > value\.limit/u);
  assert.match(workspace, /setOffset\(Math\.max\(0, readyTable\.offset - readyTable\.limit\)\)/u);
  assert.match(workspace, /setOffset\(readyTable\.offset \+ readyTable\.limit\)/u);
});

test("cookie-authenticated routes are private and row reads are same-origin and byte bounded", () => {
  for (const route of [catalogueRoute, rowsRoute]) {
    assert.match(route, /"Cache-Control": "private, no-store"/u);
    assert.match(route, /"X-Content-Type-Options": "nosniff"/u);
    assert.match(route, /ControlPlaneError/u);
  }
  assert.match(catalogueRoute, /export async function GET\(\)/u);
  assert.match(rowsRoute, /export async function POST\(request: Request\)/u);
  assert.match(rowsRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(rowsRoute, /readBoundedJsonBody\(request, 2_048\)/u);
  assert.match(rowsRoute, /fivetranMyDataRowsInputSchema\.safeParse/u);
  assert.doesNotMatch(rowsRoute, /request\.json\(\)/u);

  assert.match(repository, /const \{ supabase \} = await requireUser\(\)/u);
  assert.match(repository, /supabase\.rpc\("begin_albert_fivetran_my_data_request"/u);
  assert.match(repository, /z\.union\(\[z\.literal\(25\), z\.literal\(50\)\]\)/u);
  assert.match(repository, /signFivetranMyDataRequest\(body, operatorDiagnosticSecret\(\)\)/u);
  assert.match(repository, /fetch\(url\.href,\s*\{[\s\S]*method: "POST"/u);
  assert.match(repository, /response.status >= 300 && response.status < 400/u);
  assert.doesNotMatch(repository, /cache: "no-store"/u);
  assert.doesNotMatch(repository, /redirect: "error"/u);
  assert.match(repository, /AbortSignal\.timeout\(10_000\)/u);
  assert.match(repository, /fivetranMyDataResultSchema\.safeParse/u);
  assert.match(repository, /result\.table\.schemaName !== input\.schemaName/u);
  assert.match(repository, /result\.table\.tableName !== input\.tableName/u);
  assert.match(repository, /result\.table\.offset !== input\.offset/u);
  assert.match(repository, /result\.table\.limit !== input\.limit/u);
  assert.doesNotMatch(repository, /tenantId|tenant_id/u);
});

test("the Vercel route never gains a direct analytical database boundary", () => {
  const webSurface = `${catalogueRoute}\n${rowsRoute}\n${repository}\n${workspace}`;
  assert.doesNotMatch(webSurface, /ANALYTICAL_DATABASE_URL|ANALYTICAL_ADMIN_DATABASE_URL/u);
  assert.doesNotMatch(webSurface, /from ["']pg["']|new (?:Pool|Client)\s*\(/u);
  assert.match(environment, /const webForbiddenProductionValues = Object\.freeze\(\[[\s\S]*"ANALYTICAL_DATABASE_URL"/u);
  assert.match(runtimeContract, /"forbiddenRuntimeValues": \[[\s\S]*"ANALYTICAL_DATABASE_URL"/u);
  assert.match(repository, /operatorDiagnosticServiceUrl\(FIVETRAN_MY_DATA_PATH\)/u);
  assert.match(adr, /Vercel web runtime is deliberately forbidden from[\s\S]*analytical database credential/u);
});

test("control-plane authority is active-organisation, Fivetran-only, one-use and append-only", () => {
  assert.match(adr, /Status: Accepted/u);
  assert.match(adr, /lists only Fivetran-managed connections/u);
  assert.match(adr, /Native connector staging, canonical schemas, Cube semantic[\s\S]*outside this surface/u);
  assert.match(adr, /browser never sends\s+a tenant id/u);

  assert.match(controlMigration, /control_plane\.current_connection_admin_membership\(\)/u);
  assert.match(controlMigration, /selected_role NOT IN \('owner', 'manager'\)/u);
  assert.match(controlMigration, /FROM control_plane\.fivetran_connections AS connection/u);
  assert.match(controlMigration, /connection\.status IN \('connected', 'degraded', 'blocked'\)/u);
  assert.match(controlMigration, /connection\.destination_schema = p_schema_name/u);
  assert.doesNotMatch(controlMigration, /FROM control_plane\.connections AS connection/u);
  assert.match(controlMigration, /row_limit integer NOT NULL DEFAULT 25 CHECK \(row_limit BETWEEN 1 AND 50\)/u);
  assert.match(controlMigration, /row_offset integer NOT NULL DEFAULT 0 CHECK \(row_offset BETWEEN 0 AND 10000000\)/u);
  assert.match(controlMigration, /interval '60 seconds'/u);
  assert.match(controlMigration, /requested_at > issued_at - interval '1 minute'[\s\S]*\) >= 30/u);
  assert.match(adr, /requests are limited to 30 per minute/u);
  assert.match(controlMigration, /membership\.user_id = request\.actor_user_id[\s\S]*membership\.role IN \('owner', 'manager'\)[\s\S]*tenant\.status = 'active'/u);
  assert.match(controlMigration, /fivetran_my_data_requests\(request_id\) ON DELETE CASCADE/g);
  assert.match(controlMigration, /TG_OP = 'DELETE' AND control_plane\.deletion_mutation_authorized\(\)/u);
  assert.match(controlMigration, /fivetran_my_data_requests_reject_mutation/u);
  assert.match(controlMigration, /fivetran_my_data_claims \(request_id\)[\s\S]*VALUES \(p_request_id\)/u);
  assert.match(controlMigration, /Fivetran My Data request was already consumed/u);
  assert.match(controlMigration, /complete_fivetran_my_data_request/u);
  assert.match(controlMigration, /sign_analytical_capability\([\s\S]*'analytical:diagnostic'[\s\S]*'fivetran-my-data:' \|\| p_request_id/u);
  assert.match(controlMigration, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role/u);
  assert.match(controlMigration, /NOTIFY pgrst, 'reload schema'/u);
});

test("the analytical migration grants schema discovery only for registered Fivetran destinations", () => {
  assert.match(analyticalMigration, /CREATE OR REPLACE FUNCTION ingestion\.grant_fivetran_schema_reader/u);
  assert.match(analyticalMigration, /FROM ingestion\.fivetran_destination_bindings AS binding[\s\S]*binding\.destination_schema = p_schema/u);
  assert.match(analyticalMigration, /GRANT USAGE ON SCHEMA %I TO diagnostic_ro, transform_rw/u);
  assert.match(analyticalMigration, /PERFORM ingestion\.grant_fivetran_schema_reader\(p_destination_schema\)/u);
  assert.match(analyticalMigration, /WHERE retired_at IS NULL[\s\S]*AND purged_at IS NULL/u);
  assert.doesNotMatch(analyticalMigration, /GRANT SELECT ON ALL TABLES/u);
  assert.doesNotMatch(analyticalMigration, /TO (?:anon|authenticated|service_role)/u);
  assert.match(analyticalMigration, /REVOKE ALL ON FUNCTION ingestion\.grant_fivetran_schema_reader\(text\) FROM PUBLIC/u);
});

test("the native table is accessible, horizontally contained, themed and motion-safe", () => {
  assert.match(workspace, /className=\{styles\.tableViewport\}[\s\S]*tabIndex=\{0\}[\s\S]*aria-label=\{`Scrollable data from/u);
  assert.match(workspace, /<table>/u);
  assert.match(workspace, /<caption className=\{styles\.srOnly\}>/u);
  assert.match(workspace, /<th scope="col"/u);
  assert.match(workspace, /value === null[\s\S]*styles\.nullValue/u);
  assert.match(workspace, /role=\{kind === "error" \? "alert" : kind === "loading" \? "status" : undefined\}/u);
  assert.match(workspace, /aria-busy=\{catalogueLoading \|\| rowsState\.kind === "loading"\}/u);

  assert.match(styles, /\.workspace \{[\s\S]*background: var\(--dash-surface-page\)[\s\S]*color: var\(--dash-text-body\)/u);
  assert.match(styles, /height: var\(--dash-control-height\)/u);
  assert.match(styles, /\.searchField \{[\s\S]*border-radius: 10px/u);
  assert.match(styles, /\.schemaButton \{[\s\S]*border-radius: 8px/u);
  assert.match(styles, /\.tableViewport \{[\s\S]*overflow: auto/u);
  assert.match(styles, /\.tableViewport:focus-visible/u);
  assert.match(styles, /outline: 2px solid var\(--dash-focus\)/u);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none[\s\S]*\.spinner \{[\s\S]*animation: none/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgb\(|color:\s*(?:white|black)|background:\s*(?:white|black)/iu);
});
