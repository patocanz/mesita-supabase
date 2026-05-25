// Role catalog for the business population. The DB enum
// (public.member_role) includes a legacy 'staff' value used only by
// venue_members rows created before venue_roles existed — the Team
// surface speaks only owner / business / viewer, and 'business' is
// rendered as "Editor" in the UI.

export const BUSINESS_ROLES = ["owner", "business", "viewer"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

const BUSINESS_ROLE_SET = new Set<string>(BUSINESS_ROLES);

export function isBusinessRole(value: unknown): value is BusinessRole {
  return typeof value === "string" && BUSINESS_ROLE_SET.has(value);
}
