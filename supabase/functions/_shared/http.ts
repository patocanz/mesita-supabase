// HTTP helpers shared by all Mesita Edge Functions: JSON response builder
// + the canonical OPTIONS pre-flight handler. Pure utilities; no DB calls,
// no fetches, no auth — safe to import from any natural-caller or
// artificial-caller EF.

import { CORS } from "./cors.ts";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Use as the first line of every Deno.serve handler:
//   if (req.method === "OPTIONS") return corsPreflight();
export function corsPreflight(): Response {
  return new Response(null, { headers: CORS });
}

// Parse a JSON request body for endpoints where the body is REQUIRED.
// Returns a tagged result so the handler can early-return the 400 without
// repeating the try/catch:
//
//   const bodyRes = await readJson<Body>(req);
//   if (!bodyRes.ok) return bodyRes.response;
//   const body = bodyRes.body;
//
// A malformed/empty body yields a 400 `{ ok: false, error: "Invalid JSON" }`
// — the canonical shape every other validation error in these EFs uses.
export async function readJson<T>(
  req: Request,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: (await req.json()) as T };
  } catch {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid JSON" }, 400),
    };
  }
}

// Lenient variant for endpoints where the body is OPTIONAL — anonymous
// browse, optional pagination/filter fields, etc. Returns `fallback` when
// the body is absent or unparseable instead of erroring:
//
//   const body = await readJsonOr<Body>(req, {});
export async function readJsonOr<T>(req: Request, fallback: T): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return fallback;
  }
}

// Clamp and integer-normalize numeric pagination limits.
// Keeps limit handling consistent across list endpoints.
export function clampIntRange(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
