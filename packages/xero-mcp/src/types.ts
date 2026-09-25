export const XERO_MCP_RUNTIME = "xero-mcp" as const;
export const XERO_MCP_RUNTIME_HEADER = "xero_mcp" as const;

export type XeroMcpTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}>;

export type XeroMcpOrganisation = Readonly<{
  tenantId: string;
  connectionId: string;
  displayName: string;
  xeroTenantId: string;
  grantedScopes?: readonly string[];
  missingReportScopes?: readonly string[];
}>;

export type XeroMcpToolResult = Readonly<{
  text: string;
  isError: boolean;
}>;
