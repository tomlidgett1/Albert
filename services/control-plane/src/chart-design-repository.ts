import {
  DEFAULT_NIVO_CHART_DESIGN,
  normalizeNivoChartDesign,
  type NivoChartDesign,
} from "@/packages/shared/src";
import { ControlPlaneError, requireUser } from "./web-repository.js";
import { isInternalOperator } from "./operator-repository.js";

function operatorError(
  error: Readonly<{ code?: string }> | null,
  fallback: string,
): ControlPlaneError {
  if (error?.code === "42501") return new ControlPlaneError("Internal operator access is required.", 403);
  if (error?.code === "22023") return new ControlPlaneError("The chart design is invalid.", 400);
  if (error?.code === "PGRST202" || error?.code === "42883") {
    return new ControlPlaneError("The chart design migration is not deployed.", 503);
  }
  return new ControlPlaneError(fallback, 503);
}

export async function loadPublishedChartDesign(): Promise<NivoChartDesign> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_chart_design");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      return DEFAULT_NIVO_CHART_DESIGN;
    }
    throw operatorError(error, "The chart design could not be loaded.");
  }
  return normalizeNivoChartDesign(data ?? DEFAULT_NIVO_CHART_DESIGN);
}

export async function savePublishedChartDesign(value: unknown): Promise<NivoChartDesign> {
  if (!(await isInternalOperator())) {
    throw new ControlPlaneError("Internal operator access is required.", 403);
  }
  const design = normalizeNivoChartDesign(value);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_save_chart_design", { p_design: design });
  if (error) throw operatorError(error, "The chart design could not be saved.");
  return design;
}
