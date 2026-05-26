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
