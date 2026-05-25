// Role catalog for the per-venue member tier. The DB enum
// (public.member_role) includes a legacy 'staff' value used only by
// venue_members rows created before venue_roles existed — the Team
// surface speaks only owner / editor / viewer.
//
// This is intentionally distinct from the platform-level business role
// (auth.users app_metadata.role = 'business').

export const MEMBER_ROLES = ["owner", "editor", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

const MEMBER_ROLE_SET = new Set<string>(MEMBER_ROLES);

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && MEMBER_ROLE_SET.has(value);
}
