// Supabase Edge Function — hello-world
// Smoke test for the deploy pipeline. Returns a JSON greeting.
//
// Local:  supabase functions serve hello-world
// Deploy: supabase functions deploy hello-world

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
