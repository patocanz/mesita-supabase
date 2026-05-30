// Shared social/web channel URL classification + canonicalisation. Used by the
// venue create path (business-create-unit, which classifies a bag of links
// into channel columns) and the enricher (atlas-enrich-profile, which picks the
// canonical profile out of search results). Keeping the host table + URL
// normalisers in one place stops the two from drifting.

import { instagramHandleFromUrl } from "./apify.ts";

export type ChannelKey =
  | "website_url"
  | "instagram_url"
  | "facebook_url"
  | "tiktok_url"
  | "x_url"
  | "youtube_url"
  | "threads_url"
  | "reddit_url"
  | "whatsapp_url"
  | "opentable_url"
  | "resy_url"
  | "uber_eats_url"
  | "rappi_url"
  | "didi_food_url"
  | "tripadvisor_url"
  | "google_maps_url";

export type Channels = Record<ChannelKey, string | null>;

// Hostname → channel column. Accepts exact hostnames and subdomain matches
// (`m.facebook.com` → `facebook_url`). `tripadvisor` / `didi` rules are loose
// because the TLD varies by country (`.com`, `.com.mx`, `.es`, `.com.ar`).
export function matchChannel(host: string): ChannelKey | null {
  const h = host.replace(/^www\./, "").toLowerCase();
  if (h === "instagram.com" || h.endsWith(".instagram.com")) return "instagram_url";
  if (h === "facebook.com" || h.endsWith(".facebook.com")) return "facebook_url";
  if (h === "fb.com" || h.endsWith(".fb.com")) return "facebook_url";
  if (h === "tiktok.com" || h.endsWith(".tiktok.com")) return "tiktok_url";
  if (h === "twitter.com" || h.endsWith(".twitter.com")) return "x_url";
  if (h === "x.com" || h.endsWith(".x.com")) return "x_url";
  if (h === "youtube.com" || h.endsWith(".youtube.com")) return "youtube_url";
  if (h === "youtu.be") return "youtube_url";
  if (h === "threads.net" || h.endsWith(".threads.net")) return "threads_url";
  if (h === "threads.com" || h.endsWith(".threads.com")) return "threads_url";
  if (h === "reddit.com" || h.endsWith(".reddit.com")) return "reddit_url";
  if (h === "wa.me" || h.endsWith(".wa.me")) return "whatsapp_url";
  if (h === "whatsapp.com" || h.endsWith(".whatsapp.com")) return "whatsapp_url";
  if (h.startsWith("opentable.")) return "opentable_url";
  if (h === "resy.com" || h.endsWith(".resy.com")) return "resy_url";
  if (h === "ubereats.com" || h.endsWith(".ubereats.com")) return "uber_eats_url";
  if (h === "rappi.com" || h.endsWith(".rappi.com")) return "rappi_url";
  if (h.startsWith("rappi.com.")) return "rappi_url";
  if (h === "didi.com" || h.endsWith(".didi.com")) return "didi_food_url";
  if (h.startsWith("didifood.")) return "didi_food_url";
  if (h === "sindelantal.com.mx" || h.endsWith(".sindelantal.com.mx")) return "didi_food_url";
  if (h.startsWith("tripadvisor.")) return "tripadvisor_url";
  if (h === "google.com/maps" || h === "maps.google.com" || h.endsWith(".google.com/maps"))
    return "google_maps_url";
  if (h === "maps.app.goo.gl" || h === "goo.gl") return "google_maps_url";
  return null;
}

// Trim tracking junk + trailing slashes so two near-identical links from the
// same host collapse to one before we pick the shortest.
export function canonicaliseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const drop = ["ref", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid"];
    drop.forEach((k) => u.searchParams.delete(k));
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

// Classify a bag of links into channel columns, picking the shortest URL per
// channel (a heuristic for "profile root over deep link"; ties keep the first
// occurrence, which preserves Google-provided URIs over scraped ones).
export function classifyLinks(input: (string | null | undefined)[]): Channels {
  const buckets: Partial<Record<ChannelKey, string[]>> = {};
  const websiteCandidates: string[] = [];

  for (const raw of input) {
    if (!raw) continue;
    const url = canonicaliseUrl(raw);
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    const channel = matchChannel(host);
    if (channel) {
      (buckets[channel] ??= []).push(url);
    } else {
      websiteCandidates.push(url);
    }
  }

  const pickShortest = (arr: string[] | undefined): string | null => {
    if (!arr || arr.length === 0) return null;
    let best = arr[0];
    for (const v of arr) {
      if (v.length < best.length) best = v;
    }
    return best;
  };

  return {
    website_url: pickShortest(websiteCandidates),
    instagram_url: pickShortest(buckets.instagram_url),
    facebook_url: pickShortest(buckets.facebook_url),
    tiktok_url: pickShortest(buckets.tiktok_url),
    x_url: pickShortest(buckets.x_url),
    youtube_url: pickShortest(buckets.youtube_url),
    threads_url: pickShortest(buckets.threads_url),
    reddit_url: pickShortest(buckets.reddit_url),
    whatsapp_url: pickShortest(buckets.whatsapp_url),
    opentable_url: pickShortest(buckets.opentable_url),
    resy_url: pickShortest(buckets.resy_url),
    uber_eats_url: pickShortest(buckets.uber_eats_url),
    rappi_url: pickShortest(buckets.rappi_url),
    didi_food_url: pickShortest(buckets.didi_food_url),
    tripadvisor_url: pickShortest(buckets.tripadvisor_url),
    google_maps_url: pickShortest(buckets.google_maps_url),
  };
}

// Bare host (no www) of a URL, or null if unparseable.
export function domainOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Accept a string only if it parses as an http(s) URL. When `allowed` is set,
// the host must match one of those domains (or a subdomain) AND carry a path
// beyond "/" — guards against a bare host or a hallucinated one. `allowed=null`
// accepts any web host (used for resolving an arbitrary official website).
export function validHost(v: unknown, allowed: string[] | null): string | null {
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

// Canonical Facebook page URL from any FB link, rejecting non-page paths
// (photos, videos, events, share/login). profile.php?id= pages are kept.
export function facebookPageFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/^m\./, "")
    .replace(/^[a-z]{2}-[a-z]{2}\./, "");
  if (!(host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com")) {
    return null;
  }
  const seg = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!seg) return null;
  if (seg === "profile.php") {
    const id = u.searchParams.get("id");
    return id && /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : null;
  }
  const reserved = new Set([
    "photo.php", "photo", "photos", "watch", "events", "event", "videos", "video",
    "reel", "reels", "story.php", "stories", "sharer", "sharer.php", "login",
    "pages", "groups", "marketplace", "media", "people", "help", "policies",
    "permalink.php", "search", "hashtag", "p",
  ]);
  if (reserved.has(seg)) return null;
  return `https://www.facebook.com/${u.pathname.split("/").filter(Boolean)[0]}`;
}

// First search result that resolves to a real Instagram profile (skips /p/,
// /reel/, /explore/ etc. via instagramHandleFromUrl) → canonical URL.
export function pickInstagram(urls: string[]): string | null {
  for (const u of urls) {
    const handle = instagramHandleFromUrl(u);
    if (handle) return `https://www.instagram.com/${handle}`;
  }
  return null;
}

// First search result that resolves to a real Facebook page → canonical URL.
export function pickFacebook(urls: string[]): string | null {
  for (const u of urls) {
    const page = facebookPageFromUrl(u);
    if (page) return page;
  }
  return null;
}

// First search result that's a plausible official website: an http(s) URL
// whose host isn't a social network, directory, or aggregator.
export function pickWebsite(urls: string[]): string | null {
  const blocked = [
    "instagram.com", "facebook.com", "fb.com", "tiktok.com", "twitter.com",
    "x.com", "youtube.com", "youtu.be", "google.com", "goo.gl",
    "maps.app.goo.gl", "tripadvisor.com", "tripadvisor.com.mx", "yelp.com",
    "foursquare.com", "opentable.com", "opentable.com.mx", "wikipedia.org",
    "linktr.ee", "linkedin.com", "threads.net", "wa.me", "menudo.app",
  ];
  for (const u of urls) {
    const valid = validHost(u, null);
    if (!valid) continue;
    const h = domainOf(valid);
    if (!h) continue;
    if (blocked.some((b) => h === b || h.endsWith(`.${b}`))) continue;
    return valid;
  }
  return null;
}
