// Shared embedding + ranking helpers for any EF that runs RAG over venues.
//
// Lives in _shared/ rather than an artificial-caller EF because the helpers
// are pure or near-pure (a SHA-1 digest, a cosine, an OpenAI HTTP call). The
// orchestration that ties them together — candidate-pool query, lazy backfill
// loop, intent composition, diversity trim — lives in the `recommender-*`
// artificial-caller EFs that import this module.
//
// Used by: consumer-recommend-deck, consumer-recommend-catalog, and any future
// recommender-* artificial caller.

import type { createClient } from "jsr:@supabase/supabase-js@2";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

// Structural type satisfied by every EF's VenueRow definition. Only the
// fields used for source-text + persistence are required; readers may carry
// arbitrary extra columns.
export type EmbeddableVenue = {
  id: string;
  name: string;
  category: string | null;
  vibe: string | null;
  pitch: string | null;
  story: string | null;
  address: string | null;
  price_level: number | null;
  embedding: unknown | null;
  embedding_source_hash: string | null;
};

// Stable source text we feed to the embedder. Order matters — name first so
// the model anchors on identity, then the soft descriptors. Story is hard-
// capped so a freakishly long story can't dominate the embedding budget.
export function venueSourceText(v: EmbeddableVenue): string {
  const lines: string[] = [];
  lines.push(`Name: ${v.name}`);
  if (v.category) lines.push(`Category: ${v.category}`);
  if (v.vibe) lines.push(`Vibe: ${v.vibe}`);
  if (v.pitch) lines.push(`Pitch: ${v.pitch}`);
  if (v.story) lines.push(`Story: ${v.story.slice(0, 700)}`);
  if (v.address) lines.push(`Address: ${v.address}`);
  if (v.price_level != null) lines.push(`Price level: ${v.price_level}/4`);
  return lines.join("\n");
}

// Cheap stable hash of the source text so we can detect "this venue's text
// changed, re-embed" without storing the whole text alongside the embedding.
export async function digest(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function shouldEmbed(v: EmbeddableVenue): boolean {
  if (!v.embedding) return true;
  return v.embedding_source_hash == null;
}

// pgvector accepts vectors as text literals like "[0.01,0.02,...]". We build
// that here so the .update() call sends a plain string (supabase-js doesn't
// have a vector binder).
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}

// pgvector via supabase-js may arrive already typed when a row was patched
// locally from an embed call; otherwise it's the "[a,b,c]" text literal.
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== "string") return null;
  const inner = v.slice(v.startsWith("[") ? 1 : 0, v.endsWith("]") ? -1 : undefined);
  if (!inner) return null;
  const arr = inner.split(",").map((s) => Number(s));
  for (const n of arr) if (!Number.isFinite(n)) return null;
  return arr;
}

// text-embedding-3-small returns unit-length vectors, so dot product is
// already the cosine.
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export function rankByCosine<T extends { embedding: unknown }>(
  rows: T[],
  queryVec: number[],
): T[] {
  const scored = rows.map((r) => {
    const v = parseVector(r.embedding);
    const score = v ? cosineSim(v, queryVec) : -1; // no embedding → tail
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}

export async function embedSingle(text: string, apiKey: string): Promise<number[]> {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
  const data = (await r.json()) as { data?: { embedding: number[] }[] };
  const v = data.data?.[0]?.embedding;
  if (!v || v.length !== EMBEDDING_DIMS) throw new Error("embed: bad shape");
  return v;
}

export async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`embedBatch HTTP ${r.status}`);
  const data = (await r.json()) as { data?: { embedding: number[]; index: number }[] };
  const out: number[][] = new Array(texts.length);
  for (const d of data.data ?? []) out[d.index] = d.embedding;
  return out;
}

// Lazy-embeds + persists a slice of venues. Returns a map of venue.id →
// { embedding, hash } for every row that landed; the caller patches its
// local rows from this map so we never need a re-SELECT after writing.
export async function embedAndPersistVenues<T extends EmbeddableVenue>(
  rows: T[],
  admin: ReturnType<typeof createClient>,
  apiKey: string,
  logPrefix: string,
): Promise<Map<string, { embedding: number[]; hash: string }>> {
  const inputs = await Promise.all(rows.map(async (r) => {
    const text = venueSourceText(r);
    return { id: r.id, text, hash: await digest(text) };
  }));
  const out = new Map<string, { embedding: number[]; hash: string }>();
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: inputs.map((i) => i.text),
      }),
    });
    if (!r.ok) {
      console.error(`[${logPrefix}] batch-embed HTTP`, r.status, (await r.text()).slice(0, 240));
      return out;
    }
    const data = (await r.json()) as { data?: { embedding: number[]; index: number }[] };
    const byIdx = new Map<number, number[]>();
    for (const d of data.data ?? []) byIdx.set(d.index, d.embedding);

    // N updates in parallel — PostgREST handles 50 concurrent single-row
    // updates fine, and serialising would dominate the EF budget.
    await Promise.all(inputs.map(async (inp, i) => {
      const v = byIdx.get(i);
      if (!v || v.length !== EMBEDDING_DIMS) return;
      const { error } = await admin
        .from("venues")
        .update({
          embedding: vectorLiteral(v),
          embedding_source_hash: inp.hash,
        })
        .eq("id", inp.id);
      if (error) {
        console.error(`[${logPrefix}] embed write:`, error.message);
        return;
      }
      out.set(inp.id, { embedding: v, hash: inp.hash });
    }));
    return out;
  } catch (err) {
    console.error(`[${logPrefix}] embed exception:`, err);
    return out;
  }
}
