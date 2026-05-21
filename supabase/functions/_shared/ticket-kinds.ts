// Ticket-kind taxonomy used by manager-create-ticket, manager-mark-paid,
// and manager-verify-story. Single source of truth so a new flow added
// to one EF can't drift from the others.
//
// Pure sets — no DB reads, no auth, no I/O — so importing from _shared
// stays compatible with the "Edge Functions are self-contained" rule.

export const FORMAL_KINDS = new Set([
  "p_c",
  "s_p_sf_c",
  "r_p_c",
  "r_s_p_sf_c",
]);

export const STORY_KINDS = new Set([
  "s_p_sf_c",
  "r_s_p_sf_c",
  "s_dp_sf",
  "r_s_dp_sf",
]);

export const FORMAL_STORY_KINDS = new Set(["s_p_sf_c", "r_s_p_sf_c"]);

export const INFORMAL_STORY_KINDS = new Set(["s_dp_sf", "r_s_dp_sf"]);

export const RESERVATION_KINDS = new Set([
  "r_p_c",
  "r_s_p_sf_c",
  "r_dp",
  "r_s_dp_sf",
]);

// Every kind that produces a ticket row (i.e. everything except `none`).
export const ACTIONABLE_KINDS = new Set([
  "p_c",
  "s_p_sf_c",
  "r_p_c",
  "r_s_p_sf_c",
  "dp",
  "s_dp_sf",
  "r_dp",
  "r_s_dp_sf",
]);
