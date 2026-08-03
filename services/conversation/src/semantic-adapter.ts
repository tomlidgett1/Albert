import {
  type GovernedResult,
  type SemanticToolResponse,
} from "../../../packages/agent/src/semantic-tools.js";
import {
  sanitizeTraceText,
  type TraceCell,
  type TraceProvenance,
  type TraceTableColumn,
} from "../../../packages/shared/src/index.js";

export function adaptGovernedResult(response: SemanticToolResponse): GovernedResult {
  if (!response.resultId || !response.data || !response.provenance.timeRange) {
    throw new Error("The semantic service returned no governed table payload for this query.");
  }
  const rows = response.data.rows.map((row) => Object.fromEntries(
    response.data?.columns.map((column) => [column, traceCell(row[column])]) ?? [],
  ));
  const resultWindow = response.data.resultWindow;
  const filterRefs = response.data.filterRefs;
  if (filterRefs && (
    filterRefs.length !== rows.length
    || filterRefs.some((row) => Object.keys(row).some((key) => !response.data?.columns.includes(key)))
  )) {
    throw new Error("The semantic service returned invalid row filter references.");
  }
  if (resultWindow && (
    rows.length > resultWindow.requestedLimit
    || resultWindow.orderBy.some((item) => !response.data?.columns.includes(item.columnKey))
  )) {
    throw new Error("The semantic service returned an invalid governed result-window proof.");
  }
  return {
    resultId: response.resultId,
    columns: response.data.columns.map((column) => columnMetadata(column, response, rows)),
    rows,
    ...(filterRefs ? { filterRefs: filterRefs.map((row) => ({ ...row })) } : {}),
    ...(resultWindow ? {
      resultWindow: {
        requestedLimit: resultWindow.requestedLimit,
        orderedBeforeLimit: true,
        orderBy: resultWindow.orderBy.map((item) => ({ ...item })),
      },
    } : {}),
    provenance: adaptTraceProvenance(response),
    validations: adaptValidations(response),
  };
}

export function adaptTraceProvenance(response: SemanticToolResponse): TraceProvenance {
  const timeRange = response.provenance.timeRange;
  if (!timeRange) throw new Error("Governed query provenance is missing its resolved time range.");
  const sourceDetails = response.provenance.sourceDetails.length
    ? response.provenance.sourceDetails
    : inferSourceDetails(response);
  return {
    sources: sourceDetails.flatMap((source) => {
      const connector = traceConnector(source.connectorId);
      return connector ? [{
        connector,
        label: sanitizeTraceText(source.label, 120) || connector,
        dataThrough: source.dataThrough,
      }] : [];
    }),
    timeRange: { ...timeRange, label: sanitizeTraceText(timeRange.label, 200) },
    definitions: response.provenance.definitionDetails.map((definition) => ({
      metric: definition.id,
      label: sanitizeTraceText(definition.label, 160),
      definition: sanitizeTraceText(definition.definition, 500),
    })),
    semanticBundleHash: response.provenance.bundleHash,
    identityGraph: { ...response.provenance.identityGraph },
  };
}

export function adaptValidations(response: SemanticToolResponse): GovernedResult["validations"] {
  const checks = response.validation.checks.map((check, index) => {
    const status = typeof check.status === "string" ? check.status : response.validation.status;
    const name = typeof check.checkId === "string"
      ? check.checkId
      : typeof check.name === "string" ? check.name : `validation_${index + 1}`;
    const details = check.details && typeof check.details === "object"
      ? ` ${JSON.stringify(check.details)}`
      : "";
    return {
      name: sanitizeTraceText(name, 120),
      outcome: validationOutcome(status),
      detail: sanitizeTraceText(`${humanize(name)}: ${status}.${details}`, 500),
    } as const;
  });
  const warnings = response.validation.warnings.map((warning, index) => ({
    name: `warning_${index + 1}`,
    outcome: "qualified" as const,
    detail: sanitizeTraceText(warning, 500),
  }));
  if (checks.length || warnings.length) return [...checks, ...warnings];
  return [{
    name: "governed_validation",
    outcome: validationOutcome(response.validation.status),
    detail: `Governed validation ${response.validation.status}.`,
  }];
}

export function requireCatalogue(response: SemanticToolResponse): NonNullable<SemanticToolResponse["catalogue"]> {
  if (!response.catalogue) throw new Error("Catalogue response is missing its catalogue payload.");
  return response.catalogue;
}

export function requireDefinition(response: SemanticToolResponse): Readonly<{ definition: unknown }> {
  if (response.definition === undefined) throw new Error("Definition response is missing its definition payload.");
  return { definition: response.definition };
}

export function requireCapabilities(response: SemanticToolResponse): NonNullable<SemanticToolResponse["capabilities"]> {
  if (!response.capabilities) throw new Error("Capability response is missing its capability payload.");
  return response.capabilities;
}

export function requireFieldValues(response: SemanticToolResponse): NonNullable<SemanticToolResponse["fieldValues"]> {
  if (!response.fieldValues) throw new Error("Field-value response is missing its values payload.");
  return response.fieldValues;
}

export function requireDataHealth(response: SemanticToolResponse): NonNullable<SemanticToolResponse["dataHealth"]> {
  if (!response.dataHealth) throw new Error("Data-health response is missing its health payload.");
  return response.dataHealth;
}

export function requireRememberedPreference(response: SemanticToolResponse): NonNullable<SemanticToolResponse["rememberedPreference"]> {
  if (!response.rememberedPreference) throw new Error("Remember response is missing its overlay publication payload.");
  return response.rememberedPreference;
}

function columnMetadata(
  key: string,
  response: SemanticToolResponse,
  rows: readonly Readonly<Record<string, TraceCell>>[],
): TraceTableColumn {
  const definition = response.provenance.definitionDetails.find((item) =>
    item.id === key || item.id.endsWith(`.${key}`),
  );
  const type = inferColumnType(key, rows);
  const currency = type === "currency" ? validatedCurrency(key, response.validation.checks) : undefined;
  return {
    key,
    label: sanitizeTraceText(definition?.label ?? humanize(key), 120),
    type,
    ...(currency ? { currency } : {}),
  };
}

function validatedCurrency(
  key: string,
  checks: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  const check = checks.find((candidate) => candidate.checkId === `slice_single_currency:${key}`);
  if (!check || !Array.isArray(check.currencies) || check.currencies.length !== 1) return undefined;
  const currency = check.currencies[0];
  if (typeof currency !== "string") return undefined;
  const normalized = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

function inferColumnType(key: string, rows: readonly Readonly<Record<string, TraceCell>>[]): TraceTableColumn["type"] {
  const normalized = key.toLowerCase();
  if (normalized.endsWith("_at") || normalized.includes("timestamp")) return "datetime";
  if (normalized.includes("date") || normalized === "calendar_week") return "date";
  if (normalized.includes("pct") || normalized.includes("percent") || normalized.endsWith("_rate")) return "percent";
  if (/amount|sales|revenue|cost|profit|margin|value|receipt|receivable|payable|gst/.test(normalized)) return "currency";
  const values = rows.map((row) => row[key]).filter((value) => value !== null);
  if (values.length && values.every((value) => typeof value === "number" || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)))) return "number";
  return "string";
}

function traceCell(value: unknown): TraceCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return sanitizeTraceText(value, 2_000);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  return sanitizeTraceText(JSON.stringify(value), 2_000);
}

function validationOutcome(value: string): "passed" | "qualified" | "failed" {
  if (value === "passed") return "passed";
  if (value === "warning" || value === "qualified") return "qualified";
  return "failed";
}

function inferSourceDetails(response: SemanticToolResponse): SemanticToolResponse["provenance"]["sourceDetails"] {
  const dataThrough = Object.values(response.provenance.sourceWatermarks)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    ?? response.provenance.timeRange?.end
    ?? "unavailable";
  const connectors = new Set(response.provenance.sources.map(connectorForSource));
  return [...connectors].map((connectorId) => ({
    connectorId,
    connectionId: connectorId,
    label: humanize(connectorId),
    dataThrough,
  }));
}

function connectorForSource(source: string): string {
  const normalized = source.toLowerCase();
  if (normalized.includes("finance") || normalized.includes("xero")) return "xero";
  if (normalized.includes("workforce") || normalized.includes("deputy")) return "deputy";
  return "lightspeed";
}

function traceConnector(value: string): "lightspeed" | "xero" | "deputy" | undefined {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("lightspeed")) return "lightspeed";
  if (normalized.startsWith("xero")) return "xero";
  if (normalized.startsWith("deputy")) return "deputy";
  return undefined;
}

function humanize(value: string): string {
  return value.replaceAll(".", " ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
