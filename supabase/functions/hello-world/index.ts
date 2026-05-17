// Supabase Edge Function — hello-world
// Public smoke test. verify_jwt = false so the new sb_publishable_... key
// (passed via apikey header) is enough; no signed-in user required.
//
// Local:  supabase functions serve hello-world --no-verify-jwt
// Deploy: supabase functions deploy hello-world --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "Mesita";

  const body = {
    message: `Hello, ${name}!`,
    project: "Mesita",
    function: "hello-world",
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Connection": "keep-alive",
    },
  });
});
