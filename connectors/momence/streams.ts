import type {
  ConnectorEmittedTarget,
  StreamContract,
} from "../../packages/connector-sdk/src/index.js";
import type { SourceAuthorityConcept } from "../../packages/canonical-schema/src/index.js";

export type MomenceStreamId =
  | "momence_profile"
  | "momence_members"
  | "momence_memberships"
  | "momence_appointments"
  | "momence_sessions"
  | "momence_session_details"
  | "momence_session_bookings"
  | "momence_member_sessions"
  | "momence_member_appointments"
  | "momence_bought_memberships"
  | "momence_member_notes"
  | "momence_tags"
  | "momence_public_locations"
  | "momence_public_memberships"
  | "momence_public_sessions"
  | "momence_sales"
  | "momence_payment_transactions";

type ProductDomain = StreamContract["productDomains"][number];

type MomenceStreamBase = Readonly<{
  id: MomenceStreamId;
  label: string;
  resource: string;
  endpoint: string;
  recordIdPath: string;
  modifiedPath: string | null;
  pageSize: number | null;
  sortBy?: string;
  sortOrder?: "ASC" | "DESC";
  fixedQuery?: Readonly<Record<string, string | number | boolean>>;
  availability: "required" | "optional";
  dependencies: readonly MomenceStreamId[];
  productDomains: readonly ProductDomain[];
  canonicalTargets: readonly ConnectorEmittedTarget[];
  authorityConcept: SourceAuthorityConcept;
  priority: number;
  documentation: string;
}>;

export type MomenceSingletonStream = MomenceStreamBase & Readonly<{
  kind: "singleton";
}>;

export type MomencePageStream = MomenceStreamBase & Readonly<{
  kind: "page";
  timeFilter?: Readonly<{
    sourceField: "startsAt" | "saleDate";
    startParameter: string;
    endParameter: string;
  }>;
}>;

export type MomenceFanoutStream = MomenceStreamBase & Readonly<{
  kind: "fanout";
  parent: Readonly<{
    endpoint: string;
    pageSize: number;
    recordIdPath: string;
    sortBy: string;
    sortOrder: "ASC" | "DESC";
  }>;
  parentPathParameter: "memberId" | "sessionId" | "paymentTransactionId";
  childPagination: "page" | "singleton";
  timeFilter?: Readonly<{
    sourceField: "startsAt";
    startParameter: string;
    endParameter: string;
    target: "parent" | "child";
  }>;
  /** Composite identity is used where one reservation may appear for multiple members. */
  compositeIdentity?: boolean;
}>;

export type MomenceReadStream = MomenceSingletonStream | MomencePageStream | MomenceFanoutStream;

const docs = (reference: string): string => `https://api.docs.momence.com/reference/${reference}`;

const base = <T extends MomenceReadStream>(stream: T): T => Object.freeze(stream);

/**
 * Complete read-only store graph exposed by Momence public API v2.
 *
 * Member-personal endpoints (saved cards, waivers and the authorising staff
 * member's own visits) are deliberately outside this host analytics graph.
 * They describe the logged-in person, not the connected studio, and mixing
 * them into a store model would be a tenant/grain error. Their schemas remain
 * present in the generated exhaustive API contract with an explicit boundary.
 */
export const MOMENCE_READ_STREAMS: readonly MomenceReadStream[] = Object.freeze([
  base({
    id: "momence_profile", label: "Authorising profile", resource: "AuthProfile",
    endpoint: "/api/v2/auth/profile", kind: "singleton", recordIdPath: "userId",
    modifiedPath: null, pageSize: null, availability: "required", dependencies: [],
    productDomains: ["customers"], canonicalTargets: ["metadata"],
    authorityConcept: "customer_master", priority: 1,
    documentation: docs("apiv2authcontroller_getprofile"),
  }),
  base({
    id: "momence_members", label: "Members", resource: "Member",
    endpoint: "/api/v2/host/members", kind: "page", recordIdPath: "id",
    modifiedPath: "lastSeen", pageSize: 100, sortBy: "email", sortOrder: "ASC",
    availability: "required", dependencies: ["momence_profile"],
    productDomains: ["customers"], canonicalTargets: ["person", "customer_account", "identity_hint"],
    authorityConcept: "customer_master", priority: 2,
    documentation: docs("apiv2hostmemberscontroller_list"),
  }),
  base({
    id: "momence_memberships", label: "Membership plans", resource: "Membership",
    endpoint: "/api/v2/host/memberships", kind: "page", recordIdPath: "id",
    modifiedPath: null, pageSize: 200, sortBy: "name", sortOrder: "ASC",
    fixedQuery: { includeDisabled: true }, availability: "required", dependencies: ["momence_profile"],
    productDomains: ["products", "sales"], canonicalTargets: ["product", "product_variant", "metadata"],
    authorityConcept: "product_master", priority: 2,
    documentation: docs("apiv2hostmembershipscontroller_list"),
  }),
  base({
    id: "momence_appointments", label: "Appointment reservations", resource: "AppointmentReservation",
    endpoint: "/api/v2/host/appointments/reservations", kind: "page", recordIdPath: "id",
    modifiedPath: "createdAt", pageSize: 200, sortBy: "startsAt", sortOrder: "ASC",
    fixedQuery: { includeCancelled: true, includeCancelledAttendees: true },
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore" },
    availability: "required", dependencies: ["momence_members"], productDomains: ["sales", "customers"],
    canonicalTargets: ["worker", "location", "metadata"], authorityConcept: "operational_sales", priority: 3,
    documentation: docs("apiv2hostappointmentreservationscontroller_list"),
  }),
  base({
    id: "momence_sessions", label: "Classes and sessions", resource: "Session",
    endpoint: "/api/v2/host/sessions", kind: "page", recordIdPath: "id",
    modifiedPath: "startsAt", pageSize: 200, sortBy: "startsAt", sortOrder: "ASC",
    fixedQuery: { includeCancelled: true },
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore" },
    availability: "required", dependencies: ["momence_profile"], productDomains: ["sales", "products"],
    canonicalTargets: ["worker", "location", "metadata"], authorityConcept: "operational_sales", priority: 3,
    documentation: docs("apiv2hostsessionscontroller_list"),
  }),
  base({
    id: "momence_session_details", label: "Session details", resource: "SessionDetail",
    endpoint: "/api/v2/host/sessions/{sessionId}", kind: "fanout", recordIdPath: "id",
    modifiedPath: "startsAt", pageSize: null, availability: "required", dependencies: ["momence_sessions"],
    parent: { endpoint: "/api/v2/host/sessions", pageSize: 200, recordIdPath: "id", sortBy: "startsAt", sortOrder: "ASC" },
    parentPathParameter: "sessionId", childPagination: "singleton",
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore", target: "parent" },
    productDomains: ["sales", "products"], canonicalTargets: ["worker", "location", "metadata"],
    authorityConcept: "operational_sales", priority: 4,
    documentation: docs("apiv2hostsessionscontroller_retrieve"),
  }),
  base({
    id: "momence_session_bookings", label: "Session bookings", resource: "SessionBooking",
    endpoint: "/api/v2/host/sessions/{sessionId}/bookings", kind: "fanout", recordIdPath: "id",
    modifiedPath: "createdAt", pageSize: 100, sortBy: "createdAt", sortOrder: "ASC",
    fixedQuery: { includeCancelled: true }, availability: "required", dependencies: ["momence_sessions", "momence_members"],
    parent: { endpoint: "/api/v2/host/sessions", pageSize: 200, recordIdPath: "id", sortBy: "startsAt", sortOrder: "ASC" },
    parentPathParameter: "sessionId", childPagination: "page",
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore", target: "parent" },
    productDomains: ["sales", "customers"], canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 5,
    documentation: docs("apiv2hostsessionbookingscontroller_list"),
  }),
  base({
    id: "momence_bought_memberships", label: "Active bought memberships", resource: "BoughtMembership",
    endpoint: "/api/v2/host/members/{memberId}/bought-memberships/active", kind: "fanout", recordIdPath: "id",
    modifiedPath: "startDate", pageSize: 200, fixedQuery: { includeFrozen: true },
    availability: "required", dependencies: ["momence_members", "momence_memberships"],
    parent: { endpoint: "/api/v2/host/members", pageSize: 100, recordIdPath: "id", sortBy: "email", sortOrder: "ASC" },
    parentPathParameter: "memberId", childPagination: "page",
    productDomains: ["customers", "sales", "products"], canonicalTargets: ["metadata"],
    authorityConcept: "customer_master", priority: 5,
    documentation: docs("apiv2hostboughtmembershipscontroller_listactive"),
  }),
  base({
    id: "momence_member_sessions", label: "Member session history", resource: "MemberSessionBooking",
    endpoint: "/api/v2/host/members/{memberId}/sessions", kind: "fanout", recordIdPath: "id",
    modifiedPath: "createdAt", pageSize: 100, sortBy: "startsAt", sortOrder: "ASC",
    fixedQuery: { includeCancelled: true }, availability: "required", dependencies: ["momence_members", "momence_sessions"],
    parent: { endpoint: "/api/v2/host/members", pageSize: 100, recordIdPath: "id", sortBy: "email", sortOrder: "ASC" },
    parentPathParameter: "memberId", childPagination: "page",
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore", target: "child" },
    productDomains: ["customers", "sales"], canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 6,
    documentation: docs("apiv2hostmemberscontroller_listsessions"),
  }),
  base({
    id: "momence_member_appointments", label: "Member appointment history", resource: "MemberAppointmentReservation",
    endpoint: "/api/v2/host/members/{memberId}/appointments", kind: "fanout", recordIdPath: "id",
    modifiedPath: "createdAt", pageSize: 200, sortBy: "startsAt", sortOrder: "ASC",
    fixedQuery: { includeCancelled: true },
    availability: "required", dependencies: ["momence_members", "momence_appointments"],
    parent: { endpoint: "/api/v2/host/members", pageSize: 100, recordIdPath: "id", sortBy: "email", sortOrder: "ASC" },
    parentPathParameter: "memberId", childPagination: "page", compositeIdentity: true,
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore", target: "child" },
    productDomains: ["customers", "sales"], canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 6,
    documentation: docs("apiv2hostmemberscontroller_listappointments"),
  }),
  base({
    id: "momence_member_notes", label: "Member notes", resource: "MemberNote",
    endpoint: "/api/v2/host/members/{memberId}/notes", kind: "fanout", recordIdPath: "id",
    modifiedPath: "modifiedAt", pageSize: 100, sortBy: "modifiedAt", sortOrder: "ASC",
    availability: "optional", dependencies: ["momence_members"],
    parent: { endpoint: "/api/v2/host/members", pageSize: 100, recordIdPath: "id", sortBy: "email", sortOrder: "ASC" },
    parentPathParameter: "memberId", childPagination: "page",
    productDomains: ["customers"], canonicalTargets: ["metadata"],
    authorityConcept: "customer_master", priority: 7,
    documentation: docs("apiv2hostmembernotescontroller_list"),
  }),
  base({
    id: "momence_tags", label: "Tags", resource: "Tag",
    endpoint: "/api/v2/host/tags", kind: "page", recordIdPath: "id",
    modifiedPath: null, pageSize: 100, sortBy: "name", sortOrder: "ASC",
    availability: "required", dependencies: ["momence_members"], productDomains: ["customers", "products"],
    canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 7,
    documentation: docs("apiv2hosttagscontroller_list"),
  }),
  base({
    id: "momence_public_locations", label: "Public host locations", resource: "Location",
    endpoint: "/api/v2/member/host/locations", kind: "page", recordIdPath: "id",
    modifiedPath: null, pageSize: 200, sortBy: "name", sortOrder: "ASC",
    availability: "optional", dependencies: ["momence_profile"], productDomains: ["sales"],
    canonicalTargets: ["location", "metadata", "identity_hint"], authorityConcept: "operational_sales", priority: 8,
    documentation: docs("apiv2memberhostlocationscontroller_list"),
  }),
  base({
    id: "momence_public_memberships", label: "Public membership catalogue", resource: "PublicMembership",
    endpoint: "/api/v2/member/host/memberships", kind: "page", recordIdPath: "id",
    modifiedPath: null, pageSize: 200, sortBy: "name", sortOrder: "ASC", fixedQuery: { includeDisabled: true },
    availability: "optional", dependencies: ["momence_memberships"], productDomains: ["products", "sales"],
    canonicalTargets: ["metadata"], authorityConcept: "product_master", priority: 8,
    documentation: docs("apiv2memberhostmembershipscontroller_list"),
  }),
  base({
    id: "momence_public_sessions", label: "Public session catalogue", resource: "PublicSession",
    endpoint: "/api/v2/member/host/sessions", kind: "page", recordIdPath: "id",
    modifiedPath: "startsAt", pageSize: 200, sortBy: "startsAt", sortOrder: "ASC",
    fixedQuery: { includeCancelled: true },
    timeFilter: { sourceField: "startsAt", startParameter: "startAfter", endParameter: "startBefore" },
    availability: "optional", dependencies: ["momence_sessions"], productDomains: ["products", "sales"],
    canonicalTargets: ["worker", "location", "metadata"], authorityConcept: "operational_sales", priority: 8,
    documentation: docs("apiv2memberhostsessionscontroller_list"),
  }),
  base({
    id: "momence_sales", label: "Sales", resource: "Sale",
    endpoint: "/api/v2/host/sales", kind: "page", recordIdPath: "id",
    modifiedPath: "saleDate", pageSize: 200, sortBy: "saleDate", sortOrder: "ASC",
    availability: "optional", dependencies: ["momence_members", "momence_memberships"],
    productDomains: ["sales", "accounting", "customers", "products"],
    canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 9,
    documentation: docs("apiv2hostsalescontroller_list"),
  }),
  base({
    id: "momence_payment_transactions", label: "Payment transactions", resource: "PaymentTransaction",
    endpoint: "/api/v2/host/payment-transactions/{paymentTransactionId}", kind: "fanout", recordIdPath: "id",
    modifiedPath: "createdAt", pageSize: null, availability: "optional",
    dependencies: ["momence_members", "momence_member_notes"],
    // Transaction ids are not present on HostSaleDto. They are discoverable
    // only from note.paymentTransactionId (or webhooks/reports). Runtime walks
    // members -> notes -> transaction detail, preserving this documented gap.
    parent: { endpoint: "/api/v2/host/members", pageSize: 100, recordIdPath: "id", sortBy: "email", sortOrder: "ASC" },
    parentPathParameter: "paymentTransactionId", childPagination: "singleton",
    productDomains: ["sales", "accounting", "customers"],
    canonicalTargets: ["metadata"],
    authorityConcept: "cash_settlement", priority: 10,
    documentation: docs("apiv2hostpaymenttransactionscontroller_retrieve"),
  }),
]);

export const MOMENCE_STREAM_BY_ID = new Map(MOMENCE_READ_STREAMS.map((stream) => [stream.id, stream]));

/**
 * These populations are bounded by either the requested operational window or
 * the identities that Momence currently makes discoverable. The generic
 * reconciliation worker compares snapshot identities with all staged history,
 * so absence from either bounded population can never prove source deletion.
 */
function hasBoundedIdentityPopulation(stream: MomenceReadStream): boolean {
  return ("timeFilter" in stream && Boolean(stream.timeFilter)) ||
    stream.id === "momence_payment_transactions";
}

export function momenceDeletionContract(
  stream: MomenceReadStream,
): StreamContract["deletionStrategy"] {
  return hasBoundedIdentityPopulation(stream)
    ? "no_absence_deletes"
    : "authoritative_identity_scan";
}

/** The terminal total must describe exactly the population the scan observed. */
export function momenceSourceTotalContract(
  stream: MomenceReadStream,
): StreamContract["sourceTotalStrategy"] {
  if (hasBoundedIdentityPopulation(stream)) return "count_distinct_bounded_scan";
  return stream.kind === "page"
    ? "provider_reported"
    : "count_distinct_complete_scan";
}

export function momenceStreamContracts(): readonly StreamContract[] {
  return MOMENCE_READ_STREAMS.map((stream): StreamContract => ({
    id: stream.id,
    resource: stream.resource,
    endpoint: stream.endpoint,
    recordIdField: "recordId",
    ...(stream.modifiedPath ? { modifiedField: "occurredAt" } : {}),
    pagination: stream.kind === "singleton" ? "none" : "page",
    backfillStrategy: "timeFilter" in stream && stream.timeFilter ? "time_windowed" : "snapshot",
    lateEditStrategy: "full_snapshot",
    deletionStrategy: momenceDeletionContract(stream),
    sourceTotalStrategy: momenceSourceTotalContract(stream),
    availability: stream.availability,
    dependencies: stream.dependencies,
    productDomains: stream.productDomains,
    canonicalTargets: stream.canonicalTargets,
    authorityConcept: stream.authorityConcept,
  }));
}
