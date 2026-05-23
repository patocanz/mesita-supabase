// Role catalog for the manager population. The DB enum
// (public.member_role) includes a legacy 'staff' value used only by
// venue_members rows created before venue_roles existed — the Team
// surface speaks only owner / manager / viewer, and 'manager' is
// rendered as "Editor" in the UI.

export const MANAGER_ROLES = ["owner", "manager", "viewer"] as const;
export type ManagerRole = (typeof MANAGER_ROLES)[number];

const MANAGER_ROLE_SET = new Set<string>(MANAGER_ROLES);

export function isManagerRole(value: unknown): value is ManagerRole {
  return typeof value === "string" && MANAGER_ROLE_SET.has(value);
}
