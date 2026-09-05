/**
 * What the connections workspace knows that a dashboard run should carry:
 * the data-through watermarks per connector and the organisation's base
 * currency. Shared by the refresh sweep and the requery lane.
 */
export function currentWatermarks(workspace: unknown, connector: string | null | undefined): readonly unknown[] {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return [];
  const providers = (workspace as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((provider) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [];
    const row = provider as Record<string, unknown>;
    if (connector && row.id !== connector) return [];
    const connections = Array.isArray(row.connections) ? row.connections : [];
    return connections.flatMap((connection) => {
      if (!connection || typeof connection !== "object" || Array.isArray(connection)) return [];
      const domains = (connection as Record<string, unknown>).domains;
      if (!Array.isArray(domains)) return [];
      return domains.flatMap((domain) => {
        if (!domain || typeof domain !== "object" || Array.isArray(domain)) return [];
        const watermark = (domain as Record<string, unknown>).watermark;
        if (!watermark || typeof watermark !== "object" || Array.isArray(watermark)) return [];
        const at = (watermark as Record<string, unknown>).at;
        return typeof at === "string" ? [{ connector: row.id, label: row.name, dataThrough: at }] : [];
      });
    });
  });
}

export function currentCurrency(workspace: unknown): string | undefined {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return undefined;
  const dossier = (workspace as Record<string, unknown>).dossier;
  if (!Array.isArray(dossier)) return undefined;
  const value = dossier.find((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry as Record<string, unknown>).id === "base_currency"
  );
  const currency = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).value
    : undefined;
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}
