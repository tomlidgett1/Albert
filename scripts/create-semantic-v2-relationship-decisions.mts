import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  semanticProfileReceiptDigestV2,
  verifySemanticProfileReceiptAttestationV2,
} from "../packages/semantic-registry/src/profile-receipt-attestation.js";
import {
  createSemanticPublicationV2,
  semanticRegistryDocumentV2Schema,
} from "../packages/semantic-registry/src/v2.js";
import {
  planSemanticRelationshipResolutionsV2,
  type RelationshipProfileReceiptV2,
} from "./lib/semantic-v2-relationship-resolution.js";

if (
  !process.argv.includes("--execute") ||
  !process.argv.includes("--confirm-reviewed=414")
)
  throw new Error(
    "Refusing to write launch relationship decisions without --execute --confirm-reviewed=414.",
  );

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
const signingSecret =
  process.env.ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET?.trim();
if (!signingSecret || signingSecret.length < 32)
  throw new Error(
    "ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET is required to authenticate the profile receipt.",
  );
const receiptPath = argument("receipt");
if (!receiptPath) throw new Error("--receipt=<signed profile receipt> is required.");
const outputPath = resolve(
  argument("output") ??
    "packages/semantic-registry/registry/relationship-decisions.v2.json",
);
const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
if (
  registry.relationships.length > 0 ||
  registry.relationshipCandidates.some(
    ({ disposition }) => disposition !== "unresolved",
  )
)
  throw new Error(
    "Relationship decisions must be generated from the unresolved base publication.",
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
if (
  receipt.status !== "complete" ||
  receipt.errors.length > 0 ||
  !verifySemanticProfileReceiptAttestationV2(receipt, signingSecret)
)
  throw new Error(
    "The relationship profile receipt is incomplete or failed authentication.",
  );
const basePublicationHash = createSemanticPublicationV2(registry).publicationHash;
if (receipt.publicationHash !== basePublicationHash)
  throw new Error(
    "The relationship profile receipt does not belong to the unresolved base publication.",
  );
const receiptHash = semanticProfileReceiptDigestV2(receipt);
const certifiedSourceObjectIds = receipt.sourceProfiles
  .filter(
    (profile) =>
      Number.isInteger(profile.rowCount) &&
      profile.rowCount >= 0 &&
      Number.isInteger(profile.sampledRows) &&
      profile.sampledRows >= 0 &&
      profile.missingColumns.length === 0 &&
      profile.typeMismatches.length === 0 &&
      !receipt.errors.some(({ objectId }) => objectId === profile.sourceObjectId),
  )
  .map(({ sourceObjectId }) => sourceObjectId)
  .sort();
if (
  certifiedSourceObjectIds.length !== registry.sourceObjects.length ||
  registry.sourceObjects.some(({ id }) => !certifiedSourceObjectIds.includes(id))
)
  throw new Error(
    "Structural source certification requires one complete, schema-clean live profile for every source object.",
  );
const resolutions = planSemanticRelationshipResolutionsV2(registry, receipt);
const resolutionByCandidate = new Map(
  resolutions.map((resolution) => [resolution.candidateId, resolution]),
);
const profileByCandidate = new Map(
  receipt.relationshipProfiles.map((profile) => [profile.candidateId, profile]),
);

const explicitTargetByCandidate = new Map<string, string>([
  [
    "candidate.lightspeed.ls_sales.tax_category_id",
    "source.lightspeed.ls_tax_categories",
  ],
  [
    "candidate.lightspeed.ls_shops.tax_category_id",
    "source.lightspeed.ls_tax_categories",
  ],
  [
    "candidate.xero.xero_bank_transactions.contact_contact_id",
    "source.xero.xero_contacts",
  ],
  [
    "candidate.xero.xero_credit_notes.contact_contact_id",
    "source.xero.xero_contacts",
  ],
  [
    "candidate.xero.xero_invoice_line_items.invoice_id",
    "source.xero.xero_invoices",
  ],
  [
    "candidate.xero.xero_invoices.contact_contact_id",
    "source.xero.xero_contacts",
  ],
  [
    "candidate.xero.xero_overpayments.contact_contact_id",
    "source.xero.xero_contacts",
  ],
  [
    "candidate.xero.xero_repeating_invoices.contact_contact_id",
    "source.xero.xero_contacts",
  ],
]);

function safeProfile(target: {
  sampledForeignKeys: number;
  orphanRows: number;
  maximumTargetMatches: number;
  ambiguousRows: number;
  duplicateTargetKeyGroups: number;
  recommendedCardinality: string;
  recommendedDisposition: string;
}): boolean {
  return (
    target.sampledForeignKeys > target.orphanRows &&
    target.maximumTargetMatches === 1 &&
    target.ambiguousRows === 0 &&
    target.duplicateTargetKeyGroups === 0 &&
    target.recommendedCardinality === "many_to_one" &&
    target.recommendedDisposition === "review_candidate"
  );
}

const corePriority = [
  "candidate.lightspeed.ls_sale_lines.sale_id",
  "candidate.lightspeed.ls_sale_lines.item_id",
  "candidate.lightspeed.ls_sales.shop_id",
  "candidate.lightspeed.ls_sales.customer_id",
  "candidate.lightspeed.ls_sales.employee_id",
  "candidate.lightspeed.ls_sale_payments.sale_id",
  "candidate.lightspeed.ls_sale_payments.payment_type_id",
  "candidate.xero.xero_invoice_line_items.invoice_id",
  "candidate.xero.xero_invoices.contact_contact_id",
  "candidate.xero.xero_bank_transactions.contact_contact_id",
  "candidate.xero.xero_credit_notes.contact_contact_id",
  "candidate.xero.xero_overpayments.contact_contact_id",
] as const;
const priorityIndex = new Map<string, number>(
  corePriority.map((candidateId, index) => [candidateId, index]),
);

type PromotionProposal = Readonly<{
  candidateId: string;
  fromViewId: string;
  targetViewId: string;
  targetFieldId: string;
  optional: boolean;
  matchedKeys: number;
  sampledForeignKeys: number;
}>;
const proposals: PromotionProposal[] = [];
for (const candidate of registry.relationshipCandidates) {
  const resolution = resolutionByCandidate.get(candidate.id)!;
  const profile = profileByCandidate.get(candidate.id);
  let targetViewId = resolution.proposal?.targetViewId;
  if (resolution.status === "ambiguous_targets")
    targetViewId = explicitTargetByCandidate.get(candidate.id);
  if (!targetViewId) continue;
  const target = profile?.targets.find(
    (entry) => entry.targetViewId === targetViewId && safeProfile(entry),
  );
  const declared = candidate.targets.find(
    ({ viewId }) => viewId === targetViewId,
  );
  if (!target || !declared) continue;
  proposals.push({
    candidateId: candidate.id,
    fromViewId: candidate.fromViewId,
    targetViewId,
    targetFieldId: declared.fieldId,
    optional:
      !target.profileCoverageComplete ||
      target.nullForeignKeys > 0 ||
      target.orphanRows > 0,
    matchedKeys: target.sampledForeignKeys - target.orphanRows,
    sampledForeignKeys: target.sampledForeignKeys,
  });
}
const unknownAmbiguities = resolutions.filter(
  ({ status, candidateId }) =>
    status === "ambiguous_targets" &&
    !explicitTargetByCandidate.has(candidateId),
);
if (unknownAmbiguities.length > 0)
  throw new Error(
    `Domain review has no explicit target for: ${unknownAmbiguities
      .map(({ candidateId }) => candidateId)
      .join(", ")}.`,
  );

class UnionFind {
  private readonly parent = new Map<string, string>();

  private root(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) {
      this.parent.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = this.root(parent);
    this.parent.set(value, root);
    return root;
  }

  connect(left: string, right: string): boolean {
    const leftRoot = this.root(left);
    const rightRoot = this.root(right);
    if (leftRoot === rightRoot) return false;
    this.parent.set(rightRoot, leftRoot);
    return true;
  }
}

const sortedProposals = [...proposals].sort((left, right) => {
  const leftPriority = priorityIndex.get(left.candidateId);
  const rightPriority = priorityIndex.get(right.candidateId);
  if (leftPriority !== undefined || rightPriority !== undefined)
    return (
      (leftPriority ?? Number.MAX_SAFE_INTEGER) -
      (rightPriority ?? Number.MAX_SAFE_INTEGER)
    );
  const leftCoverage = left.matchedKeys / left.sampledForeignKeys;
  const rightCoverage = right.matchedKeys / right.sampledForeignKeys;
  return (
    rightCoverage - leftCoverage ||
    right.matchedKeys - left.matchedKeys ||
    left.candidateId.localeCompare(right.candidateId)
  );
});
const forest = new UnionFind();
const selected = new Map<string, PromotionProposal>();
for (const proposal of sortedProposals)
  if (forest.connect(proposal.fromViewId, proposal.targetViewId))
    selected.set(proposal.candidateId, proposal);

const decisions = registry.relationshipCandidates.map((candidate) => {
  const proposal = selected.get(candidate.id);
  const resolution = resolutionByCandidate.get(candidate.id)!;
  if (proposal) {
    const topicIds = registry.topics
      .filter(
        ({ viewIds }) =>
          viewIds.includes(proposal.fromViewId) &&
          viewIds.includes(proposal.targetViewId),
      )
      .map(({ id }) => id)
      .sort();
    return {
      candidateId: candidate.id,
      disposition: "promote" as const,
      targetViewId: proposal.targetViewId,
      targetFieldId: proposal.targetFieldId,
      optional: proposal.optional,
      temporalBehavior: "not_applicable" as const,
      topicIds,
      reason: `Launch review selected the unique domain-correct many-to-one path with ${proposal.matchedKeys} matched keys from ${proposal.sampledForeignKeys} sampled non-null keys. The edge is Verified and is exposed only in Topics containing both views.`,
    };
  }
  const wasSafeButCyclic = proposals.some(
    ({ candidateId }) => candidateId === candidate.id,
  );
  const reason = wasSafeButCyclic
    ? "Launch review rejected this otherwise profile-safe candidate because it would create a second semantic path between already connected views. The source field remains discoverable, but this redundant join is unsupported to preserve deterministic path selection."
    : resolution.status === "no_profiled_data"
      ? "Launch review leaves this relationship unsupported because the qualification tenant contained no non-null source keys. Sparse data is not treated as evidence that a reusable join is safe."
      : resolution.status === "no_profiled_match"
        ? "Launch review leaves this relationship unsupported because none of the observed non-null source keys matched a declared governed target."
        : resolution.status === "no_declared_target"
          ? "Launch review leaves this identifier unsupported because the governed source contract declares no domain-correct target key."
          : resolution.status === "ambiguous_targets"
            ? "Launch review leaves this relationship unsupported because multiple structurally safe targets remained after domain-target selection."
            : resolution.status === "unsafe_multiplicity"
              ? "Launch review rejects this relationship because observed target multiplicity is not safe for a deterministic many-to-one join."
              : "Launch review leaves this relationship unsupported because complete, authenticated profile evidence did not prove a unique reusable join.";
  return {
    candidateId: candidate.id,
    disposition: "reject" as const,
    reason,
  };
});

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
const unsigned = {
  schemaVersion: 1 as const,
  basePublicationHash,
  profileReceiptHash: receiptHash,
  certifiedSourceObjectIds,
  decisions,
};
const reviewDigest = createHash("sha256")
  .update("albert-semantic-v2-relationship-review\0")
  .update(JSON.stringify(canonical(unsigned)))
  .digest("hex");
const manifest = { ...unsigned, reviewDigest };
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
});
process.stdout.write(
  `${JSON.stringify(
    {
      outputPath,
      basePublicationHash,
      profileReceiptHash: receiptHash,
      reviewDigest,
      certifiedSources: certifiedSourceObjectIds.length,
      promoted: decisions.filter(({ disposition }) => disposition === "promote")
        .length,
      rejected: decisions.filter(({ disposition }) => disposition === "reject")
        .length,
      exposedTopicEdges: decisions.reduce(
        (total, decision) =>
          total + (decision.disposition === "promote" ? decision.topicIds.length : 0),
        0,
      ),
    },
    null,
    2,
  )}\n`,
);
