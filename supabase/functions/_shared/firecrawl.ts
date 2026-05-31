// Shared Firecrawl helpers. Both the venue create path (business-create-unit)
// and the enricher (atlas-enrich-profile) hit the same two Firecrawl endpoints
// with the same auth + timeout boilerplate; this is the one place that knows
// how to call them. All calls are best-effort — a missing key, a slow page, or
// a non-2xx response returns null/[] so callers degrade gracefully.

const SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const SEARCH_URL = "https://api.firecrawl.dev/v1/search";

export type FirecrawlScrapeOpts = {
  formats?: string[];
  onlyMainContent?: boolean;
  excludeTags?: string[];
  // Firecrawl-side render timeout (ms), passed through to the API.
  timeout?: number;
  // Our own abort timeout (ms) so a hung connection can't stall the EF.
  signalTimeoutMs?: number;
};

export type FirecrawlScrape = {
  markdown: string;
  html: string;
  links: string[];
  metadata: Record<string, unknown>;
};

// Scrape one URL. Returns the raw fields (markdown / links / metadata); callers
// slice and pick what they need. null on any failure.
export async function firecrawlScrape(
  apiKey: string | undefined,
  url: string | undefined,
  opts: FirecrawlScrapeOpts = {},
): Promise<FirecrawlScrape | null> {
  if (!apiKey || !url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.signalTimeoutMs ?? 30000);
  try {
    const body: Record<string, unknown> = {
      url,
      formats: opts.formats ?? ["markdown"],
      onlyMainContent: opts.onlyMainContent ?? true,
    };
    if (opts.excludeTags) body.excludeTags = opts.excludeTags;
    if (opts.timeout) body.timeout = opts.timeout;
    const r = await fetch(SCRAPE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      data?: {
        markdown?: string;
        html?: string;
        links?: string[];
        metadata?: Record<string, unknown>;
      };
    };
    return {
      markdown: d.data?.markdown ?? "",
      html: d.data?.html ?? "",
      links: Array.isArray(d.data?.links) ? (d.data!.links as string[]) : [],
      metadata: d.data?.metadata ?? {},
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Web search. Returns the result URLs, best-first. [] on any failure.
export async function firecrawlSearch(
  apiKey: string,
  query: string,
  limit = 8,
): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    // Response shape drifted: the current /v1/search API nests results by source
    // under `data` ({ web: [...], news: [...], images: [...] }). Older shapes put
    // a flat array on `data` or `results`. Accept all three so discovery keeps
    // working across versions — web first (what channel discovery wants), then
    // news/images as a fallback.
    const d = (await r.json()) as {
      data?: unknown[] | { web?: unknown[]; news?: unknown[]; images?: unknown[] };
      results?: unknown[];
    };
    const collect = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    let arr: unknown[];
    if (Array.isArray(d.data)) {
      arr = d.data;
    } else if (d.data && typeof d.data === "object") {
      arr = [...collect(d.data.web), ...collect(d.data.news), ...collect(d.data.images)];
    } else {
      arr = collect(d.results);
    }
    return arr
      .map((x) =>
        x && typeof (x as { url?: unknown }).url === "string" ? (x as { url: string }).url : "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}
