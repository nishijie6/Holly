import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

export type LlmMessageRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
};

export type LlmProvider = "codex" | "claude";

type CodexProfileConfig = {
  provider: "codex";
  model?: string;
  system_prompt?: string;
};

type ClaudeProfileConfig = {
  provider: "claude";
  model?: string;
  system_prompt?: string;
};

export type LlmProfileConfig = CodexProfileConfig | ClaudeProfileConfig;

type LlmSectionConfig = {
  active?: string;
  system_prompt?: string;
  profiles?: Record<string, LlmProfileConfig>;
};

type AppConfig = {
  llm?: LlmSectionConfig;
};

export type ResolvedLlmProfile = {
  name: string;
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
};

export type LlmClient = {
  profileName: string;
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  displayName: string;
  generateText(input: {
    messages: LlmMessage[];
    systemPrompt?: string;
    jsonSchema?: Record<string, unknown>;
  }): Promise<string>;
};

export type LlmProfileSummary = {
  name: string;
  provider: LlmProvider;
  model: string;
  displayName: string;
};

type CredentialsSource = "project" | "keychain" | "home";

type CodexCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  accountId?: string;
  source: CredentialsSource;
  rawTokens: Record<string, unknown>;
};

type CodexInputItem = {
  role: "user" | "assistant";
  content: string;
};

type CodexRequestBody = {
  model: string;
  input: CodexInputItem[];
  instructions?: string;
  store: false;
  stream?: boolean;
  reasoning?: {
    effort: "none" | "low" | "medium" | "high" | "xhigh";
  };
};

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Keep answers clear and concise.";
const KEYCHAIN_SERVICE = "Codex Auth";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_AUTH_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PROJECT_AUTH_PATH = path.join(process.cwd(), ".codex", "auth.json");
const HOME_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_BUFFER_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const FETCH_FAILED_MAX_ATTEMPTS = 5;
const FETCH_FAILED_RETRY_DELAY_MS = 3_000;
const DEBUG_REQUEST = process.env.CODEX_DEBUG_REQUEST === "1";

const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
// OAuth subscription tokens are only accepted when the first system block is this exact string.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_MAX_TOKENS = 4096;

function isFetchFailedError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("fetch failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConfig(configPath: string): Promise<AppConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}.`);
  }

  const raw = await readFile(configPath, "utf-8");
  return (YAML.parse(raw) as AppConfig | null) ?? {};
}

async function saveConfig(configPath: string, config: AppConfig): Promise<void> {
  const body = YAML.stringify(config);
  await writeFile(configPath, body, "utf-8");
}

function splitSystemPrompt(messages: LlmMessage[], baseSystemPrompt: string): {
  systemPrompt: string;
  contents: LlmMessage[];
} {
  const systemBlocks = [baseSystemPrompt];
  const contents: LlmMessage[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }

    if (message.role === "system") {
      systemBlocks.push(content);
      continue;
    }

    contents.push({
      role: message.role,
      content,
    });
  }

  return {
    systemPrompt: systemBlocks.filter(Boolean).join("\n\n"),
    contents,
  };
}

function parseJwtExp(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpiringSoon(expiresAt: number | null): boolean {
  if (expiresAt === null) return false;
  return Date.now() + TOKEN_REFRESH_BUFFER_MS >= expiresAt;
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME;
  const home = configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
  try {
    return realpathSync.native(home);
  } catch {
    return home;
  }
}

function computeKeychainAccount(codexHome: string): string {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function parseTokensPayload(raw: string, source: CredentialsSource): CodexCredentials {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens) throw new Error("tokens not found in auth.json");

  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("access_token not found in auth.json");
  }

  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;

  return {
    accessToken,
    refreshToken,
    expiresAt: parseJwtExp(accessToken),
    accountId,
    source,
    rawTokens: tokens,
  };
}

async function writeProjectAuth(creds: CodexCredentials): Promise<void> {
  const tokens = {
    ...creds.rawTokens,
    access_token: creds.accessToken,
    refresh_token: creds.refreshToken,
  };
  await mkdir(path.dirname(PROJECT_AUTH_PATH), { recursive: true });
  await writeFile(PROJECT_AUTH_PATH, JSON.stringify({ tokens }), { encoding: "utf-8", mode: 0o600 });
}

async function readCodexCredentials(): Promise<CodexCredentials> {
  try {
    return parseTokensPayload(await readFile(PROJECT_AUTH_PATH, "utf-8"), "project");
  } catch {
    // Fall through to system stores.
  }

  if (process.platform === "darwin") {
    try {
      const codexHome = resolveCodexHome();
      const account = computeKeychainAccount(codexHome);
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
      return parseTokensPayload(raw.trim(), "keychain");
    } catch {
      // Fall through to home file.
    }
  }

  return parseTokensPayload(await readFile(HOME_AUTH_PATH, "utf-8"), "home");
}

async function refreshCodexCredentials(creds: CodexCredentials): Promise<CodexCredentials | null> {
  if (!creds.refreshToken) {
    return null;
  }

  const res = await fetch(CODEX_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${res.status}): ${body || "<empty>"}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  const refreshed: CodexCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : parseJwtExp(data.access_token),
    accountId: creds.accountId,
    source: "project",
    rawTokens: {
      ...creds.rawTokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? creds.refreshToken,
      ...(data.id_token && { id_token: data.id_token }),
    },
  };

  await writeProjectAuth(refreshed);
  return refreshed;
}

async function getCodexCredentials(): Promise<CodexCredentials> {
  const creds = await readCodexCredentials();
  if (!isExpiringSoon(creds.expiresAt)) {
    return creds;
  }

  const refreshed = await refreshCodexCredentials(creds).catch(() => null);
  return refreshed ?? creds;
}

function buildCodexHeaders(creds: CodexCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "tsbot-codex",
    Accept: "application/json",
  };

  if (creds.accountId) {
    headers["ChatGPT-Account-Id"] = creds.accountId;
  }

  return headers;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  if (redacted.Authorization) {
    redacted.Authorization = "Bearer <redacted>";
  }
  return redacted;
}

function logCodexRequest(body: CodexRequestBody, headers: Record<string, string>): void {
  if (!DEBUG_REQUEST) return;
  console.log("[codex] request");
  console.log(JSON.stringify({
    url: CODEX_RESPONSES_URL,
    method: "POST",
    headers: redactHeaders(headers),
    body,
  }, null, 2));
}

async function logCodexResponse(res: Response): Promise<void> {
  if (!DEBUG_REQUEST) return;
  const preview = await res.clone().text().catch(() => "");
  console.log("[codex] response");
  console.log(JSON.stringify({
    status: res.status,
    statusText: res.statusText,
    bodyPreview: preview.slice(0, 1000),
  }, null, 2));
}

function buildCodexRequest(model: string, systemPrompt: string, messages: LlmMessage[]): CodexRequestBody {
  const input = messages
    .filter((message) => message.content.trim())
    .map((message) => {
      const role: CodexInputItem["role"] = message.role === "assistant" ? "assistant" : "user";
      return {
        role,
        content: message.content.trim(),
      };
    });

  return {
    model,
    input,
    instructions: systemPrompt || undefined,
    store: false,
    stream: true,
    reasoning: model === "gpt-5.4" ? { effort: "medium" } : undefined,
  };
}

async function readCodexStreamText(res: Response, model: string): Promise<string> {
  const body = res.body;
  if (!body) {
    return "";
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let latestText = "";
  const accumulated: string[] = [];

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if ((event.type === "response.completed" || event.type === "response.done") && event.response && typeof event.response === "object") {
        const usage = (event.response as Record<string, unknown>).usage;
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          recordCallTokenUsage(model, num(u.input_tokens), num(u.output_tokens));
        }
      }

      if (event.type === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        accumulated.push(delta);
        latestText = accumulated.join("");
      } else if (event.type === "response.output_text.done") {
        const text = typeof event.text === "string" ? event.text : "";
        if (text && text.length >= latestText.length) {
          latestText = text;
        }
      } else {
        const parsed = extractCodexText(event);
        if (parsed && parsed.length >= latestText.length) {
          latestText = parsed;
        }
      }
    }
  }

  return latestText.trim();
}

function extractCodexText(rawResult: unknown): string {
  if (!rawResult || typeof rawResult !== "object") return "";
  const root = rawResult as Record<string, unknown>;

  if (typeof root.output_text === "string" && root.output_text.trim()) {
    return root.output_text.trim();
  }

  const texts: string[] = [];

  const visitMessage = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const item = obj as Record<string, unknown>;
    if (item.type !== "message" || !Array.isArray(item.content)) return;
    for (const part of item.content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as Record<string, unknown>;
      if (typeof piece.text === "string") {
        texts.push(piece.text);
      }
    }
  };

  visitMessage(root.item);
  if (Array.isArray(root.output)) {
    for (const item of root.output) visitMessage(item);
  }

  const response = root.response;
  if (response && typeof response === "object") {
    const responseObj = response as Record<string, unknown>;
    if (typeof responseObj.output_text === "string" && responseObj.output_text.trim()) {
      return responseObj.output_text.trim();
    }
    if (Array.isArray(responseObj.output)) {
      for (const item of responseObj.output) visitMessage(item);
    }
  }

  return texts.join("").trim();
}

async function requestCodexText(model: string, systemPrompt: string, messages: LlmMessage[]): Promise<string> {
  let creds = await getCodexCredentials();
  const body = buildCodexRequest(model, systemPrompt, messages);
  let fetchAttempts = 0;

  let authAttempt = 0;
  while (authAttempt < 2) {
    const headers = buildCodexHeaders(creds);
    headers.Accept = "text/event-stream";
    logCodexRequest(body, headers);
    let res: Response;
    try {
      fetchAttempts += 1;
      res = await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isFetchFailedError(error) && fetchAttempts < FETCH_FAILED_MAX_ATTEMPTS) {
        console.warn(
          `Codex request fetch failed; retrying in ${FETCH_FAILED_RETRY_DELAY_MS / 1000}s (${fetchAttempts + 1}/${FETCH_FAILED_MAX_ATTEMPTS}).`,
        );
        await delay(FETCH_FAILED_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
    await logCodexResponse(res);

    if ((res.status === 401 || res.status === 403) && authAttempt === 0 && creds.refreshToken) {
      const refreshed = await refreshCodexCredentials(creds).catch(() => null);
      if (refreshed) {
        creds = refreshed;
        authAttempt += 1;
        continue;
      }
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Codex API error ${res.status}: ${errorText || "<empty>"}`);
    }

    return readCodexStreamText(res, model);
  }

  throw new Error("Codex request failed after retry.");
}

type ClaudeCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  raw: Record<string, unknown>;
};

function asClaudeOauthRecord(file: Record<string, unknown>): Record<string, unknown> {
  const oauth = file.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    throw new Error("claudeAiOauth not found in ~/.claude/.credentials.json");
  }
  return oauth as Record<string, unknown>;
}

async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  const raw = JSON.parse(await readFile(CLAUDE_CREDENTIALS_PATH, "utf-8")) as Record<string, unknown>;
  const oauth = asClaudeOauthRecord(raw);

  const accessToken = oauth.accessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("accessToken not found in claudeAiOauth credentials");
  }

  return {
    accessToken,
    refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : null,
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    raw,
  };
}

async function refreshClaudeCredentials(creds: ClaudeCredentials): Promise<ClaudeCredentials | null> {
  if (!creds.refreshToken) {
    return null;
  }

  const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude token refresh failed (${res.status}): ${body || "<empty>"}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const refreshToken = data.refresh_token ?? creds.refreshToken;
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
  const oauth = {
    ...asClaudeOauthRecord(creds.raw),
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
  };
  const nextRaw = { ...creds.raw, claudeAiOauth: oauth };

  await writeFile(CLAUDE_CREDENTIALS_PATH, JSON.stringify(nextRaw), { encoding: "utf-8", mode: 0o600 });

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
    raw: nextRaw,
  };
}

async function getClaudeCredentials(): Promise<ClaudeCredentials> {
  const creds = await readClaudeCredentials();
  if (!isExpiringSoon(creds.expiresAt)) {
    return creds;
  }

  const refreshed = await refreshClaudeCredentials(creds).catch(() => null);
  return refreshed ?? creds;
}

function buildClaudeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": CLAUDE_ANTHROPIC_VERSION,
    "anthropic-beta": CLAUDE_OAUTH_BETA,
  };
}

function buildClaudeMessages(messages: LlmMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }

    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n${content}`;
    } else {
      merged.push({ role, content });
    }
  }

  // The Messages API requires the first message to be a user turn.
  while (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  return merged;
}

function buildClaudeRequestBody(
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  jsonSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const system: Array<Record<string, unknown>> = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];
  const trimmedSystem = systemPrompt.trim();
  if (trimmedSystem) {
    // cache_control on the last system block caches the identity + full system prefix together.
    system.push({ type: "text", text: trimmedSystem, cache_control: { type: "ephemeral" } });
  } else {
    system[0].cache_control = { type: "ephemeral" };
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    system,
    messages: buildClaudeMessages(messages),
  };

  if (jsonSchema) {
    // Structured outputs guarantee the response is schema-valid JSON (GA on Opus 4.7 / Sonnet 4.6).
    body.output_config = { format: { type: "json_schema", schema: jsonSchema } };
  }

  return body;
}

function extractClaudeText(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const content = (data as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") {
        texts.push(text);
      }
    }
  }

  return texts.join("").trim();
}

export type ClaudeUsage = {
  fiveHourUtilization: number | null;
  fiveHourResetAt: number | null;
  fiveHourStatus: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetAt: number | null;
  sevenDayStatus: string | null;
  capturedAt: number;
};

let latestClaudeUsage: ClaudeUsage | null = null;

export function getLatestClaudeUsage(): ClaudeUsage | null {
  return latestClaudeUsage;
}

export type CallTokenUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  capturedAt: number;
};

let latestCallTokenUsage: CallTokenUsage | null = null;

// Consume the most recent call's token usage exactly once. The model queue is
// serial, so each generateText() is followed by one consume with no races.
export function consumeLatestCallTokenUsage(): CallTokenUsage | null {
  const usage = latestCallTokenUsage;
  latestCallTokenUsage = null;
  return usage;
}

function recordCallTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
  latestCallTokenUsage = {
    model,
    inputTokens: Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0,
    outputTokens: Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0,
    capturedAt: Date.now(),
  };
}

function readClaudeUsageTokens(data: unknown): { input: number; output: number } | null {
  if (!data || typeof data !== "object") return null;
  const usage = (data as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // Count cache writes/reads as input too, so totals reflect real tokens processed.
  const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const output = num(u.output_tokens);
  if (input === 0 && output === 0) return null;
  return { input, output };
}

function parseUsageUtilization(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseUsageResetMs(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  // The reset headers are unix epoch seconds.
  return Number.isFinite(numeric) ? numeric * 1000 : null;
}

function captureClaudeUsage(res: Response): void {
  const headers = res.headers;
  const usage: ClaudeUsage = {
    fiveHourUtilization: parseUsageUtilization(headers.get("anthropic-ratelimit-unified-5h-utilization")),
    fiveHourResetAt: parseUsageResetMs(headers.get("anthropic-ratelimit-unified-5h-reset")),
    fiveHourStatus: headers.get("anthropic-ratelimit-unified-5h-status"),
    sevenDayUtilization: parseUsageUtilization(headers.get("anthropic-ratelimit-unified-7d-utilization")),
    sevenDayResetAt: parseUsageResetMs(headers.get("anthropic-ratelimit-unified-7d-reset")),
    sevenDayStatus: headers.get("anthropic-ratelimit-unified-7d-status"),
    capturedAt: Date.now(),
  };

  if (usage.fiveHourUtilization !== null || usage.sevenDayUtilization !== null) {
    latestClaudeUsage = usage;
  }
}

function parseUsagePercent(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const numeric = Number(value);
  // Codex reports an integer percent (0-100); normalize to a 0-1 fraction.
  return Number.isFinite(numeric) ? numeric / 100 : null;
}

function codexUsageStatus(utilization: number | null): string | null {
  if (utilization === null) {
    return null;
  }
  return utilization >= 1 ? "limited" : "allowed";
}

// Codex exposes 5h (primary) / 7d (secondary) rate-limit windows via x-codex-* headers.
function captureCodexUsage(res: Response): void {
  const headers = res.headers;
  const fiveHourUtilization = parseUsagePercent(headers.get("x-codex-primary-used-percent"));
  const sevenDayUtilization = parseUsagePercent(headers.get("x-codex-secondary-used-percent"));
  const usage: ClaudeUsage = {
    fiveHourUtilization,
    fiveHourResetAt: parseUsageResetMs(headers.get("x-codex-primary-reset-at")),
    fiveHourStatus: codexUsageStatus(fiveHourUtilization),
    sevenDayUtilization,
    sevenDayResetAt: parseUsageResetMs(headers.get("x-codex-secondary-reset-at")),
    sevenDayStatus: codexUsageStatus(sevenDayUtilization),
    capturedAt: Date.now(),
  };

  if (fiveHourUtilization !== null || sevenDayUtilization !== null) {
    latestClaudeUsage = usage;
  }
}

async function requestClaudeText(
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  jsonSchema?: Record<string, unknown>,
): Promise<string> {
  let creds = await getClaudeCredentials();
  const body = buildClaudeRequestBody(model, systemPrompt, messages, jsonSchema);
  let fetchAttempts = 0;

  let authAttempt = 0;
  while (authAttempt < 2) {
    let res: Response;
    try {
      fetchAttempts += 1;
      res = await fetch(CLAUDE_MESSAGES_URL, {
        method: "POST",
        headers: buildClaudeHeaders(creds.accessToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isFetchFailedError(error) && fetchAttempts < FETCH_FAILED_MAX_ATTEMPTS) {
        console.warn(
          `Claude request fetch failed; retrying in ${FETCH_FAILED_RETRY_DELAY_MS / 1000}s (${fetchAttempts + 1}/${FETCH_FAILED_MAX_ATTEMPTS}).`,
        );
        await delay(FETCH_FAILED_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }

    if ((res.status === 401 || res.status === 403) && authAttempt === 0 && creds.refreshToken) {
      const refreshed = await refreshClaudeCredentials(creds).catch(() => null);
      if (refreshed) {
        creds = refreshed;
        authAttempt += 1;
        continue;
      }
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Claude API error ${res.status}: ${errorText || "<empty>"}`);
    }

    captureClaudeUsage(res);
    const data = await res.json();
    const tokens = readClaudeUsageTokens(data);
    if (tokens) {
      recordCallTokenUsage(model, tokens.input, tokens.output);
    }
    return extractClaudeText(data);
  }

  throw new Error("Claude request failed after retry.");
}

// Minimal request whose only purpose is to capture the rate-limit headers so the
// usage panel can show data before the first real chat happens.
export async function probeClaudeUsage(model: string): Promise<ClaudeUsage | null> {
  try {
    const creds = await getClaudeCredentials();
    const body = {
      model,
      max_tokens: 1,
      system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }],
      messages: [{ role: "user", content: "ping" }],
    };
    const res = await fetch(CLAUDE_MESSAGES_URL, {
      method: "POST",
      headers: buildClaudeHeaders(creds.accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 429 responses still carry the unified rate-limit headers.
    if (res.ok || res.status === 429) {
      captureClaudeUsage(res);
    }
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const tokens = readClaudeUsageTokens(data);
      if (tokens) {
        recordCallTokenUsage(model, tokens.input, tokens.output);
      }
    }
  } catch {
    // Best-effort probe; fall back to whatever is cached.
  }
  return getLatestClaudeUsage();
}

export async function resolveLlmProfile(configPath: string, requestedProfileName?: string): Promise<ResolvedLlmProfile> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  if (!llm?.profiles || Object.keys(llm.profiles).length === 0) {
    throw new Error(`Missing 'llm.profiles' in ${configPath}.`);
  }

  const profileName = requestedProfileName?.trim() || llm.active?.trim();
  if (!profileName) {
    throw new Error(`Missing 'llm.active' in ${configPath}.`);
  }

  const profile = llm.profiles[profileName];
  if (!profile) {
    throw new Error(`LLM profile '${profileName}' not found in ${configPath}.`);
  }

  if (profile.provider !== "codex" && profile.provider !== "claude") {
    throw new Error(`Unsupported provider '${(profile as { provider?: string }).provider}' for '${profileName}'.`);
  }

  const model = profile.model?.trim();
  if (!model) {
    throw new Error(`Missing 'model' for llm profile '${profileName}' in ${configPath}.`);
  }

  return {
    name: profileName,
    provider: profile.provider,
    model,
    systemPrompt: profile.system_prompt ?? llm.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
  };
}

export async function listLlmProfiles(configPath: string): Promise<{
  active: string;
  profiles: LlmProfileSummary[];
}> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  if (!llm?.profiles || Object.keys(llm.profiles).length === 0) {
    throw new Error(`Missing 'llm.profiles' in ${configPath}.`);
  }

  const active = llm.active?.trim();
  if (!active) {
    throw new Error(`Missing 'llm.active' in ${configPath}.`);
  }

  const profiles = Object.entries(llm.profiles).map(([name, profile]) => {
    const model = profile.model?.trim();
    if (!model) {
      throw new Error(`Missing 'model' for llm profile '${name}' in ${configPath}.`);
    }

    if (profile.provider !== "codex" && profile.provider !== "claude") {
      throw new Error(`Unsupported provider '${(profile as { provider?: string }).provider}' for '${name}'.`);
    }

    return {
      name,
      provider: profile.provider,
      model,
      displayName: `${name} (${model})`,
    };
  });

  return {
    active,
    profiles,
  };
}

export async function setActiveLlmProfile(configPath: string, profileName: string): Promise<void> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  const target = profileName.trim();
  if (!target) {
    throw new Error("profileName is required.");
  }

  if (!llm?.profiles || !llm.profiles[target]) {
    throw new Error(`LLM profile '${target}' not found in ${configPath}.`);
  }

  config.llm = {
    ...llm,
    active: target,
  };

  await saveConfig(configPath, config);
}

export async function createLlmClient(configPath: string, requestedProfileName?: string): Promise<LlmClient> {
  const profile = await resolveLlmProfile(configPath, requestedProfileName);

  return {
    profileName: profile.name,
    provider: profile.provider,
    model: profile.model,
    systemPrompt: profile.systemPrompt,
    displayName: `${profile.name} (${profile.model})`,
    async generateText(input): Promise<string> {
      const { systemPrompt, contents } = splitSystemPrompt(
        input.messages,
        input.systemPrompt ?? profile.systemPrompt,
      );

      if (profile.provider === "claude") {
        return requestClaudeText(profile.model, systemPrompt, contents, input.jsonSchema);
      }

      return requestCodexText(profile.model, systemPrompt, contents);
    },
  };
}
