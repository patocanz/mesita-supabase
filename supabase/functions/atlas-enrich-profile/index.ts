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

const CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    instagram_url: { type: ["string", "null"] },
    facebook_url: { type: ["string", "null"] },
    website_url: { type: ["string", "null"] },
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

  const sources: Record<string, unknown> = {};
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };

  // ── Channel discovery ────────────────────────────────────────────────────
  // The columns may already carry socials harvested from the venue's website
  // at create time (business-create-unit walks the site's outbound links).
  // But that only works when the site links its own socials — many don't. So
  // for any channel still missing, ask Perplexity to resolve the canonical
  // URL from search, then host-validate it before trusting it: an LLM must
  // never hand us a fabricated handle we'd waste an Apify run scraping.
  let resolvedInstagram =
    typeof row.instagram_url === "string" && row.instagram_url
      ? row.instagram_url
      : null;
  let resolvedFacebook =
    typeof row.facebook_url === "string" && row.facebook_url
      ? row.facebook_url
      : null;
  let resolvedWebsite =
    typeof row.website_url === "string" && row.website_url
      ? row.website_url
      : null;

  if (
    PERPLEXITY_KEY &&
    (!resolvedInstagram || !resolvedFacebook || !resolvedWebsite)
  ) {
    const discoveryLocation = [row.address, row.city].filter(Boolean).join(", ");
    const found = await discoverChannels(
      PERPLEXITY_KEY,
      row.name as string,
      discoveryLocation,
      (row.category as string | null) ?? null,
    );
    if (found) {
      if (!resolvedInstagram && found.instagram_url) {
        resolvedInstagram = found.instagram_url;
      }
      if (!resolvedFacebook && found.facebook_url) {
        resolvedFacebook = found.facebook_url;
      }
      if (!resolvedWebsite && found.website_url) {
        resolvedWebsite = found.website_url;
      }
      sources.discovery = {
        ok: true,
        instagram: !!found.instagram_url,
        facebook: !!found.facebook_url,
        website: !!found.website_url,
      };
    } else {
      sources.discovery = { ok: false };
    }
  }

  // Persist any newly resolved channel so future reads + re-runs have them.
  if (resolvedInstagram && resolvedInstagram !== row.instagram_url) {
    update.instagram_url = resolvedInstagram;
  }
  if (resolvedFacebook && resolvedFacebook !== row.facebook_url) {
    update.facebook_url = resolvedFacebook;
  }
  if (resolvedWebsite && resolvedWebsite !== row.website_url) {
    update.website_url = resolvedWebsite;
  }

  // Only reach for Serper when Google Places came back thin — no rating, no
  // editorial summary, or no website. Otherwise the Google spine already
  // covers the SERP-level facts and we skip the extra call.
  const googleThin =
    row.google_stars_overall == null ||
    !row.editorial_summary ||
    !resolvedWebsite;

  // The external lookups are independent — run them concurrently so a slow
  // actor doesn't stack latency and push the agent past the EF wall.
  let igBio = "";
  let siteMarkdown = "";
  let serperText = "";
  const igHandle = instagramHandleFromUrl(resolvedInstagram);

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
      if (!APIFY_KEY || !resolvedFacebook) return;
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.facebookPages,
        { startUrls: [{ url: resolvedFacebook }] },
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
      if (!FIRECRAWL_KEY || !resolvedWebsite) return;
      try {
        const r = await fetch(FIRECRAWL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${FIRECRAWL_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: resolvedWebsite,
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

// Resolve a venue's canonical channel URLs from search. Perplexity is far
// better than raw SERP at "which Facebook page is this venue's" — but it's
// an LLM, so every URL it returns is host-validated before we trust it.
async function discoverChannels(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
): Promise<
  | {
      instagram_url: string | null;
      facebook_url: string | null;
      website_url: string | null;
    }
  | null
> {
  const prompt =
    `Find the official online presence of the venue "${name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `. Return strict JSON with the canonical URLs of its official Instagram ` +
    `profile, Facebook page, and website. Only return a URL you can verify ` +
    `from search results; use null when you are not confident. Never invent ` +
    `or guess a URL.`;
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
              "You resolve a venue's official channel URLs from search. Output only valid JSON matching the schema. Prefer null over guessing. Never fabricate URLs.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: CHANNELS_SCHEMA },
        },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const parsed = safeParseProfile(data.choices?.[0]?.message?.content ?? "") as
      | { instagram_url?: unknown; facebook_url?: unknown; website_url?: unknown }
      | null;
    if (!parsed) return null;
    return {
      instagram_url: validHost(parsed.instagram_url, ["instagram.com"]),
      facebook_url: validHost(parsed.facebook_url, ["facebook.com", "fb.com"]),
      website_url: validHost(parsed.website_url, null),
    };
  } catch {
    return null;
  }
}

// Accept a string only if it parses as an http(s) URL. When `allowed` is set
// the host must match one of those domains (or a subdomain) AND carry a path
// beyond "/" — guards against an LLM handing back a bare "facebook.com" or a
// hallucinated host. `allowed = null` accepts any web host (used for website).
function validHost(v: unknown, allowed: string[] | null): string | null {
  if (typeof v !== "string" || !v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (allowed) {
    const match = allowed.some((a) => h === a || h.endsWith(`.${a}`));
    if (!match) return null;
    if (u.pathname === "/" || u.pathname === "") return null;
  }
  return u.toString();
}

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
