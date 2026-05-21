// Canonical CORS headers for every Mesita Edge Function. Wide-open
// origin is intentional — these EFs are called from web, native, and
// future partner contexts, and we authenticate per-request via the
// bearer/anon token rather than relying on the Origin header.
//
// Per the project rule "Edge Functions are self-contained, no
// function-to-function calls", importing pure utilities from a sibling
// module under _shared/ is fine — Supabase deploys each function with
// the files it imports, and there's no runtime function-to-function
// composition. This file is just shared source.

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  // GET is advertised for the handful of read EFs that accept both —
  // adding it to the canonical header doesn't enable GET on POST-only
  // handlers because each EF still gates the method server-side.
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
} as const;
