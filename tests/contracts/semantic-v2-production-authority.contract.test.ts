import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [workflow, verifier, contract, adr] = await Promise.all([
  readFile(new URL(".github/workflows/semantic-v2-production.yml", root), "utf8"),
  readFile(new URL("scripts/verify-semantic-v2-production.mjs", root), "utf8"),
  readFile(new URL("deploy/runtime-contract.json", root), "utf8"),
  readFile(new URL("docs/adr/0078-vercel-and-v2-release-authority.md", root), "utf8"),
]);

test("V2 production verification is protected, exact-candidate, and non-mutating", () => {
  assert.match(workflow, /workflow_dispatch:[\s\S]*candidate_sha:[\s\S]*publication_hash:/u);
  assert.match(workflow, /environment:\s*production/u);
  assert.match(workflow, /github\.run_attempt == 1/u);
  assert.match(workflow, /git\/ref\/heads\/main/u);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /assert-semantic-v2-production-authority\.mjs/u);
  assert.match(workflow, /ALBERT_RELEASE_AUTHORITY_SIGNER_EMAIL/u);
  assert.match(workflow, /ALBERT_ANALYTICAL_PROJECT_REF/u);
  assert.match(workflow, /verify-semantic-v2-production\.mjs/u);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{ inputs\.candidate_sha \}\}/u);
  assert.doesNotMatch(workflow, /working-directory:\s*candidate/u);
  assert.doesNotMatch(workflow, /activate_publication|rollback_publication|vercel --prod/iu);
  assert.doesNotMatch(`${workflow}\n${verifier}`, /DEPUTY/u);
});

test("production verifier requires active qualification, exact Luna Max, and Vercel/Fly readiness", () => {
  assert.match(verifier, /semantic_v2_activation_qualifications/u);
  assert.match(verifier, /active_publication_hash/u);
  assert.match(verifier, /gpt-5\.6-luna/u);
  assert.match(verifier, /reasoningEffort, "max"/u);
  assert.match(verifier, /fastMode, false/u);
  assert.match(verifier, /proMode, false/u);
  assert.match(verifier, /caseCount, 200/u);
  assert.match(verifier, /deterministic\?\.analyticalProjectRef/u);
  assert.match(verifier, /ALBERT_ANALYTICAL_PROJECT_REF/u);
  assert.match(verifier, /analyticalRuntime, "v2"/u);
  assert.match(verifier, /v2PublicationHash/u);
  assert.match(verifier, /collectVercelPlatformProvenance/u);
});

test("active web deployment contract is Vercel and legacy Sites evidence is V1-only", () => {
  const parsed = JSON.parse(contract);
  assert.equal(parsed.runtimes.web.platform, "vercel");
  assert.equal(parsed.runtimes.web.manifest, "vercel.json");
  assert.match(adr, /ChatGPT Sites.*not V2 launch evidence/is);
  assert.match(adr, /Deputy.*not V2 launch evidence/is);
});
