import { z } from "zod";
import { ControlPlaneError, requireUser, type TenantContext } from "./web-repository.js";

const roleSchema = z.enum(["owner", "manager", "bookkeeper"]);
const organisationSchema = z.object({
  tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  name: z.string().min(1).max(120),
  slug: z.string().min(1),
  role: roleSchema,
  status: z.enum(["active", "deleting"]),
  timezone: z.string().min(1),
  selected: z.boolean(),
}).strict();

const memberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email().nullable(),
  role: roleSchema,
  status: z.enum(["active", "suspended"]),
  createdAt: z.string(),
  isCurrentUser: z.boolean(),
}).strict();

const deletionSchema = z.object({
  deletionRequestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  status: z.string().min(1),
  requestedAt: z.string(),
  approvalExpiresAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  proofId: z.string().nullable(),
}).strict();

const settingsSchema = z.object({
  tenant: organisationSchema.omit({ selected: true }).extend({
    status: z.string().min(1),
  }).strict(),
  members: z.array(memberSchema),
  deletion: deletionSchema.nullable(),
}).strict();

const contextSchema = z.object({
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  tenant_name: z.string().min(1),
  tenant_slug: z.string().min(1),
  role: roleSchema,
  timezone: z.string().min(1),
}).strict();

export type OrganisationSummary = z.infer<typeof organisationSchema>;
export type OrganisationSettings = z.infer<typeof settingsSchema>;
export type OrganisationRole = z.infer<typeof roleSchema>;

function one(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function rpcError(error: Readonly<{ code?: string }>, fallback: string): ControlPlaneError {
  if (error.code === "42501") return new ControlPlaneError("Owner access is required for that organisation change.", 403);
  if (error.code === "P0002") return new ControlPlaneError("The registered Albert user or organisation was not found.", 404);
  if (error.code === "22023") return new ControlPlaneError("The organisation change is invalid.", 400);
  if (error.code === "P0001") return new ControlPlaneError("Too many organisation changes. Please wait and try again.", 429);
  if (error.code === "55000") return new ControlPlaneError("The organisation context changed or is being deleted. Refresh before retrying.", 409);
  return new ControlPlaneError(fallback, 503);
}

export async function listOrganisations(): Promise<readonly OrganisationSummary[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_list_organisations");
  if (error) throw rpcError(error, "Your organisations could not be loaded.");
  const parsed = z.array(organisationSchema).safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Your organisations returned invalid state.", 503);
  return Object.freeze(parsed.data);
}

export async function loadOrganisationSettings(): Promise<OrganisationSettings> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_organisation_settings");
  if (error) throw rpcError(error, "Organisation settings could not be loaded.");
  const parsed = settingsSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Organisation settings returned invalid state.", 503);
  return parsed.data;
}

export async function selectOrganisation(tenantId: string): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_select_organisation", { p_tenant_id: tenantId });
  if (error) throw rpcError(error, "The organisation could not be selected.");
}

export async function createOrganisation(input: Readonly<{ displayName: string; timezone: string }>): Promise<TenantContext> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_create_organisation", {
    p_display_name: input.displayName,
    p_timezone: input.timezone,
  });
  if (error) throw rpcError(error, "The organisation could not be created.");
  const parsed = contextSchema.safeParse(one(data));
  if (!parsed.success) throw new ControlPlaneError("The created organisation returned invalid state.", 503);
  return parsed.data;
}

export async function renameOrganisation(expectedTenantId: string, displayName: string): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_rename_organisation", {
    p_expected_tenant_id: expectedTenantId,
    p_display_name: displayName,
  });
  if (error) throw rpcError(error, "The organisation could not be renamed.");
}

export async function addOrganisationMember(
  expectedTenantId: string,
  email: string,
  role: OrganisationRole,
): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_add_organisation_member", {
    p_expected_tenant_id: expectedTenantId,
    p_email: email,
    p_role: role,
  });
  if (error) throw rpcError(error, "The member could not be added.");
}

export async function updateOrganisationMember(input: Readonly<{
  expectedTenantId: string;
  userId: string;
  role: OrganisationRole;
  status: "active" | "revoked";
}>): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_update_organisation_member", {
    p_expected_tenant_id: input.expectedTenantId,
    p_user_id: input.userId,
    p_role: input.role,
    p_status: input.status,
  });
  if (error) throw rpcError(error, "The member could not be updated.");
}
