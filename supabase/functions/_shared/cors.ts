// Canonical CORS headers for every Mesita Edge Function. Wide-open
// origin is intentional — these EFs are called from web, native, and
// future partner contexts, and we authenticate per-request via the
// bearer/anon token rather than relying on the Origin header.

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  // GET is advertised for the handful of read EFs that accept both —
  // adding it to the canonical header doesn't enable GET on POST-only
  // handlers because each EF still gates the method server-side.
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
} as const;
