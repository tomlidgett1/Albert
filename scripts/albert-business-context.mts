/**
 * Business context CLI: generate (and optionally store) the business context
 * document for a tenant from its connected data.
 *
 *   npx tsx scripts/albert-business-context.mts --generate [--out evals/albert/context/<slug>.json] [--print]
 *   npx tsx scripts/albert-business-context.mts --generate --save          # also writes to the control plane
 *   npx tsx scripts/albert-business-context.mts --show                     # prints the stored document
 *
 * Cube queries need a running turn lease: the CLI uses the eval harness's
 * lease list (EVAL_LEASES="conv:turn;…" overrides). Tenant/actor come from
 * scripts/albert-eval/lib.ts (Ashburton Cycles by default) or --tenant/--actor.
 */
import fs from "node:fs";
import path from "node:path";
import { Runner } from "@openai/agents";
import { loadEnv, LEASES, TENANT_ID, ACTIVE_CONNECTORS, SOURCE_FINDINGS } from "./albert-eval/lib.js";
import { loadAgentConfig } from "../packages/albert-v3/src/agent-config/loader.js";
import { collectBusinessFacts, generateBusinessContext, renderBusinessContext, renderBusinessContextForClassifier, businessContextWordCount, businessContextDocumentSchema, type BusinessContextDocument, type BusinessContextSection } from "../packages/albert-v3/src/context-layer/index.js";
import { deriveConnectorFreshness } from "../packages/albert-v3/src/engine/freshness.js";
import { CubeClient } from "../packages/albert-v3/src/cube/client.js";
import { normalizeV3Connector } from "../packages/albert-v3/src/engine/connector-routing.js";

const args = new Set(process.argv.slice(2));
const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const env = loadEnv();
const tenantId = argValue("--tenant") ?? TENANT_ID;
const connectors = (argValue("--connectors") ?? ACTIVE_CONNECTORS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const outFile = argValue("--out") ?? path.join("evals", "albert", "context", `${tenantId.toLowerCase()}.json`);
const config = loadAgentConfig();

async function generate(): Promise<void> {
  const lease = LEASES[LEASES.length - 1]!;
  const cube = new CubeClient({
    apiUrl: env.CUBE_API_URL!,
    apiSecret: env.CUBEJS_API_SECRET!,
    securityContext: { tenant_id: tenantId, conversation_id: lease.conversationId, turn_id: lease.turnId },
  });
  const started = Date.now();
  console.log(`[context] collecting facts for ${tenantId} (${connectors.join(", ")}) …`);
  const freshness = await deriveConnectorFreshness({ cube, tenantId, probes: config.freshnessProbes, activeConnectors: connectors.map((key) => normalizeV3Connector(key) ?? key), known: [] }).catch(() => []);
  const facts = await collectBusinessFacts({ cube, config, connectorKeys: connectors, freshness });
  for (const probe of facts.probes) console.log(`  ${probe.ok ? "ok " : "ERR"} ${probe.key.padEnd(28)} ${String(probe.rowCount).padStart(4)} rows ${probe.executionMs}ms${probe.error ? ` — ${probe.error.slice(0, 100)}` : ""}`);
  console.log(`[context] facts in ${Math.round((Date.now() - started) / 1000)}s; generating …`);
  let existing: { document: BusinessContextDocument; ownerLocked: BusinessContextSection[] } | undefined;
  if (fs.existsSync(outFile) && !args.has("--fresh")) {
    try {
      const prior = JSON.parse(fs.readFileSync(outFile, "utf8")) as { document: unknown; ownerLocked?: BusinessContextSection[] };
      existing = { document: businessContextDocumentSchema.parse(prior.document), ownerLocked: prior.ownerLocked ?? [] };
    } catch { existing = undefined; }
  }
  const generated = await generateBusinessContext({
    facts, config, existing,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "medium", fastMode: false },
    runner: new Runner(),
    cachePartition: `cli-${tenantId}`,
    sourceFindings: SOURCE_FINDINGS,
  });
  const words = businessContextWordCount(generated.document);
  console.log(`[context] generated in ${Math.round((Date.now() - started) / 1000)}s — ${words} words rendered (model ${generated.model}, generator ${generated.generatorVersion})`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const record = {
    tenantId, connectors, generatedAt: new Date().toISOString(), generatorVersion: generated.generatorVersion, model: generated.model,
    ownerLocked: existing?.ownerLocked ?? [], document: generated.document, rendered: generated.rendered, classifierBlock: renderBusinessContextForClassifier(generated.document),
    facts,
  };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  fs.writeFileSync(outFile.replace(/\.json$/u, ".md"), `${generated.rendered}\n\n---\n\n${renderBusinessContextForClassifier(generated.document)}\n`);
  console.log(`[context] wrote ${outFile} and ${outFile.replace(/\.json$/u, ".md")}`);
  if (args.has("--print")) console.log(`\n${generated.rendered}\n\n${renderBusinessContextForClassifier(generated.document)}`);
  if (args.has("--save")) await save(record);
}

async function save(record: { document: BusinessContextDocument; rendered: string; facts: unknown; ownerLocked: BusinessContextSection[]; generatorVersion: string; model: string; connectors: string[] }): Promise<void> {
  const { saveBusinessContextAsService } = await import("../services/control-plane/src/business-context-repository.js");
  await saveBusinessContextAsService({
    tenantId,
    document: record.document,
    rendered: record.rendered,
    facts: record.facts,
    source: "generated",
    ownerLocked: record.ownerLocked,
    generatorVersion: record.generatorVersion,
    model: record.model,
    dataThrough: null,
    connectors: record.connectors,
  });
  console.log(`[context] saved to the control plane for ${tenantId}`);
}

if (args.has("--generate")) await generate();
else if (args.has("--show")) {
  const { loadBusinessContextAsService } = await import("../services/control-plane/src/business-context-repository.js");
  const stored = await loadBusinessContextAsService(tenantId);
  console.log(stored ? `${stored.status} · generated ${stored.generatedAt} · ${stored.connectors.join(",")}\n\n${stored.rendered}` : "no business context stored");
} else if (args.has("--resave")) {
  // Re-render the stored JSON with the current renderer and write it to the control plane (no data collection).
  const record = JSON.parse(fs.readFileSync(outFile, "utf8")) as { document: unknown; facts?: unknown; ownerLocked?: BusinessContextSection[]; generatorVersion?: string; model?: string; connectors?: string[] };
  const document = businessContextDocumentSchema.parse(record.document);
  const rendered = renderBusinessContext(document);
  fs.writeFileSync(outFile, JSON.stringify({ ...record, rendered, classifierBlock: renderBusinessContextForClassifier(document) }, null, 2));
  fs.writeFileSync(outFile.replace(/\.json$/u, ".md"), `${rendered}\n\n---\n\n${renderBusinessContextForClassifier(document)}\n`);
  await save({ document, rendered, facts: record.facts, ownerLocked: record.ownerLocked ?? [], generatorVersion: record.generatorVersion ?? "", model: record.model ?? "", connectors: record.connectors ?? connectors });
} else if (args.has("--render")) {
  const record = JSON.parse(fs.readFileSync(outFile, "utf8")) as { document: unknown };
  const document = businessContextDocumentSchema.parse(record.document);
  console.log(renderBusinessContext(document));
  console.log(`\n(${businessContextWordCount(document)} words)\n\n${renderBusinessContextForClassifier(document)}`);
} else {
  console.log("usage: --generate [--save] [--print] [--fresh] | --show | --render");
}
