// Supabase Edge Function — atlas-enrich-profile (artificial caller / agent)
//
// The multi-source "fill the gaps" half of one-run profile generation. The
// Google spine (core fields, photos, rating, hours, reviews, editorial
// summary) is produced by the natural caller (business-create-unit). This
// agent layers every other Atlas-selected method onto the venue:
//
//   Apify       Instagram → followers + bio; Facebook → followers + rating
//   Firecrawl   website markdown → menu grounding
//   Perplexity  synthesized details{}, summary, zone/city, established_year,
//               executive_chef, menus[], popular_times[] — grounded on the
//               IG bio + Firecrawl site content so it structures real data
//               rather than guessing.
//
// Every source is best-effort and independent; whatever fails degrades to
// null. Photos stay Google-only upstream (Apify photos are a future source).
//
// Agent contract: verify_jwt=false; requireInternalCaller gates the
// service-role bearer. Invoked by business-create-unit (on create) and
// admin-enrich-venue (re-run). Writes the venue row + enrichment_sources.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  APIFY_ACTORS,
  instagramHandleFromUrl,
  runApifyActor,
} from "../_shared/apify.ts";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

type Body = { venue_id?: string };

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
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: ["string", "null"] },
                description: { type: ["string", "null"] },
              },
            },
          },
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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const venueId = (body.venue_id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const admin = adminClient(envRes.env);
  const { data: row } = await admin
    .from("venues")
    .select(
      "name, address, city, category, instagram_url, facebook_url, website_url, google_stars_overall, google_review_count, editorial_summary",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (!row) return json({ ok: false, error: "Venue not found" }, 404);

  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const APIFY_KEY = Deno.env.get("APIFY_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");
  const SERPER_KEY = Deno.env.get("SERPER_KEY");

  // Only reach for Serper when Google Places came back thin — no rating, no
  // editorial summary, or no website. Otherwise the Google spine already
  // covers the SERP-level facts and we skip the extra call.
  const googleThin =
    row.google_stars_overall == null ||
    !row.editorial_summary ||
    !row.website_url;

  const sources: Record<string, unknown> = {};
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };

  // The three external lookups are independent — run them concurrently so a
  // slow actor doesn't stack latency and push the agent past the EF wall.
  let igBio = "";
  let siteMarkdown = "";
  let serperText = "";
  const igHandle = instagramHandleFromUrl(row.instagram_url as string | null);

  await Promise.all([
    // Serper → SERP knowledge panel, ONLY when Google came back thin. Used
    // purely as extra grounding for Perplexity, never as a rating source.
    (async () => {
      if (!SERPER_KEY || !googleThin) return;
      try {
        const q = [row.name, row.city].filter(Boolean).join(" ");
        const r = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ q, gl: "mx", hl: "es" }),
        });
        if (!r.ok) {
          sources.serper = { ok: false, status: r.status };
          return;
        }
        const d = (await r.json()) as {
          knowledgeGraph?: Record<string, unknown>;
          organic?: { snippet?: string }[];
        };
        const kg = d.knowledgeGraph ?? {};
        const kgLine = [
          typeof kg.title === "string" ? kg.title : "",
          typeof kg.type === "string" ? kg.type : "",
          typeof kg.description === "string" ? kg.description : "",
          typeof kg.address === "string" ? `Address: ${kg.address}` : "",
        ]
          .filter(Boolean)
          .join(". ");
        const snippets = (d.organic ?? [])
          .slice(0, 3)
          .map((o) => o.snippet)
          .filter((s): s is string => !!s)
          .join("\n");
        serperText = [kgLine, snippets].filter(Boolean).join("\n").slice(0, 3000);
        sources.serper = { ok: !!serperText, reason: "google_thin" };
      } catch {
        sources.serper = { ok: false };
      }
    })(),
    // Apify → Instagram (followers + bio).
    (async () => {
      if (!APIFY_KEY || !igHandle) return;
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.instagramProfile,
        { usernames: [igHandle] },
        APIFY_KEY,
      );
      const p = items?.[0];
      if (p) {
        const followers = numOf(p.followersCount);
        if (followers != null) update.instagram_followers_count = followers;
        if (typeof p.biography === "string") igBio = p.biography;
        sources.apify_instagram = { handle: igHandle, ok: true };
      } else {
        sources.apify_instagram = { handle: igHandle, ok: false };
      }
    })(),
    // Apify → Facebook (followers + rating).
    (async () => {
      if (!APIFY_KEY || typeof row.facebook_url !== "string" || !row.facebook_url) {
        return;
      }
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.facebookPages,
        { startUrls: [{ url: row.facebook_url }] },
        APIFY_KEY,
      );
      const p = items?.[0];
      if (p) {
        const followers = numOf(p.followers) ?? numOf(p.likes);
        const rating = numOf(p.rating) ?? numOf(p.overallStarRating);
        if (followers != null) update.facebook_followers = followers;
        if (rating != null && rating >= 0 && rating <= 5) {
          update.facebook_rating = rating;
        }
        sources.apify_facebook = { ok: true };
      } else {
        sources.apify_facebook = { ok: false };
      }
    })(),
    // Firecrawl → website markdown (menu grounding).
    (async () => {
      if (!FIRECRAWL_KEY || typeof row.website_url !== "string" || !row.website_url) {
        return;
      }
      try {
        const r = await fetch(FIRECRAWL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${FIRECRAWL_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: row.website_url,
            formats: ["markdown"],
            onlyMainContent: true,
          }),
        });
        if (r.ok) {
          const data = (await r.json()) as { data?: { markdown?: string } };
          siteMarkdown = (data.data?.markdown ?? "").slice(0, 6000);
          sources.firecrawl = { ok: !!siteMarkdown };
        } else {
          sources.firecrawl = { ok: false };
        }
      } catch {
        sources.firecrawl = { ok: false };
      }
    })(),
  ]);

  // ── Perplexity: grounded synthesis ──────────────────────────────────────
  if (!PERPLEXITY_KEY) {
    return json({ ok: false, error: "PERPLEXITY_KEY not configured" }, 500);
  }
  const locationLine = [row.address, row.city].filter(Boolean).join(", ");
  const grounding = [
    igBio ? `Instagram bio: ${igBio}` : "",
    serperText ? `Search results:\n${serperText}` : "",
    siteMarkdown ? `Website content (excerpt):\n${siteMarkdown}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userPrompt =
    `Research the venue "${row.name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (row.category ? ` (category: ${row.category})` : "") +
    `. Return its public profile as strict JSON matching the schema. Extract ` +
    `the menu from the website content below when present (real dish names + ` +
    `prices only). Use null or [] for anything you cannot verify. Never ` +
    `invent ratings, reviewer quotes, prices, or a chef's name.` +
    (grounding ? `\n\n--- SOURCE MATERIAL ---\n${grounding}` : "");

  let parsed: ProfileResult | null = null;
  try {
    const r = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are Mesita's venue-intelligence agent. Output only valid JSON matching the provided schema — no prose, no markdown fences. Prefer null/empty over guessing.",
          },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: PROFILE_SCHEMA },
        },
      }),
    });
    if (r.ok) {
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      parsed = safeParseProfile(data.choices?.[0]?.message?.content ?? "");
      sources.perplexity = { model: PERPLEXITY_MODEL, ok: !!parsed };
    } else {
      sources.perplexity = { ok: false, status: r.status };
    }
  } catch {
    sources.perplexity = { ok: false };
  }

  if (parsed) {
    if (parsed.zone) update.zone = parsed.zone;
    if (parsed.city) update.city = parsed.city;
    if (typeof parsed.established_year === "number") {
      update.established_year = parsed.established_year;
    }
    if (parsed.executive_chef) update.executive_chef = parsed.executive_chef;
    if (parsed.editorial_summary) {
      update.editorial_summary = parsed.editorial_summary;
    }
    if (parsed.details && typeof parsed.details === "object") {
      update.details = parsed.details;
    }
    if (Array.isArray(parsed.menus) && parsed.menus.length > 0) {
      update.menus = parsed.menus;
    }
    if (Array.isArray(parsed.popular_times) && parsed.popular_times.length > 0) {
      update.popular_times = parsed.popular_times;
    }
  }

  update.enrichment_sources = sources;

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
    sources,
    fields_filled: Object.keys(update).filter(
      (k) => k !== "enriched_at" && k !== "enrichment_sources",
    ),
    caller: callerRes.callerName,
  });
});

function numOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

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
