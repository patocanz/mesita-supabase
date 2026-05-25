// Supabase Edge Function — admin-snapshot-mesita
//
// Writes "Mesita snapshots" — periodic .txt dumps of Core's current
// venue profile state — to the atlas Storage bucket. Two modes:
//
//   POST { venueId: "<uuid>" }      → snapshots that one venue
//   POST { all: true }              → snapshots every venue (loops)
//
// Snapshot file lands at:
//   atlas/venues/{venue_id}/snapshots/mesita/{ISO}_{trigger}.txt
//
// Content is plain text — sections for each table — per the
// atlas-storage-rule memory (everything-as-text, no Storage object
// metadata). Append-only: never overwrites, never deletes.
//
// Auth: caller's JWT email must be in public.super_admins.
//
// This is the admin-triggered path. A nightly cron variant
// (system-snapshot-mesita-all-nightly) ships in a later PR once
// pg_cron is wired up.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = { venueId?: string; all?: boolean };

type VenueRow = {
  id: string;
  google_place_id: string | null;
  slug: string;
  name: string;
  category: string | null;
  vibe: string | null;
  price_level: number | null;
  listing_type: string;
  status: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  timezone: string | null;
  closes_at: string | null;
  phone: string | null;
  pitch: string | null;
  story: string | null;
  cashback_percent: number | null;
  photos: string[];
  created_at: string;
  updated_at: string;
};

const BUCKET = "atlas";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const emailLower = authRes.user.emailLower;
  if (!emailLower) {
    return json({ ok: false, error: "No email on session" }, 401);
  }

  const admin = adminClient(envRes.env);

  // super_admins gate.
  const { data: saRow } = await admin
    .from("super_admins")
    .select("email")
    .eq("email", emailLower)
    .maybeSingle();
  if (!saRow) {
    return json({ ok: false, error: "Not a super-admin" }, 403);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const isAll = body.all === true;
  const venueId = typeof body.venueId === "string" ? body.venueId : null;
  if (!isAll && !venueId) {
    return json(
      { ok: false, error: "Body must include either venueId or all:true" },
      400,
    );
  }

  // Fetch target venue rows.
  let query = admin
    .from("venues")
    .select(
      "id, google_place_id, slug, name, category, vibe, price_level, listing_type, status, lat, lng, address, timezone, closes_at, phone, pitch, story, cashback_percent, photos, created_at, updated_at",
    );
  if (!isAll && venueId) {
    query = query.eq("id", venueId);
  }
  const { data: venues, error: fetchErr } = await query;
  if (fetchErr) {
    return json(
      { ok: false, error: `venues_read: ${fetchErr.message}` },
      500,
    );
  }
  if (!venues || venues.length === 0) {
    return json(
      { ok: false, error: isAll ? "No venues to snapshot" : "Venue not found" },
      404,
    );
  }

  const isoNow = new Date().toISOString();
  const filenameTimestamp = isoNow.replace(/[:.]/g, "-");
  const trigger = isAll ? "admin-all" : "admin-one";

  const results: Array<{ venueId: string; path: string; ok: boolean; error?: string }> = [];

  for (const v of venues as VenueRow[]) {
    const body = renderMesitaSnapshot(v, isoNow, trigger);
    const path = `venues/${v.id}/snapshots/mesita/${filenameTimestamp}_${trigger}.txt`;
    const blob = new Blob([body], { type: "text/plain" });
    const { error: upErr } = await admin.storage.from(BUCKET).upload(path, blob, {
      contentType: "text/plain; charset=utf-8",
      upsert: false,
    });
    if (upErr) {
      results.push({ venueId: v.id, path, ok: false, error: upErr.message });
    } else {
      results.push({ venueId: v.id, path, ok: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return json({
    ok: failed.length === 0,
    snapshotsWritten: results.length - failed.length,
    snapshotsFailed: failed.length,
    results,
  });
});

function renderMesitaSnapshot(v: VenueRow, capturedAt: string, trigger: string): string {
  const lines: string[] = [];
  lines.push("================================================================");
  lines.push("Mesita Venue Snapshot");
  lines.push("================================================================");
  lines.push(`Venue ID:        ${v.id}`);
  lines.push(`Google place_id: ${v.google_place_id ?? "(none)"}`);
  lines.push(`Slug:            ${v.slug}`);
  lines.push(`Name:            ${v.name}`);
  lines.push(`Captured:        ${capturedAt}`);
  lines.push(`Trigger:         ${trigger}`);
  lines.push(`Source:          Core DB (public.venues)`);
  lines.push("");
  lines.push("----------------------------------------------------------------");
  lines.push("Context");
  lines.push("----------------------------------------------------------------");
  lines.push("Routine snapshot of the current canonical Mesita venue profile.");
  lines.push("Captured for: historical record, future-diff baseline, and");
  lines.push("              LLM pre-read context during research runs.");
  lines.push("Append-only — never overwrite, never delete.");
  lines.push("");
  lines.push("----------------------------------------------------------------");
  lines.push("public.venues");
  lines.push("----------------------------------------------------------------");
  lines.push(`status:             ${v.status}`);
  lines.push(`listing_type:       ${v.listing_type}`);
  lines.push(`category:           ${v.category ?? "(null)"}`);
  lines.push(`vibe:               ${v.vibe ?? "(null)"}`);
  lines.push(`price_level:        ${v.price_level ?? "(null)"}`);
  lines.push(`lat:                ${v.lat ?? "(null)"}`);
  lines.push(`lng:                ${v.lng ?? "(null)"}`);
  lines.push(`address:            ${v.address ?? "(null)"}`);
  lines.push(`timezone:           ${v.timezone ?? "(null)"}`);
  lines.push(`closes_at:          ${v.closes_at ?? "(null)"}`);
  lines.push(`phone:              ${v.phone ?? "(null)"}`);
  lines.push(`cashback_percent:   ${v.cashback_percent ?? "(null)"}`);
  lines.push(`photos (${v.photos.length}):`);
  for (const url of v.photos) lines.push(`  - ${url}`);
  if (v.photos.length === 0) lines.push("  (none)");
  lines.push("");
  lines.push("Long-form fields:");
  lines.push("");
  lines.push("[pitch]");
  lines.push(v.pitch ?? "(null)");
  lines.push("");
  lines.push("[story]");
  lines.push(v.story ?? "(null)");
  lines.push("");
  lines.push("----------------------------------------------------------------");
  lines.push("Timestamps");
  lines.push("----------------------------------------------------------------");
  lines.push(`created_at:    ${v.created_at}`);
  lines.push(`updated_at:    ${v.updated_at}`);
  lines.push("");
  lines.push("--- end of snapshot ---");
  return lines.join("\n");
}
