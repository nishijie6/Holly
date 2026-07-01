import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { WebSocket } from "ws";

export type BrowserAgentConfig = {
  enabled: boolean;
  executablePath: string | null;
  headless: boolean;
  timeoutMs: number;
  settleMs: number;
  maxTextChars: number;
  proxyServer: string | null;
};

export type BrowserPageObservation = {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
};

type BrowserProcess = ChildProcessByStdio<null, Readable, Readable>;

const DEFAULT_CHROME_PATHS = [
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
];

function findBrowserExecutable(configured: string | null): string | null {
  if (configured && existsSync(configured)) return configured;
  const envPath = process.env.BROWSER_AGENT_CHROME_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;
  return DEFAULT_CHROME_PATHS.find((item) => existsSync(item)) ?? null;
}

function browserHttpOrigin(wsEndpoint: string): string {
  const url = new URL(wsEndpoint);
  url.protocol = "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function waitForDevtoolsEndpoint(proc: BrowserProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for browser DevTools endpoint after ${timeoutMs}ms.`));
    }, timeoutMs);

    const finish = (error: Error | null, endpoint?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stderr.off("data", onData);
      proc.off("exit", onExit);
      if (error) reject(error);
      else resolve(endpoint ?? "");
    };

    const onData = (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match?.[1]) finish(null, match[1]);
    };

    const onExit = (code: number | null) => {
      finish(new Error(`Browser exited before DevTools endpoint was ready (code=${code ?? "null"}).`));
    };

    proc.stderr.on("data", onData);
    proc.once("exit", onExit);
  });
}

async function launchBrowser(config: BrowserAgentConfig): Promise<{
  proc: BrowserProcess;
  userDataDir: string;
  httpOrigin: string;
}> {
  const executable = findBrowserExecutable(config.executablePath);
  if (!executable) {
    throw new Error("No Chrome/Edge executable found. Set browser_agent.executable_path or BROWSER_AGENT_CHROME_PATH.");
  }

  const userDataDir = await mkdtemp(join(tmpdir(), "tsbot-browser-agent-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-popup-blocking",
  ];
  if (config.headless) args.push("--headless=new");
  if (config.proxyServer) args.push(`--proxy-server=${config.proxyServer}`);
  args.push("about:blank");

  const proc = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as BrowserProcess;

  const endpoint = await waitForDevtoolsEndpoint(proc, config.timeoutMs);
  return {
    proc,
    userDataDir,
    httpOrigin: browserHttpOrigin(endpoint),
  };
}

class CdpPage {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
        reject(new Error(`Timed out connecting to browser page after ${timeoutMs}ms.`));
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

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(payload);
    }) as Promise<T>;
  }

  waitForEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off("message", onMessage);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      const onMessage = (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString("utf-8")) as { method?: string };
          if (parsed.method === method) {
            clearTimeout(timer);
            this.ws.off("message", onMessage);
            resolve();
          }
        } catch {
          // Ignore malformed browser frames.
        }
      };
      this.ws.on("message", onMessage);
    });
  }

  close(): void {
    this.ws.close();
  }

  private handleMessage(text: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "CDP command failed."));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

type NewTargetResponse = {
  id?: string;
  webSocketDebuggerUrl?: string;
};

async function createTarget(httpOrigin: string, url: string): Promise<NewTargetResponse> {
  const response = await fetch(`${httpOrigin}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Failed to create browser target: ${response.status}`);
  }
  return (await response.json()) as NewTargetResponse;
}

async function closeTarget(httpOrigin: string, id: string): Promise<void> {
  try {
    await fetch(`${httpOrigin}/json/close/${encodeURIComponent(id)}`);
  } catch {
    // Best-effort cleanup.
  }
}

type RuntimeEvaluateResult = {
  result?: {
    value?: {
      title?: string;
      url?: string;
      text?: string;
    };
  };
};

export async function observeUrlWithBrowserAgent(
  url: string,
  config: BrowserAgentConfig,
): Promise<BrowserPageObservation | null> {
  if (!config.enabled) return null;

  let launched: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  let targetId: string | null = null;
  let page: CdpPage | null = null;
  try {
    launched = await launchBrowser(config);
    const target = await createTarget(launched.httpOrigin, "about:blank");
    targetId = target.id ?? null;
    if (!target.webSocketDebuggerUrl) {
      throw new Error(`Browser target response missing webSocketDebuggerUrl.`);
    }

    page = await CdpPage.connect(target.webSocketDebuggerUrl, config.timeoutMs);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    const loadPromise = page.waitForEvent("Page.loadEventFired", config.timeoutMs).catch(() => undefined);
    await page.send("Page.navigate", { url });
    await loadPromise;
    if (config.settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.settleMs));
    }

    const evaluated = await page.send<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression: `(() => ({
        title: document.title || "",
        url: location.href,
        text: document.body ? document.body.innerText : ""
      }))()`,
      returnByValue: true,
    });
    const value = evaluated.result?.value;
    const text = typeof value?.text === "string" ? value.text.replace(/\s+/g, " ").trim() : "";
    if (!text) return null;
    return {
      url,
      finalUrl: typeof value?.url === "string" ? value.url : url,
      title: typeof value?.title === "string" ? value.title : "",
      text: text.slice(0, config.maxTextChars),
    };
  } finally {
    page?.close();
    if (launched && targetId) await closeTarget(launched.httpOrigin, targetId);
    if (launched) {
      launched.proc.kill();
      await rm(launched.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
