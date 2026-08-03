import { createHash } from "node:crypto";
import type { GovernedSourceCatalogueField } from "../../connector-sdk/src/index.js";
import type { RegistryDocument } from "./schema.js";

export type CatalogueDocumentKind = "topic" | "metric" | "field" | "source_field";

export type RegistryCatalogueDocument = Readonly<{
  id: string;
  kind: CatalogueDocumentKind;
  title: string;
  content: string;
  contentHash: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export function createRegistryCatalogueDocuments(
  document: RegistryDocument,
): readonly RegistryCatalogueDocument[] {
  const topics = document.topics.map((topic) => catalogueDocument({
    id: `topic:${topic.id}`,
    kind: "topic",
    title: topic.label,
    content: [
      topic.id,
      topic.label,
      topic.description,
      topic.aiContext,
      ...topic.sampleQuestions,
      ...topic.metrics,
      ...topic.approvedDimensions,
    ].join("\n"),
    metadata: {
      semanticId: topic.id,
      roles: [...topic.roles],
      metrics: [...topic.metrics],
      requiredCapabilities: [...topic.requiredCapabilities],
    },
  }));
  const metrics = document.metrics.map((metric) => catalogueDocument({
    id: `metric:${metric.id}`,
    kind: "metric",
    title: metric.label,
    content: [
      metric.id,
      metric.label,
      ...metric.synonyms,
      metric.description,
      metric.aiContext,
      metric.unit,
      metric.authority,
      ...metric.allowedDimensions,
    ].join("\n"),
    metadata: {
      semanticId: metric.id,
      unit: metric.unit,
      authority: metric.authority,
      requiredCapabilities: [...metric.requiredCapabilities],
    },
  }));
  const fields = [...new Set(document.topics.flatMap((topic) => topic.approvedDimensions))]
    .sort()
    .map((field) => {
      const topicsForField = document.topics.filter((topic) => topic.approvedDimensions.includes(field));
      return catalogueDocument({
        id: `field:${field}`,
        kind: "field",
        title: humanize(field),
        content: [
          field,
          humanize(field),
          "Governed semantic dimension",
          ...topicsForField.flatMap((topic) => [topic.id,topic.label,topic.description]),
        ].join("\n"),
        metadata: {
          semanticId: field,
          topics: topicsForField.map((topic) => topic.id),
          roles: [...new Set(topicsForField.flatMap((topic) => topic.roles))].sort(),
        },
      });
    });
  return Object.freeze([...topics, ...metrics, ...fields].sort((left,right) => left.id.localeCompare(right.id)));
}

export function createSourceFieldCatalogueDocuments(
  fields: readonly GovernedSourceCatalogueField[],
): readonly RegistryCatalogueDocument[] {
  return Object.freeze(fields.map((field) => {
    const semanticId = `source_field:${field.connectorId}:${field.sourceTable}:${field.sourceColumn}`;
    const aliases = field.vendorAliases.length
      ? `Vendor aliases with distinct physical columns: ${field.vendorAliases.join(", ")}. Do not assume equivalence without vendor semantics.`
      : "";
    return catalogueDocument({
      id: semanticId,
      kind: "source_field",
      title: `${field.connectorLabel} · ${humanize(field.stream)} · ${humanize(field.sourceField)}`,
      content: [
        semanticId,
        field.connectorLabel,
        field.connectorId,
        field.stream,
        humanize(field.stream),
        field.sourceField,
        field.sourceColumn,
        humanize(field.sourceField),
        field.target,
        `Governed source-specific extension with ${field.stagingType} values.`,
        aliases,
      ].join("\n"),
      metadata: {
        semanticId,
        connectorId: field.connectorId,
        sourceTable: field.sourceTable,
        sourceField: field.sourceColumn,
        vendorField: field.sourceField,
        target: field.target,
        stagingType: field.stagingType,
        pii: field.pii,
        queryable: field.queryable,
        packVersion: field.packVersion,
        vendorAliases: [...field.vendorAliases],
      },
    });
  }).sort((left,right) => left.id.localeCompare(right.id)));
}

export function combineCatalogueDocuments(
  ...groups: readonly (readonly RegistryCatalogueDocument[])[]
): readonly RegistryCatalogueDocument[] {
  const documents = groups.flat().sort((left,right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) throw new Error(`Duplicate catalogue document ${document.id}.`);
    ids.add(document.id);
  }
  return Object.freeze(documents);
}

function catalogueDocument(
  input: Omit<RegistryCatalogueDocument,"contentHash">,
): RegistryCatalogueDocument {
  const normalizedContent = input.content.replaceAll(/\s+/gu," ").trim();
  return Object.freeze({
    ...input,
    content: normalizedContent,
    metadata: Object.freeze({ ...input.metadata }),
    contentHash: createHash("sha256").update(normalizedContent).digest("hex"),
  });
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu,"$1 $2")
    .replaceAll(/[._-]+/gu," ")
    .replace(/\b\w/gu,(letter) => letter.toUpperCase());
}
