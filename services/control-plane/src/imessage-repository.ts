/**
 * iMessage enrolment repository (migration 0180): who may text the tenant's
 * Albert line over Linq, and whether group chats are answered. Reads for any
 * active member; every write is owner/manager-gated in the RPCs themselves.
 * The imessage-bridge service reads the same workspace through the owner
 * session on every inbound delivery.
 */
import { z } from "zod";
import { requireUser, ControlPlaneError } from "./web-repository.js";
import type {
  ImessageEnrollment,
  ImessageWorkspace,
} from "../../imessage-bridge/src/contracts.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const enrollmentSchema = z.object({
  enrollmentId: z.string().min(8).max(60),
  phone: z.string().regex(/^\+[1-9][0-9]{5,14}$/u),
  displayName: z.string().nullish(),
  email: z.string().nullish(),
  isOwner: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

const workspaceSchema = z.object({
  allowGroupChats: z.boolean(),
  enrollments: z.array(enrollmentSchema.passthrough()),
}).passthrough();

function toEnrollment(raw: z.infer<typeof enrollmentSchema>): ImessageEnrollment {
  return Object.freeze({
    enrollmentId: raw.enrollmentId,
    phone: raw.phone,
    displayName: raw.displayName ?? null,
    email: raw.email ?? null,
    isOwner: raw.isOwner,
    enabled: raw.enabled,
    createdAt: raw.createdAt,
  });
}

function singleton(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

export async function loadImessageWorkspace(supabaseClient?: SupabaseClient): Promise<ImessageWorkspace> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_imessage_workspace");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The iMessage enrolment migration is not deployed.", 503);
    }
    throw new ControlPlaneError("iMessage enrolments could not be loaded.", 503);
  }
  const parsed = workspaceSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("iMessage enrolments returned invalid state.", 503);
  return Object.freeze({
    allowGroupChats: parsed.data.allowGroupChats,
    enrollments: Object.freeze(parsed.data.enrollments.map(toEnrollment)),
  });
}

export async function enrollImessageNumber(
  input: Readonly<{ phone: string; displayName?: string; email?: string }>,
  supabaseClient?: SupabaseClient,
): Promise<Readonly<{ enrollment: ImessageEnrollment; existed: boolean }>> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_imessage_enroll", {
    p_phone: input.phone,
    p_display_name: input.displayName ?? null,
    p_email: input.email ?? null,
  });
  if (error) {
    const message = error.message ?? "";
    if (/E\.164/iu.test(message)) throw new ControlPlaneError("That doesn't look like a full phone number - include the country code, like +61414187820.", 400);
    if (/insufficient role/iu.test(message)) throw new ControlPlaneError("Only owners and managers can enrol numbers.", 403);
    if (/20 enrolled numbers/iu.test(message)) throw new ControlPlaneError("This organisation already has 20 enrolled numbers - remove one first.", 409);
    throw new ControlPlaneError("The number could not be enrolled.", 503);
  }
  const payload = singleton(data) as Record<string, unknown> | null;
  const parsed = enrollmentSchema.safeParse(payload);
  if (!parsed.success) throw new ControlPlaneError("The enrolment returned invalid state.", 503);
  return Object.freeze({
    enrollment: toEnrollment(parsed.data),
    existed: (payload as { existed?: unknown })?.existed === true,
  });
}

export async function updateImessageEnrollment(
  input: Readonly<{ enrollmentId: string; enabled: boolean }>,
  supabaseClient?: SupabaseClient,
): Promise<ImessageEnrollment> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_imessage_update_enrollment", {
    p_enrollment_id: input.enrollmentId,
    p_enabled: input.enabled,
  });
  if (error) {
    const message = error.message ?? "";
    if (/owner''?s number/iu.test(message)) throw new ControlPlaneError("The owner's number can't be turned off.", 409);
    if (/insufficient role/iu.test(message)) throw new ControlPlaneError("Only owners and managers can change enrolments.", 403);
    if (error.code === "P0002") throw new ControlPlaneError("That enrolment no longer exists.", 404);
    throw new ControlPlaneError("The enrolment could not be updated.", 503);
  }
  const parsed = enrollmentSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The enrolment returned invalid state.", 503);
  return toEnrollment(parsed.data);
}

export async function removeImessageEnrollment(
  enrollmentId: string,
  supabaseClient?: SupabaseClient,
): Promise<boolean> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_imessage_remove_enrollment", {
    p_enrollment_id: enrollmentId,
  });
  if (error) {
    const message = error.message ?? "";
    if (/owner''?s number/iu.test(message)) throw new ControlPlaneError("The owner's number can't be removed.", 409);
    if (/insufficient role/iu.test(message)) throw new ControlPlaneError("Only owners and managers can remove enrolments.", 403);
    throw new ControlPlaneError("The enrolment could not be removed.", 503);
  }
  return data === true;
}

export async function setImessageGroupChats(
  allowed: boolean,
  supabaseClient?: SupabaseClient,
): Promise<boolean> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { error } = await supabase.rpc("albert_imessage_set_group_chats", {
    p_allowed: allowed,
  });
  if (error) {
    if (/insufficient role/iu.test(error.message ?? "")) {
      throw new ControlPlaneError("Only owners and managers can change iMessage settings.", 403);
    }
    throw new ControlPlaneError("The group-chat setting could not be saved.", 503);
  }
  return allowed;
}
