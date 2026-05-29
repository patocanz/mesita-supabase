// Supabase Edge Function — atlas-enrich-profile (artificial caller / agent)
//
// The "fill the gaps" half of one-run profile generation. The Google spine
// (core fields, photos, rating, hours, editorial summary) is produced by the
// natural caller (business-create-unit). This agent layers the qualitative,
// multi-source intelligence the consumer venue-detail modal needs but Google
// doesn't expose cleanly:
//
//   details{}      dining style, dress code, service options, reservations,
//                  payment methods, parking, amenities, accessibility,
//                  dietary options, good-for, languages, kid/pet friendly
//   editorial      a synthesized one-paragraph summary
//   signals        zone, city, established_year, executive_chef
//   menus[]        menu sections + highlight items
//   popular_times  typical busy windows
//
// Source: Perplexity (Atlas "AI Answers" tier — web-grounded synthesis). It
// subsumes a raw SERP pass for these qualitative fields; Serper/Firecrawl
// menu scraping can be layered later. Photos stay Google-only upstream.
//
// Agent contract: verify_jwt=false at the gateway; requireInternalCaller
// gates the service-role bearer. Natural callers invoke via
// invokeArtificialCaller. Writes the venue row directly (service role) and
// stamps enriched_at + enrichment_sources provenance.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";

type Body = {
  venue_id?: string;
  // Context for the research prompt. The caller passes what Google already
  // resolved so Perplexity disambiguates the right place.
  name?: string;
  address?: string | null;
  city?: string | null;
  category?: string | null;
};

// The JSON shape we ask Perplexity to return. Everything is nullable / may be
// empty — the agent never invents ratings or reviewer quotes, only public
// venue metadata. Maps 1:1 onto migration 0039 columns + the details jsonb.
const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    zone: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    established_year: { type: ["integer", "null"] },
    executive_chef: { type: ["string", "null"] },
    editorial_summary: { type: ["string", "null"] },
    details: {
      type: "object",
      properties: {
        dining_style: { type: ["string", "null"] },
        dress_code: { type: ["string", "null"] },
        service_options: { type: "array", items: { type: "string" } },
        reservations: { type: ["string", "null"] },
        payment_methods: { type: "array", items: { type: "string" } },
        parking: { type: ["string", "null"] },
        amenities: { type: "array", items: { type: "string" } },
        accessibility: { type: "array", items: { type: "string" } },
        dietary_options: { type: "array", items: { type: "string" } },
        good_for: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        kid_friendly: { type: ["boolean", "null"] },
        pet_friendly: { type: ["boolean", "null"] },
      },
    },
    menus: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          items: { type: "array", items: { type: "string" } },
        },
      },
    },
    popular_times: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          range: { type: "string" },
        },
      },
    },
  },
} as const;

type ProfileResult = {
  zone?: string | null;
  city?: string | null;
  established_year?: number | null;
  executive_chef?: string | null;
  editorial_summary?: string | null;
  details?: Record<string, unknown> | null;
  menus?: unknown[] | null;
  popular_times?: unknown[] | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const key = Deno.env.get("PERPLEXITY_KEY");
  if (!key) {
    return json({ ok: false, error: "PERPLEXITY_KEY not configured" }, 500);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const venueId = (body.venue_id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const admin = adminClient(envRes.env);

  // Resolve the research context from the row when the caller didn't pass it.
  let { name, address, city, category } = body;
  if (!name) {
    const { data } = await admin
      .from("venues")
      .select("name, address, city, category")
      .eq("id", venueId)
      .maybeSingle();
    if (!data) return json({ ok: false, error: "Venue not found" }, 404);
    name = data.name;
    address = address ?? data.address;
    city = city ?? data.city;
    category = category ?? data.category;
  }

  // ── Perplexity synthesis ────────────────────────────────────────────────
  const locationLine = [address, city].filter(Boolean).join(", ");
  const userPrompt =
    `Research the venue "${name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `. Return its public profile as strict JSON matching the schema. ` +
    `For details, list real-world attributes only. Use null or [] for ` +
    `anything you cannot verify from public sources. Never invent ratings, ` +
    `reviewer quotes, or chef names you can't confirm.`;

  let parsed: ProfileResult | null = null;
  let rawContent = "";
  try {
    const r = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are Mesita's venue-intelligence agent. You output only valid JSON matching the provided schema — no prose, no markdown fences. Prefer null/empty over guessing.",
          },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: PROFILE_SCHEMA },
        },
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      return json(
        { ok: false, error: `perplexity_http_${r.status}: ${text.slice(0, 200)}` },
        502,
      );
    }
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    rawContent = data.choices?.[0]?.message?.content ?? "";
    parsed = safeParseProfile(rawContent);
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : "perplexity_failed" },
      502,
    );
  }

  if (!parsed) {
    return json({ ok: false, error: "Could not parse Perplexity output" }, 502);
  }

  // ── Map → venue columns (all optional; only write what we got) ───────────
  const update: Record<string, unknown> = {
    enriched_at: new Date().toISOString(),
    enrichment_sources: { perplexity: { model: PERPLEXITY_MODEL, at: new Date().toISOString() } },
  };
  if (parsed.zone) update.zone = parsed.zone;
  if (parsed.city) update.city = parsed.city;
  if (typeof parsed.established_year === "number") {
    update.established_year = parsed.established_year;
  }
  if (parsed.executive_chef) update.executive_chef = parsed.executive_chef;
  if (parsed.editorial_summary) update.editorial_summary = parsed.editorial_summary;
  if (parsed.details && typeof parsed.details === "object") {
    update.details = parsed.details;
  }
  if (Array.isArray(parsed.menus) && parsed.menus.length > 0) {
    update.menus = parsed.menus;
  }
  if (Array.isArray(parsed.popular_times) && parsed.popular_times.length > 0) {
    update.popular_times = parsed.popular_times;
  }

  const { error: updErr } = await admin
    .from("venues")
    .update(update)
    .eq("id", venueId);
  if (updErr) {
    return json({ ok: false, error: `venue_update: ${updErr.message}` }, 500);
  }

  return json({
    ok: true,
    venue_id: venueId,
    fields_filled: Object.keys(update).filter(
      (k) => k !== "enriched_at" && k !== "enrichment_sources",
    ),
    caller: callerRes.callerName,
  });
});

// Perplexity is asked for raw JSON, but defensively strip markdown fences and
// grab the outermost {...} so a stray prose wrapper doesn't break parsing.
function safeParseProfile(content: string): ProfileResult | null {
  if (!content) return null;
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1)) as ProfileResult;
  } catch {
    return null;
  }
}
