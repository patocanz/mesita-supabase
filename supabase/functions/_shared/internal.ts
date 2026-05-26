// Shared helpers for invoking *artificial-caller* EFs from *natural-caller*
// EFs (and authenticating those calls on the receiving end).
//
// Background: natural callers (admin/business/consumer/staff/waiter) are
// invoked by web clients and authenticate end users. Artificial callers
// (recommender/places/atlas/…) are reusable internal services with no end
// user — they exist so multiple natural callers can share expensive
// pipelines (RAG, Google Places, Atlas Storage IO) without duplicating
// hundreds of lines of code per natural EF.
//
// Wire protocol between the two:
//   1. The natural caller sends `Authorization: Bearer <SERVICE_ROLE_KEY>`
//      and `X-Internal-Caller: <natural-EF-name>` to the artificial caller.
//   2. The artificial caller has `verify_jwt = false` in supabase/config.toml
//      so the gateway lets the request through unauthenticated.
//   3. Inside the artificial caller, `requireInternalCaller(req, env)` checks
//      the Authorization bearer matches SERVICE_ROLE_KEY exactly. Anything
//      else gets a 403.
//
// We avoid the more elaborate "issue a fresh service JWT per call" pattern
// because the SERVICE_ROLE_KEY is already a long-lived secret that lives
// inside every EF runtime — sharing it across EFs costs nothing extra.

import type { EFEnv } from "./auth.ts";
import { json } from "./http.ts";

// Constant-time bearer comparison so an attacker probing the header can't
// extract bytes via timing analysis. The keys are short and the EF is
// rate-limited at the gateway, but the helper costs nothing.
function bearerMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let acc = 0;
  for (let i = 0; i < provided.length; i += 1) {
    acc |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return acc === 0;
}

// Verifies that a request was made by another EF with the service-role key.
// Use this at the top of every artificial-caller EF.
export function requireInternalCaller(
  req: Request,
  env: EFEnv,
):
  | { ok: true; callerName: string }
  | { ok: false; response: Response } {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      response: json({ ok: false, error: "Internal call requires bearer" }, 401),
    };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!bearerMatches(token, env.serviceKey)) {
    return {
      ok: false,
      response: json({ ok: false, error: "Internal call rejected" }, 403),
    };
  }
  const callerName = (req.headers.get("X-Internal-Caller") ?? "unknown").slice(0, 64);
  return { ok: true, callerName };
}

// Invokes an artificial-caller EF from a natural-caller EF. Returns the
// parsed body verbatim — the artificial caller's response shape is the
// natural caller's response shape minus auth/shaping concerns.
//
// We use the gateway URL (env.url + "/functions/v1/<name>") directly
// instead of supabase-js's functions.invoke so we can pass through arbitrary
// headers without supabase-js layering its own auth on top.
export async function invokeArtificialCaller<T = unknown>(
  env: EFEnv,
  callerName: string, // who the natural caller is, e.g. "consumer-recommend-deck"
  artificialName: string, // who we're calling, e.g. "recommender-rank-deck"
  body: unknown,
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string; status: number }
> {
  const url = `${env.url}/functions/v1/${artificialName}`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.serviceKey}`,
        "Content-Type": "application/json",
        "X-Internal-Caller": callerName,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `network error calling ${artificialName}`,
      status: 0,
    };
  }
  let parsed: unknown;
  try {
    parsed = await r.json();
  } catch {
    return {
      ok: false,
      error: `${artificialName} returned non-JSON (HTTP ${r.status})`,
      status: r.status,
    };
  }
  if (!r.ok) {
    const msg =
      (parsed as { error?: string } | null)?.error ??
      `${artificialName} returned HTTP ${r.status}`;
    return { ok: false, error: msg, status: r.status };
  }
  return { ok: true, data: parsed as T };
}
