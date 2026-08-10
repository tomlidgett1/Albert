import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  semanticProfileReceiptDigestV2,
  verifySemanticProfileReceiptAttestationV2,
} from "../packages/semantic-registry/src/profile-receipt-attestation.js";
import { semanticRegistryDocumentV2Schema } from "../packages/semantic-registry/src/v2.js";
import {
  planSemanticRelationshipResolutionsV2,
  summarizeSemanticRelationshipResolutionsV2,
  type RelationshipProfileReceiptV2,
} from "./lib/semantic-v2-relationship-resolution.js";

function argument(name: string): string | undefined {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();
}

try {
  process.loadEnvFile?.(".env.local");
} catch {
  /* Explicit process environment remains authoritative. */
}

const receiptPath = argument("receipt");
if (!receiptPath)
  throw new Error("--receipt=<profile receipt path> is required.");
const secret = process.env.ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET?.trim();
if (!secret || secret.length < 32)
  throw new Error(
    "ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET must contain at least 32 characters so the receipt can be authenticated.",
  );
const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
const receipt = JSON.parse(
  readFileSync(resolve(receiptPath), "utf8"),
) as RelationshipProfileReceiptV2 & {
  attestation: {
    algorithm: "hmac-sha256";
    keyPurpose: "semantic-profile-v2";
    signature: string;
  };
};
if (!verifySemanticProfileReceiptAttestationV2(receipt, secret))
  throw new Error("The semantic profile receipt attestation is invalid.");
const publication = JSON.parse(
  readFileSync(
    "packages/semantic-registry/registry/publication.v2.json",
    "utf8",
  ),
) as { publicationHash: string };
if (receipt.publicationHash !== publication.publicationHash)
  throw new Error(
    "The profile receipt belongs to a different semantic publication.",
  );

const resolutions = planSemanticRelationshipResolutionsV2(registry, receipt);
const receiptHash = semanticProfileReceiptDigestV2(receipt);
const report = {
  schemaVersion: 1,
  publicationHash: publication.publicationHash,
  profileReceiptHash: receiptHash,
  generatedAt: new Date().toISOString(),
  warning:
    "This report proposes review work only. It never mutates a draft or authorizes a join; every promotion or rejection remains an explicit admin decision.",
  summary: summarizeSemanticRelationshipResolutionsV2(resolutions),
  resolutions,
};
const outputPath = resolve(
  argument("output") ??
    `.albert-agent-qa-out/semantic-profiling/resolution-${receiptHash}.json`,
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
});
process.stdout.write(
  `${JSON.stringify({ outputPath, profileReceiptHash: receiptHash, summary: report.summary }, null, 2)}\n`,
);
