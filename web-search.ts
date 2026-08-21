// Web search for Holly's "look it up before answering" capability.
//
// Backend: a self-hosted SearXNG instance (free, no per-query billing) reached
// over the loopback interface — see run-searxng.sh / the local.searxng
// LaunchAgent in /path/to/searxng. The endpoint is read from the
// SEARXNG_URL env var (see .env), defaulting to http://127.0.0.1:8888. The
// backend is swappable: callers depend only on searchWeb() -> SearchResult[].
//
// SearXNG runs locally, so no Clash proxy is needed for this request itself;
// SearXNG's own outbound requests to Bing/Brave/etc. go through the system
// proxy (already configured on this Mac).

import { pathToFileURL } from "node:url";

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type SearchOptions = {
  topK?: number;
  timeoutMs?: number;
  gl?: string; // geo, e.g. "cn"
  hl?: string; // language, e.g. "zh-cn"
};

type SearxngResult = { title?: unknown; url?: unknown; content?: unknown };
type SearxngResponse = { results?: SearxngResult[] };

const OBITUARY_TERMS = /(?:逝世|去世|病逝|讣告|死亡)/u;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseSearxngResults(data: SearxngResponse, topK: number): SearchResult[] {
  return (data.results ?? [])
    .slice(0, topK)
    .map((item) => ({
      title: asText(item.title),
      url: asText(item.url),
      snippet: asText(item.content),
    }))
    .filter((result) => result.url);
}

function needsAuthoritativeObituaryFallback(query: string, results: readonly SearchResult[]): boolean {
  return OBITUARY_TERMS.test(query)
    && !/^!(?:360so|bd)\b/iu.test(query)
    && !results.some((result) => OBITUARY_TERMS.test(`${result.title} ${result.snippet}`));
}

function prioritizeObituaryResults(results: readonly SearchResult[]): SearchResult[] {
  const strongTerms = /(?:逝世|去世|病逝|讣告)/u;
  return [...results].sort((left, right) => {
    const leftStrong = strongTerms.test(`${left.title} ${left.snippet}`) ? 1 : 0;
    const rightStrong = strongTerms.test(`${right.title} ${right.snippet}`) ? 1 : 0;
    return rightStrong - leftStrong;
  });
}

function mergeSearchResults(
  preferred: readonly SearchResult[],
  fallback: readonly SearchResult[],
  topK: number,
): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const result of [...preferred, ...fallback]) {
    if (!merged.has(result.url)) merged.set(result.url, result);
    if (merged.size >= topK) break;
  }
  return Array.from(merged.values());
}

// Run a web search against the local SearXNG instance and return the top
// results. No proxy or API key needed — SearXNG is reached over loopback.
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  const baseUrl = (process.env.SEARXNG_URL?.trim() || DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
  const topK = options.topK ?? DEFAULT_TOP_K;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const request = async (query: string): Promise<SearchResult[]> => {
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", options.hl ?? "zh-CN");

      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`SearXNG ${response.status}: ${detail.slice(0, 200)}`);
      }
      return parseSearxngResults((await response.json()) as SearxngResponse, topK);
    };

    const primary = await request(cleanQuery);
    if (!needsAuthoritativeObituaryFallback(cleanQuery, primary)) return primary;

    // Broad Chinese obituary wording can be swamped by generic date pages in
    // Bing. SearXNG bang shortcuts let us explicitly ask its alternate Chinese
    // engines even though they are disabled from the default aggregate. Query
    // both concurrently, prioritize real obituary wording, and retain the
    // primary results as a tail fallback. Alternate-engine failures must not
    // discard a successful primary search.
    try {
      const fallbackTerms = cleanQuery.replace(/["“”]/gu, " ").replace(/\s+/gu, " ").trim();
      const alternateAttempts = await Promise.allSettled([
        request(`!360so ${fallbackTerms}`),
        request(`!bd ${fallbackTerms}`),
      ]);
      const alternate = prioritizeObituaryResults(
        alternateAttempts.flatMap((attempt) => attempt.status === "fulfilled" ? attempt.value : []),
      );
      return mergeSearchResults(alternate, primary, topK);
    } catch {
      return primary;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.log('用法: npm run search:test "查询词"');
    process.exit(0);
  }
  const startedAt = Date.now();
  const results = await searchWeb(query);
  console.log(`搜索「${query}」→ ${results.length} 条 (${Date.now() - startedAt}ms)\n`);
  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}\n`);
  }
}

// Run main() only when executed directly (not when imported as a library).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
