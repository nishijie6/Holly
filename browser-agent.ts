import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { WebSocket } from "ws";

import { searchWeb, type SearchResult } from "./web-search.js";

export type BrowserAgentConfig = {
  enabled: boolean;
  executablePath: string | null;
  proxyUrl: string | null;
  searchTopK: number;
  maxPages: number;
  timeoutMs: number;
  launchTimeoutMs: number;
  contentMaxChars: number;
};

export type BrowserPageLink = {
  text: string;
  url: string;
};

export type BrowserPageObservation = {
  title: string;
  url: string;
  excerpt: string;
  // Article links found inside the content area, so downstream consumers can
  // cite an item's own detail page instead of a listing/homepage URL.
  links?: BrowserPageLink[];
  error?: string;
};

export type BrowserTopicObservation = {
  query: string;
  pages: BrowserPageObservation[];
  summary: string;
};

type PendingCdpCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type OpenedTarget = {
  id: string;
  webSocketDebuggerUrl: string;
};

const DEFAULT_PAGE_LOAD_SETTLE_MS = 800;
type BrowserProcess = ChildProcessByStdio<null, Readable, Readable>;

// A normal desktop-Chrome UA. Headless Chrome's default UA carries
// "HeadlessChrome/…", which Reddit and other sites use to serve block pages;
// override it on every navigation. Kept in sync with fetchUrlContent in main.ts.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Injected into every new document before page scripts run. CDP-driven browsers
// set navigator.webdriver = true, which bot detectors (Reddit included) key on.
const STEALTH_SCRIPT = [
  "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
  "Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });",
].join("\n");

// Pull readable text instead of the raw body: strip scripts, page chrome
// (nav/header/footer/aside/forms) and cookie-consent/GDPR banners, then prefer
// <main>/<article>. A plain body.innerText otherwise captures cookie walls and
// nav menus as the "content", which then condenses to nothing useful downstream.
// Mutates the page, but it's a throwaway tab closed right after this read. Falls
// back to the full body if the trimmed root came out too short.
// Also collects article links from the content area (anchors with real title
// text, after page chrome was stripped) so listing pages yield each item's own
// detail URL instead of only the listing/homepage URL.
const CONTENT_EXTRACTION_EXPRESSION = `(() => {
  try {
    document.querySelectorAll('script,style,noscript,template,nav,header,footer,aside,form,[role="navigation"],[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i]').forEach((el) => el.remove());
  } catch (_) { /* best effort */ }
  const body = document.body;
  const root = document.querySelector('main, article') || body;
  const scoped = root ? (root.innerText || root.textContent || "") : "";
  const full = body ? (body.innerText || body.textContent || "") : "";
  const text = scoped.trim().length >= 200 ? scoped : full;
  const links = [];
  try {
    const seen = new Set();
    const currentUrl = location.href.split('#')[0];
    const anchors = (root || document).querySelectorAll('a[href]');
    for (const anchor of anchors) {
      if (links.length >= 20) break;
      const label = (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim();
      if (label.length < 6) continue;
      const href = (anchor.href || '').split('#')[0];
      if (!/^https?:/i.test(href) || href === currentUrl) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({ text: label.slice(0, 80), url: href });
    }
  } catch (_) { /* best effort */ }
  return JSON.stringify({ title: document.title || "", url: location.href, text: text, links: links });
})()`;

// Diagnostic emitted per page so callers can surface why a read produced no
// usable text (hard error vs. empty body) instead of a silent overall null.
export type BrowserPageDiagnostic = {
  url: string;
  status: "empty" | "error";
  detail: string;
};
export type BrowserAgentLogger = (diagnostic: BrowserPageDiagnostic) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

// old.reddit.com is plain server-rendered HTML with far weaker bot detection
// than the www React SPA, so headless reads land actual post text. Media hosts
// (i.redd.it, v.redd.it) don't match reddit.com and are left untouched.
function rewriteForReadability(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (/(^|\.)reddit\.com$/i.test(url.hostname) && url.hostname !== "old.reddit.com") {
      url.hostname = "old.reddit.com";
      return url.toString();
    }
  } catch {
    // Not a parseable URL; navigate as-is.
  }
  return rawUrl;
}

function findBrowserExecutable(configured: string | null): string | null {
  const candidates = [
    configured,
    process.env.BROWSER_AGENT_CHROME_PATH,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function browserHttpOrigin(browserWsEndpoint: string): string {
  const url = new URL(browserWsEndpoint);
  return `http://${url.host}`;
}

function waitForDevtoolsEndpoint(
  proc: BrowserProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      proc.stdout.off("data", onData);
      proc.stderr.off("data", onData);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    };

    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Browser exited before DevTools endpoint was ready (code=${code ?? "null"}).`));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for browser DevTools endpoint after ${timeoutMs}ms.`));
    }, timeoutMs);

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

async function launchBrowser(config: BrowserAgentConfig): Promise<{
  proc: BrowserProcess;
  httpOrigin: string;
  userDataDir: string;
}> {
  const executable = findBrowserExecutable(config.executablePath);
  if (!executable) {
    throw new Error("No Chrome/Edge executable found. Set browser_agent.executable_path or BROWSER_AGENT_CHROME_PATH.");
  }

  const userDataDir = await mkdtemp(join(tmpdir(), "tsbot-browser-agent-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    ...(config.proxyUrl ? [`--proxy-server=${config.proxyUrl}`, "--proxy-bypass-list=<-loopback>"] : []),
    "about:blank",
  ];

  const proc = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const endpoint = await waitForDevtoolsEndpoint(proc, config.launchTimeoutMs);
  return {
    proc,
    httpOrigin: browserHttpOrigin(endpoint),
    userDataDir,
  };
}

class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdpCall>();
  private readonly eventWaiters = new Map<string, Array<() => void>>();

  private constructor(private readonly ws: WebSocket) {
    this.ws.on("message", (data) => this.handleMessage(Buffer.isBuffer(data) ? data.toString("utf-8") : String(data)));
    this.ws.on("close", () => this.rejectAll(new Error("CDP page socket closed.")));
    this.ws.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  static connect(wsUrl: string, timeoutMs: number): Promise<CdpPage> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to page DevTools socket after ${timeoutMs}ms.`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpPage(ws));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(payload);
    return result;
  }

  waitForEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) ?? [];
        this.eventWaiters.set(method, waiters.filter((item) => item !== done));
        reject(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);

      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };

      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push(done);
      this.eventWaiters.set(method, waiters);
    });
  }

  close(): void {
    this.ws.close();
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const detail = JSON.stringify(message.error);
        pending.reject(new Error(`CDP call failed: ${detail}`));
      } else {
        pending.resolve(message.result && typeof message.result === "object"
          ? message.result as Record<string, unknown>
          : {});
      }
      return;
    }

    const method = typeof message.method === "string" ? message.method : null;
    if (!method) return;
    const waiters = this.eventWaiters.get(method);
    if (!waiters || waiters.length === 0) return;
    this.eventWaiters.delete(method);
    for (const waiter of waiters) waiter();
  }

  private rejectAll(error: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
}

async function openTarget(httpOrigin: string): Promise<OpenedTarget> {
  const response = await fetch(`${httpOrigin}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`Failed to create browser target: ${response.status}`);
  }
  const data = await response.json() as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : "";
  const webSocketDebuggerUrl = typeof data.webSocketDebuggerUrl === "string" ? data.webSocketDebuggerUrl : "";
  if (!id || !webSocketDebuggerUrl) {
    throw new Error(`Browser target response missing id/webSocketDebuggerUrl: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { id, webSocketDebuggerUrl };
}

async function closeTarget(httpOrigin: string, targetId: string): Promise<void> {
  await fetch(`${httpOrigin}/json/close/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

function readEvalStringValue(result: Record<string, unknown>): string {
  const outer = result.result;
  if (!outer || typeof outer !== "object") return "";
  const value = (outer as Record<string, unknown>).value;
  return typeof value === "string" ? value : "";
}

async function readPageWithBrowser(
  httpOrigin: string,
  url: string,
  config: BrowserAgentConfig,
): Promise<BrowserPageObservation> {
  const target = await openTarget(httpOrigin);
  const page = await CdpPage.connect(target.webSocketDebuggerUrl, config.timeoutMs);
  const navUrl = rewriteForReadability(url);
  try {
    await page.send("Page.enable", {}, config.timeoutMs);
    await page.send("Runtime.enable", {}, config.timeoutMs);
    // Look like a normal browser: override the HeadlessChrome UA and hide the
    // webdriver flag before any page script runs. Best-effort — older CDP
    // builds may not support one of these, so don't fail the whole read.
    await page.send("Emulation.setUserAgentOverride", {
      userAgent: BROWSER_USER_AGENT,
      acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      platform: "Win32",
    }, config.timeoutMs).catch(() => undefined);
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: STEALTH_SCRIPT,
    }, config.timeoutMs).catch(() => undefined);
    const loaded = page.waitForEvent("Page.loadEventFired", config.timeoutMs).catch(() => undefined);
    const navigation = await page.send("Page.navigate", { url: navUrl }, config.timeoutMs);
    const navigationError = typeof navigation.errorText === "string" ? navigation.errorText.trim() : "";
    if (navigationError) {
      return {
        title: "",
        url,
        excerpt: "",
        error: navigationError,
      };
    }
    await loaded;
    await delay(DEFAULT_PAGE_LOAD_SETTLE_MS);
    const evaluated = await page.send("Runtime.evaluate", {
      expression: CONTENT_EXTRACTION_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    }, config.timeoutMs);
    const raw = readEvalStringValue(evaluated);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const finalUrl = typeof parsed.url === "string" ? parsed.url.trim() : navUrl;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const links = (Array.isArray(parsed.links) ? parsed.links : [])
      .map((item): BrowserPageLink | null => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const label = typeof record.text === "string" ? record.text.trim() : "";
        const linkUrl = typeof record.url === "string" ? record.url.trim() : "";
        return label && linkUrl ? { text: label, url: linkUrl } : null;
      })
      .filter((item): item is BrowserPageLink => item !== null);
    if (finalUrl.startsWith("chrome-error://")) {
      return {
        title,
        url,
        excerpt: "",
        error: `Chrome error page loaded for ${navUrl}`,
      };
    }
    return {
      title,
      url: finalUrl,
      excerpt: trimText(text, config.contentMaxChars),
      ...(links.length > 0 ? { links } : {}),
    };
  } catch (error) {
    return {
      title: "",
      url,
      excerpt: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    page.close();
    await closeTarget(httpOrigin, target.id);
  }
}

function formatObservationSummary(query: string, pages: BrowserPageObservation[]): string {
  const readable = pages.filter((page) => page.excerpt);
  if (readable.length === 0) {
    return "";
  }
  return [
    `[Browser observation] query=${query}`,
    ...readable.map((page, index) => {
      const lines = [
        `${index + 1}. ${page.title || "(untitled)"}`,
        `Source: ${page.url}`,
        page.excerpt,
      ];
      const detailLinks = (page.links ?? []).slice(0, 10);
      if (detailLinks.length > 0) {
        lines.push("Detail links:");
        for (const link of detailLinks) {
          lines.push(`- ${link.text}: ${link.url}`);
        }
      }
      return lines.join("\n");
    }),
  ].join("\n\n");
}

export async function browseTopicWithBrowserAgent(
  query: string,
  config: BrowserAgentConfig,
  logger?: BrowserAgentLogger,
): Promise<BrowserTopicObservation | null> {
  const cleanQuery = query.trim();
  if (!config.enabled || !cleanQuery) return null;

  const results = await searchWeb(cleanQuery, {
    topK: config.searchTopK,
    timeoutMs: config.timeoutMs,
  });
  const urls = results
    .map((result: SearchResult) => result.url.trim())
    .filter(Boolean)
    .slice(0, config.maxPages);
  if (urls.length === 0) return null;

  return browseUrlsWithBrowserAgent(cleanQuery, urls, config, logger);
}

export async function browseUrlsWithBrowserAgent(
  query: string,
  urls: readonly string[],
  config: BrowserAgentConfig,
  logger?: BrowserAgentLogger,
): Promise<BrowserTopicObservation | null> {
  const cleanQuery = query.trim();
  const targetUrls = urls
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, config.maxPages);
  if (!config.enabled || !cleanQuery || targetUrls.length === 0) return null;

  let launched: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    launched = await launchBrowser(config);
    const pages: BrowserPageObservation[] = [];
    for (const url of targetUrls) {
      const page = await readPageWithBrowser(launched.httpOrigin, url, config);
      pages.push(page);
      if (logger) {
        if (page.error) {
          logger({ url, status: "error", detail: page.error });
        } else if (!page.excerpt) {
          logger({ url, status: "empty", detail: `title=${page.title || "(none)"} final=${page.url}` });
        }
      }
    }
    const summary = formatObservationSummary(cleanQuery, pages);
    return summary ? { query: cleanQuery, pages, summary } : null;
  } finally {
    if (launched) {
      launched.proc.kill();
      await rm(launched.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
