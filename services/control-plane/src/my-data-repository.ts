import { ulid } from "ulid";
import { z } from "zod";

import {
  FIVETRAN_MY_DATA_PATH,
  signFivetranMyDataRequest,
} from "../../operator-diagnostic/src/http.js";
import {
  fivetranMyDataResultSchema,
  type FivetranMyDataCatalogue,
  type FivetranMyDataResult,
  type FivetranMyDataTable,
} from "../../operator-diagnostic/src/contracts.js";
import {
  operatorDiagnosticSecret,
  operatorDiagnosticServiceUrl,
} from "./operator-repository.js";
import { createServiceLogger } from "../../../packages/observability/src/index.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

const logger = createServiceLogger("albert-v3-web");

const requestReceiptSchema = z.object({
  request_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  expires_at: z.string().min(1),
}).strict();

const safeIdentifierSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u);
const safeSchemaSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);

export const fivetranMyDataRowsInputSchema = z.object({
  schemaName: safeSchemaSchema,
  tableName: safeIdentifierSchema,
  offset: z.number().int().min(0).max(10_000_000),
  limit: z.union([z.literal(25), z.literal(50)]),
}).strict();

export type FivetranMyDataRowsInput = z.infer<typeof fivetranMyDataRowsInputSchema>;

function requestError(error: Readonly<{ code?: string; message?: string }>): ControlPlaneError {
  if (error.code === "42501") {
    return new ControlPlaneError("Owner or manager access is required to browse Fivetran data.", 403);
  }
  if (error.code === "P0001") {
    return new ControlPlaneError("Too many data requests. Wait a moment and try again.", 429);
  }
  if (error.code === "P0002") {
    return new ControlPlaneError("That Fivetran schema is not connected to this organisation.", 404);
  }
  if (error.code === "22023") {
    return new ControlPlaneError("The Fivetran data request is invalid.", 400);
  }
  return new ControlPlaneError("Fivetran data access could not be authorised.", 503);
}

async function beginRequest(input: Readonly<{
  kind: "catalogue" | "rows";
  schemaName?: string;
  tableName?: string;
  offset?: number;
  limit?: 25 | 50;
}>): Promise<string> {
  const { supabase } = await requireUser();
  const requestId = ulid();
  const { data, error } = await supabase.rpc("begin_albert_fivetran_my_data_request", {
    p_request_id: requestId,
    p_request_kind: input.kind,
    p_schema_name: input.schemaName ?? null,
    p_table_name: input.tableName ?? null,
    p_row_offset: input.offset ?? 0,
    p_row_limit: input.limit ?? 25,
  });
  if (error) throw requestError(error);
  const receipt = requestReceiptSchema.safeParse(data);
  if (!receipt.success || receipt.data.request_id !== requestId) {
    throw new ControlPlaneError("Fivetran data access returned invalid authorization metadata.", 503);
  }
  return requestId;
}

async function executeRequest(requestId: string): Promise<FivetranMyDataResult> {
  const body = JSON.stringify({ requestId });
  const url = operatorDiagnosticServiceUrl(FIVETRAN_MY_DATA_PATH);
  const headers = await signFivetranMyDataRequest(body, operatorDiagnosticSecret());
  let response: Response;
  try {
    response = await fetch(url.href, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    logger.error("fivetran_my_data_transport_failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "unknown",
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
    });
    throw new ControlPlaneError("The Fivetran data service is unavailable.", 503);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ControlPlaneError("The Fivetran data service is unavailable.", 503);
  }
  const payload = await response.json().catch(() => null) as Readonly<{ result?: unknown }> | null;
  if (!response.ok) {
    throw new ControlPlaneError("Fivetran data could not be loaded.", response.status === 400 ? 400 : 503);
  }
  const result = fivetranMyDataResultSchema.safeParse(payload?.result);
  if (!result.success || (
    result.data.kind === "catalogue"
      ? result.data.catalogue.requestId !== requestId
      : result.data.table.requestId !== requestId
  )) {
    throw new ControlPlaneError("The Fivetran data service returned invalid content.", 503);
  }
  return result.data;
}

export async function loadFivetranMyDataCatalogue(): Promise<FivetranMyDataCatalogue> {
  const requestId = await beginRequest({ kind: "catalogue" });
  const result = await executeRequest(requestId);
  if (result.kind !== "catalogue") {
    throw new ControlPlaneError("The Fivetran data service returned the wrong result type.", 503);
  }
  return result.catalogue;
}

export async function loadFivetranMyDataRows(
  inputValue: FivetranMyDataRowsInput,
): Promise<FivetranMyDataTable> {
  const input = fivetranMyDataRowsInputSchema.parse(inputValue);
  const requestId = await beginRequest({
    kind: "rows",
    schemaName: input.schemaName,
    tableName: input.tableName,
    offset: input.offset,
    limit: input.limit,
  });
  const result = await executeRequest(requestId);
  if (result.kind !== "rows" || result.table.schemaName !== input.schemaName ||
      result.table.tableName !== input.tableName || result.table.offset !== input.offset ||
      result.table.limit !== input.limit) {
    throw new ControlPlaneError("The Fivetran data service returned the wrong table page.", 503);
  }
  return result.table;
}
