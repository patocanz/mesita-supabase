// Role catalog for the per-venue member tier. The DB enum
// (public.member_role) includes a legacy 'staff' value used only by
// venue_members rows created before venue_roles existed — the Team
// surface speaks only owner / manager / viewer, and 'manager' is
// rendered as "Editor" in the UI.
//
// This is intentionally distinct from the platform-level business role
// (auth.users app_metadata.role = 'business'). The per-venue tier kept
// its 'manager' literal during the manager→business platform rebrand
// because "Owner / Business / Viewer" reads awkwardly as a permissions
// hierarchy inside a single business.

export const MANAGER_ROLES = ["owner", "manager", "viewer"] as const;
export type ManagerRole = (typeof MANAGER_ROLES)[number];

const MANAGER_ROLE_SET = new Set<string>(MANAGER_ROLES);

export function isManagerRole(value: unknown): value is ManagerRole {
  return typeof value === "string" && MANAGER_ROLE_SET.has(value);
}
