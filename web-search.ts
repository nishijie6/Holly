// Web search for Holly's "look it up before answering" capability.
//
// Backend: Serper.dev (Google results as clean JSON). The API key is read from
// the SERPER_API_KEY env var (see .env, gitignored) — never from config.yaml,
// which is committed. The backend is swappable: callers depend only on
// searchWeb() -> SearchResult[], so moving to Brave/DuckDuckGo later is one file.
//
// From mainland China the request must traverse the Clash proxy. Inside the bot
// that's already set up by applyProxyConfig at bootstrap; the standalone CLI
// applies it from config.yaml itself (applyProxyFromConfig below).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = existsSync(join(process.cwd(), "package.json")) ? process.cwd() : __dirname;
const CONFIG_PATH = join(APP_ROOT, "config.yaml");

const SERPER_ENDPOINT = "https://google.serper.dev/search";
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

type SerperOrganic = { title?: unknown; link?: unknown; snippet?: unknown };
type SerperResponse = { organic?: SerperOrganic[]; answerBox?: { snippet?: unknown }; message?: unknown };

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Run a web search and return the top organic results. Relies on the ambient
// proxy env (HTTP_PROXY + NODE_USE_ENV_PROXY) already being set — by the bot's
// bootstrap, or by the CLI's applyProxyFromConfig.
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not set (put it in .env or the environment).");
  }
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  const topK = options.topK ?? DEFAULT_TOP_K;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: cleanQuery,
        num: topK,
        gl: options.gl ?? "cn",
        hl: options.hl ?? "zh-cn",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Serper ${response.status}: ${detail.slice(0, 200)}`);
    }

    const data = (await response.json()) as SerperResponse;
    return (data.organic ?? [])
      .slice(0, topK)
      .map((item) => ({
        title: asText(item.title),
        url: asText(item.link),
        snippet: asText(item.snippet),
      }))
      .filter((result) => result.url);
  } finally {
    clearTimeout(timer);
  }
}

// Standalone CLI only: set the outbound proxy from config.yaml so Serper is
// reachable from China. No-op inside the bot (bootstrap already set the env).
function applyProxyFromConfig(configPath: string): void {
  try {
    if (!existsSync(configPath)) return;
    const config = YAML.parse(readFileSync(configPath, "utf-8")) as { fetch?: { proxy_url?: string } } | null;
    const proxyUrl = config?.fetch?.proxy_url?.trim();
    if (!proxyUrl) return;
    process.env.HTTPS_PROXY ||= proxyUrl;
    process.env.HTTP_PROXY ||= proxyUrl;
    process.env.https_proxy ||= proxyUrl;
    process.env.http_proxy ||= proxyUrl;
  } catch {
    // best effort
  }
}

async function main(): Promise<void> {
  applyProxyFromConfig(CONFIG_PATH);
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
