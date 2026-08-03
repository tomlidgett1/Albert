import { ControlPlaneError, requireUser } from "./web-repository.js";

export async function isInternalOperator(): Promise<boolean> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_operator_status");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return false;
    throw new ControlPlaneError("Operator access could not be verified.", 503);
  }
  return data === true;
}

export async function loadOperatorFleet(): Promise<unknown> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_operator_fleet");
  if (error) {
    if (error.code === "42501") throw new ControlPlaneError("Internal operator access is required.", 403);
    throw new ControlPlaneError("Fleet status could not be loaded.", 503);
  }
  return data;
}

export async function loadOperatorPipeline(tenantId: string): Promise<unknown> {
  const { supabase } = await requireUser();
  const [{ data, error }, stats, transforms] = await Promise.all([
    supabase.rpc("albert_operator_pipeline", { p_tenant_id: tenantId }),
    supabase.rpc("albert_operator_pipeline_stats", { p_tenant_id: tenantId }),
    supabase.rpc("albert_operator_transform_jobs", { p_tenant_id: tenantId }),
  ]);
  if (error) {
    if (error.code === "42501") throw new ControlPlaneError("Internal operator access is required.", 403);
    if (error.code === "P0002") throw new ControlPlaneError("The tenant was not found.", 404);
    throw new ControlPlaneError("The tenant pipeline could not be loaded.", 503);
  }
  if (stats.error) {
    if (stats.error.code === "42501") throw new ControlPlaneError("Internal operator access is required.", 403);
    throw new ControlPlaneError("Pipeline statistics could not be loaded.", 503);
  }
  if (transforms.error) {
    if (transforms.error.code === "42501") throw new ControlPlaneError("Internal operator access is required.", 403);
    throw new ControlPlaneError("Canonical transform jobs could not be loaded.", 503);
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return {
      ...(data as Record<string, unknown>),
      pipeline_stats: stats.data ?? [],
      transform_jobs: transforms.data ?? [],
    };
  }
  return data;
}
