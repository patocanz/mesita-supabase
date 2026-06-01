// Supabase Edge Function — atlas-save-venue-media (artificial caller / async)
//
// Receives gathered source image URLs + metadata from Atlas enrichment, stores
// metadata rows immediately, then mirrors assets to Supabase Storage in the
// background. Venue creation/enrichment should stay fast: runtime keeps source
// URLs, while this function persists durable media paths asynchronously.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";

const IMAGE_BUCKET = "venue-images";
const MAX_ASSETS = 120;
const MAX_FETCH_BYTES = 12_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const VENUE_PHOTOS_CAP = 50;

type SourceKind = "google" | "website" | "instagram";

type Body = {
  venue_id?: string;
  assets?: Array<{
    source?: SourceKind;
    source_url?: string;
    likes_count?: number | null;
    caption?: string | null;
    analysis?: string | null;
    source_metadata?: Record<string, unknown> | null;
  }>;
  preferred_photo_urls?: string[];
};

type AssetRow = {
  source: SourceKind;
  source_url: string;
  likes_count: number | null;
  caption: string | null;
  analysis_text: string | null;
  source_metadata: Record<string, unknown> | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const venueId = typeof bodyRes.body.venue_id === "string" ? bodyRes.body.venue_id.trim() : "";
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const assets = sanitiseAssets(bodyRes.body.assets ?? []);
  const preferredPhotoUrls = sanitiseUrls(bodyRes.body.preferred_photo_urls ?? []);
  if (assets.length === 0) {
    return json({ ok: true, queued: 0, caller: callerRes.callerName });
  }

  const admin = adminClient(envRes.env);
  const upsertRows = assets.map((a) => ({
    venue_id: venueId,
    source: a.source,
    source_url: a.source_url,
    status: "pending",
    likes_count: a.likes_count,
    caption: a.caption,
    analysis_text: a.analysis_text,
    source_metadata: a.source_metadata,
    last_error: null,
  }));

  const { error: upsertErr } = await admin
    .from("venue_media_assets")
    .upsert(upsertRows, { onConflict: "venue_id,source_url" });
  if (upsertErr) {
    return json({ ok: false, error: `media_upsert: ${upsertErr.message}` }, 500);
  }

  const task = processAssetsInBackground(
    admin,
    envRes.env.url,
    venueId,
    assets,
    preferredPhotoUrls,
  );

  const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(task);
  } else {
    // Fallback best-effort background kick when waitUntil is unavailable.
    void task;
  }

  return json({
    ok: true,
    queued: assets.length,
    preferred: preferredPhotoUrls.length,
    caller: callerRes.callerName,
  });
});

async function processAssetsInBackground(
  admin: ReturnType<typeof adminClient>,
  supabaseUrl: string,
  venueId: string,
  assets: AssetRow[],
  preferredPhotoUrls: string[],
) {
  const mirroredBySource = new Map<string, string>();

  for (const asset of assets) {
    const mirrored = await mirrorOne(admin, supabaseUrl, venueId, asset.source_url, asset.source);
    mirroredBySource.set(asset.source_url, mirrored.url);
    const { error } = await admin
      .from("venue_media_assets")
      .update({
        status: mirrored.ok ? "saved" : "failed",
        image_id: mirrored.imageId,
        storage_path: mirrored.path,
        public_url: mirrored.publicUrl,
        mime_type: mirrored.contentType,
        bytes: mirrored.bytes,
        last_error: mirrored.error,
      })
      .eq("venue_id", venueId)
      .eq("source_url", asset.source_url);
    if (error) {
      console.error("[atlas-save-venue-media] asset_update:", error.message);
    }
  }

  const preferred = preferredPhotoUrls.length > 0
    ? preferredPhotoUrls
    : assets.map((a) => a.source_url);
  const finalPhotos = dedup(
    preferred.map((url) => mirroredBySource.get(url) ?? url),
  ).slice(0, VENUE_PHOTOS_CAP);
  if (finalPhotos.length === 0) return;

  const { error: venueErr } = await admin
    .from("venues")
    .update({ photos: finalPhotos })
    .eq("id", venueId);
  if (venueErr) {
    console.error("[atlas-save-venue-media] venue_update:", venueErr.message);
  }
}

async function mirrorOne(
  admin: ReturnType<typeof adminClient>,
  supabaseUrl: string,
  venueId: string,
  sourceUrl: string,
  source: SourceKind,
): Promise<{
  ok: boolean;
  url: string;
  imageId: string | null;
  path: string | null;
  publicUrl: string | null;
  contentType: string | null;
  bytes: number | null;
  error: string | null;
}> {
  const publicPrefix = `${supabaseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/`;
  if (sourceUrl.startsWith(publicPrefix)) {
    const existingPath = sourceUrl.slice(publicPrefix.length);
    return {
      ok: true,
      url: sourceUrl,
      imageId: imageIdFromPath(existingPath),
      path: existingPath,
      publicUrl: sourceUrl,
      contentType: null,
      bytes: null,
      error: null,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, { signal: ctrl.signal });
    if (!res.ok) {
      return {
        ok: false,
        url: sourceUrl,
        imageId: null,
        path: null,
        publicUrl: null,
        contentType: null,
        bytes: null,
        error: `fetch_http_${res.status}`,
      };
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return {
        ok: false,
        url: sourceUrl,
        imageId: null,
        path: null,
        publicUrl: null,
        contentType,
        bytes: null,
        error: "not_image",
      };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FETCH_BYTES) {
      return {
        ok: false,
        url: sourceUrl,
        imageId: null,
        path: null,
        publicUrl: null,
        contentType,
        bytes: bytes.byteLength,
        error: "invalid_size",
      };
    }

    const imageId = await hashBytes(bytes);
    const path = `images/${imageId}.${extFor(contentType)}`;
    const { error: uploadErr } = await admin.storage
      .from(IMAGE_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });
    if (uploadErr) {
      return {
        ok: false,
        url: sourceUrl,
        imageId: null,
        path: null,
        publicUrl: null,
        contentType,
        bytes: bytes.byteLength,
        error: `upload_${uploadErr.message}`,
      };
    }
    const publicUrl = `${publicPrefix}${path}`;
    return {
      ok: true,
      url: publicUrl,
      imageId,
      path,
      publicUrl,
      contentType,
      bytes: bytes.byteLength,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      url: sourceUrl,
      imageId: null,
      path: null,
      publicUrl: null,
      contentType: null,
      bytes: null,
      error: err instanceof Error ? err.message : "fetch_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

function sanitiseAssets(input: Body["assets"]): AssetRow[] {
  if (!Array.isArray(input)) return [];
  const out: AssetRow[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const source = row.source;
    const sourceUrl = typeof row.source_url === "string" ? row.source_url.trim() : "";
    if (!source || !isSource(source) || !isHttpUrl(sourceUrl) || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    out.push({
      source,
      source_url: sourceUrl,
      likes_count: toNullableInt(row.likes_count),
      caption: optText(row.caption, 2000),
      analysis_text: optText(row.analysis, 4000),
      source_metadata:
        row.source_metadata && typeof row.source_metadata === "object" && !Array.isArray(row.source_metadata)
          ? (row.source_metadata as Record<string, unknown>)
          : null,
    });
    if (out.length >= MAX_ASSETS) break;
  }
  return out;
}

function sanitiseUrls(input: string[]): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function isSource(v: string): v is SourceKind {
  return v === "google" || v === "website" || v === "instagram";
}

function toNullableInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.trunc(v));
}

function optText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function extFor(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("avif")) return "avif";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

async function hashBytes(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function imageIdFromPath(path: string): string | null {
  const filename = path.split("/").pop() ?? "";
  const candidate = filename.includes(".")
    ? filename.slice(0, filename.lastIndexOf("."))
    : filename;
  if (/^[a-f0-9]{64}$/i.test(candidate)) return candidate.toLowerCase();
  return null;
}

function dedup(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
