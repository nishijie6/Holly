import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { LlmHttpError, ProviderRateLimitGate } from "./connection-watchdog.js";
import { TokenUsageQueue, type TokenUsageBreakdown } from "./token-usage.js";

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
  decision_profile?: string;
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
  consumeTokenUsage(): import("./token-usage.js").CallTokenUsage | null;
  generateText(input: {
    messages: LlmMessage[];
    systemPrompt?: string;
    jsonSchema?: Record<string, unknown>;
  }): Promise<string>;
  // Re-send the context with max_tokens=1 purely to refresh the prompt cache.
  // No-op for non-Claude providers (Anthropic-cache-specific).
  warmContext(input: {
    messages: LlmMessage[];
    systemPrompt?: string;
  }): Promise<void>;
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
  prompt_cache_key: string;
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
const CODEX_PROMPT_CACHE_NAMESPACE = "tsbot-group-chat";
const PROJECT_AUTH_PATH = path.join(process.cwd(), ".codex", "auth.json");
const HOME_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_BUFFER_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const FETCH_FAILED_MAX_ATTEMPTS = 5;
const FETCH_FAILED_RETRY_DELAY_MS = 3_000;
const DEBUG_REQUEST = process.env.CODEX_DEBUG_REQUEST === "1";
const codexRateLimitGate = new ProviderRateLimitGate({ provider: "Codex" });

const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
// On macOS, Claude Code stores its OAuth blob in the login Keychain, not in the
// .credentials.json file (which is the Linux/CI location). Service + account
// match what the CLI writes: service "Claude Code-credentials", account = the
// current username.
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const claudeRateLimitGate = new ProviderRateLimitGate({ provider: "Claude" });
const CLAUDE_CACHE_WARMUP_PLACEHOLDER = "warmup";
// OAuth subscription tokens are only accepted when the first system block is this exact string.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// Opus 4.x supports 128K output tokens; Sonnet 4.6 / Haiku 4.5 cap at 64K.
function claudeMaxOutputTokens(model: string): number {
  return /opus/i.test(model) ? 128_000 : 64_000;
}

type ClaudeRequestOptions = {
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  // Put the cache breakpoint on the last byte-stable conversation block.
  // The volatile request tail must remain after it so timestamps, retrieved
  // memory, and the current scan never poison the reusable prefix hash.
  cacheStablePrefix?: boolean;
  volatileTailMessages?: number;
};

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
    // Keep repeated bot instructions and conversation prefixes on the same cache route.
    prompt_cache_key: `${CODEX_PROMPT_CACHE_NAMESPACE}:${model}`,
    store: false,
    stream: true,
    reasoning: model === "gpt-5.4" ? { effort: "medium" } : undefined,
  };
}

async function readCodexStreamText(
  res: Response,
  recordUsage: (usage: TokenUsageBreakdown) => void,
): Promise<string> {
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
          const inputTokens = num(u.input_tokens);
          const inputDetails = u.input_tokens_details && typeof u.input_tokens_details === "object"
            ? u.input_tokens_details as Record<string, unknown>
            : {};
          const cacheReadInputTokens = Math.min(inputTokens, num(inputDetails.cached_tokens));
          recordUsage({
            inputTokens,
            uncachedInputTokens: Math.max(0, inputTokens - cacheReadInputTokens),
            cacheCreationInputTokens: 0,
            cacheReadInputTokens,
            outputTokens: num(u.output_tokens),
          });
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

async function requestCodexText(
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  recordUsage: (usage: TokenUsageBreakdown) => void,
): Promise<string> {
  const rateLimitRevision = codexRateLimitGate.beginRequest();
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
    captureCodexUsage(res);

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
      const retryAt = res.status === 429
        ? codexRateLimitGate.pauseUntil(parseUsageResetMs(res.headers.get("x-codex-primary-reset-at")))
        : null;
      throw new LlmHttpError("Codex", res.status, (errorText || "<empty>").slice(0, 2_000), retryAt);
    }

    codexRateLimitGate.recordSuccess(rateLimitRevision);
    return readCodexStreamText(res, recordUsage);
  }

  throw new Error("Codex request failed after retry.");
}

type ClaudeCredentialsSource = "file" | "keychain";

type ClaudeCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  raw: Record<string, unknown>;
  source: ClaudeCredentialsSource;
};

function asClaudeOauthRecord(file: Record<string, unknown>): Record<string, unknown> {
  const oauth = file.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    throw new Error("claudeAiOauth not found in Claude credentials");
  }
  return oauth as Record<string, unknown>;
}

function parseClaudeCredentials(rawJson: string, source: ClaudeCredentialsSource): ClaudeCredentials {
  const raw = JSON.parse(rawJson) as Record<string, unknown>;
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
    source,
  };
}

function readClaudeKeychainRaw(): string {
  const account = os.userInfo().username;
  return execSync(
    `security find-generic-password -s "${CLAUDE_KEYCHAIN_SERVICE}" -a "${account}" -w`,
    { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

// The file and the Keychain hold the same OAuth blob but drift apart: the CLI
// rotates the Keychain copy, while refreshes here are persisted to the file. A
// fixed precedence means 401s against a token the other store already replaced,
// so rank the two by how usable each is right now. `preferred` wins ties.
export function pickFresherClaudeCredentials<T extends { expiresAt: number | null }>(
  preferred: T | null,
  other: T | null,
): T | null {
  if (!preferred) return other;
  if (!other) return preferred;

  const usable = (creds: T): boolean => !isExpiringSoon(creds.expiresAt);
  if (usable(preferred) !== usable(other)) {
    return usable(preferred) ? preferred : other;
  }

  // A null expiresAt keeps the meaning isExpiringSoon() gives it — not expiring
  // — so it never loses to a dated token.
  const rank = (creds: T): number => creds.expiresAt ?? Number.POSITIVE_INFINITY;
  return rank(other) > rank(preferred) ? other : preferred;
}

async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  // The on-disk file is the Linux/CI location and where token refreshes are
  // persisted; the macOS Keychain is where the Claude Code CLI stores
  // credentials by default. Read both and take the fresher one.
  let fileError: unknown = null;
  let fileCreds: ClaudeCredentials | null = null;
  try {
    fileCreds = parseClaudeCredentials(await readFile(CLAUDE_CREDENTIALS_PATH, "utf-8"), "file");
  } catch (error) {
    fileError = error;
  }

  let keychainCreds: ClaudeCredentials | null = null;
  if (process.platform === "darwin") {
    try {
      keychainCreds = parseClaudeCredentials(readClaudeKeychainRaw(), "keychain");
    } catch {
      // Keychain miss — fall back to whatever the file gave us.
    }
  }

  const creds = pickFresherClaudeCredentials(fileCreds, keychainCreds);
  if (!creds) {
    // Surface the file error, which names the primary credentials path.
    throw fileError ?? new Error(`Claude credentials not found at ${CLAUDE_CREDENTIALS_PATH}`);
  }
  return creds;
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

  // Persist the refreshed token to the file rather than back to the Keychain:
  // readClaudeCredentials() reads the file first, so the next read picks it up,
  // and this avoids a `security add-generic-password` write that can trigger a
  // GUI Keychain-authorization prompt this headless service can't answer.
  await mkdir(path.dirname(CLAUDE_CREDENTIALS_PATH), { recursive: true });
  await writeFile(CLAUDE_CREDENTIALS_PATH, JSON.stringify(nextRaw), { encoding: "utf-8", mode: 0o600 });

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
    raw: nextRaw,
    source: "file",
  };
}

async function getClaudeCredentials(): Promise<ClaudeCredentials> {
  const creds = await readClaudeCredentials();
  if (!isExpiringSoon(creds.expiresAt)) {
    return creds;
  }

  // A failed refresh leaves an expired token in play, which surfaces much later
  // as an opaque 401 from the API — say so here instead.
  const refreshed = await refreshClaudeCredentials(creds).catch((error: unknown) => {
    console.warn(
      `Claude token refresh failed (credentials source: ${creds.source}); continuing with the expired token.`,
      error,
    );
    return null;
  });
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

type ClaudeMessageBlock = { text: string; volatile: boolean };
type ClaudeMergedMessage = { role: "user" | "assistant"; blocks: ClaudeMessageBlock[] };

// One text block per source LlmMessage (conversation turn). Consecutive
// same-role turns merge into one API message but keep their block boundaries,
// allowing a cache marker to sit immediately before the volatile tail.
function buildClaudeMessages(messages: LlmMessage[], volatileTailMessages = 0): ClaudeMergedMessage[] {
  const merged: ClaudeMergedMessage[] = [];
  const volatileFrom = messages.length - Math.max(0, volatileTailMessages);

  for (const [index, message] of messages.entries()) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }

    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const block: ClaudeMessageBlock = { text: content, volatile: index >= volatileFrom };
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.blocks.push(block);
    } else {
      merged.push({ role, blocks: [block] });
    }
  }

  // The Messages API requires the first message to be a user turn.
  while (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  // It must also END with a user turn: a trailing assistant message is treated
  // as prefill, which the subscription/OAuth models reject ("does not support
  // assistant message prefill"). This happens on the cache-warm path, which
  // sends history with no new user turn appended (its empty current message is
  // dropped above), leaving the bot's own last reply as the final turn.
  while (merged.length > 0 && merged[merged.length - 1].role === "assistant") {
    merged.pop();
  }

  return merged;
}

function buildClaudeMessagesBody(
  messages: LlmMessage[],
  cacheStablePrefix: boolean,
  volatileTailMessages: number,
): Array<Record<string, unknown>> {
  const merged = buildClaudeMessages(messages, volatileTailMessages);
  const apiMessages = merged.map((message): Record<string, unknown> => ({
    role: message.role,
    content: message.blocks.map((block) => ({ type: "text", text: block.text })),
  }));

  if (cacheStablePrefix) {
    outer: for (let i = merged.length - 1; i >= 0; i -= 1) {
      for (let j = merged[i].blocks.length - 1; j >= 0; j -= 1) {
        if (!merged[i].blocks[j].volatile) {
          const content = apiMessages[i].content as Array<Record<string, unknown>>;
          content[j].cache_control = { type: "ephemeral", ttl: "1h" };
          break outer;
        }
      }
    }
  }

  return apiMessages;
}

export function buildClaudeRequestBody(
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  options: ClaudeRequestOptions,
): Record<string, unknown> {
  const system: Array<Record<string, unknown>> = [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ];
  const trimmedSystem = systemPrompt.trim();
  if (trimmedSystem) {
    // cache_control on the last system block caches the identity + full system prefix together.
    system.push({ type: "text", text: trimmedSystem, cache_control: { type: "ephemeral", ttl: "1h" } });
  } else {
    system[0].cache_control = { type: "ephemeral", ttl: "1h" };
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? claudeMaxOutputTokens(model),
    system,
    messages: buildClaudeMessagesBody(
      messages,
      options.cacheStablePrefix ?? false,
      options.volatileTailMessages ?? 0,
    ),
  };

  if (options.jsonSchema) {
    // Structured outputs guarantee the response is schema-valid JSON (GA on Opus 4.7 / Sonnet 4.6).
    body.output_config = { format: { type: "json_schema", schema: options.jsonSchema } };
  }

  return body;
}

export function prepareClaudeCacheWarmRequest(messages: LlmMessage[]): {
  messages: LlmMessage[];
  options: ClaudeRequestOptions;
} {
  return {
    messages: [...messages, { role: "user", content: CLAUDE_CACHE_WARMUP_PLACEHOLDER }],
    options: {
      maxTokens: 0,
      cacheStablePrefix: true,
      volatileTailMessages: 1,
    },
  };
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

export function readClaudeUsageTokens(data: unknown): TokenUsageBreakdown | null {
  if (!data || typeof data !== "object") return null;
  const usage = (data as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const uncachedInputTokens = num(u.input_tokens);
  const cacheCreationInputTokens = num(u.cache_creation_input_tokens);
  const cacheReadInputTokens = num(u.cache_read_input_tokens);
  const outputTokens = num(u.output_tokens);
  const inputTokens = uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
  };
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
  options: ClaudeRequestOptions = {},
  recordUsage: (usage: TokenUsageBreakdown) => void,
): Promise<string> {
  const rateLimitRevision = claudeRateLimitGate.beginRequest();
  let creds = await getClaudeCredentials();
  const body = buildClaudeRequestBody(model, systemPrompt, messages, options);
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

    // Usage/reset headers can be present on 429 responses too. Capture them
    // before any auth retry or error throw so the monitor retains the reset.
    captureClaudeUsage(res);

    if ((res.status === 401 || res.status === 403) && authAttempt === 0) {
      // The OAuth credentials are shared with the Claude Code app, which uses
      // rotating refresh tokens: a concurrent rotation invalidates both the
      // access token we just sent and our in-hand refresh token. Re-read the
      // file first — the other process has usually already written fresh
      // tokens, so we can adopt them instead of spending our now-stale refresh
      // token on a refresh that would itself 401.
      const latest = await readClaudeCredentials().catch(() => null);
      if (latest && latest.accessToken !== creds.accessToken) {
        creds = latest;
        authAttempt += 1;
        continue;
      }
      if (creds.refreshToken) {
        const refreshed = await refreshClaudeCredentials(creds).catch(() => null);
        if (refreshed) {
          creds = refreshed;
          authAttempt += 1;
          continue;
        }
      }
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      const retryAt = res.status === 429
        ? claudeRateLimitGate.pauseUntil(
            parseUsageResetMs(res.headers.get("anthropic-ratelimit-unified-5h-reset")),
          )
        : null;
      throw new LlmHttpError("Claude", res.status, (errorText || "<empty>").slice(0, 2_000), retryAt);
    }

    claudeRateLimitGate.recordSuccess(rateLimitRevision);
    const data = await res.json();
    const tokens = readClaudeUsageTokens(data);
    if (tokens) {
      recordUsage(tokens);
    }
    return extractClaudeText(data);
  }

  throw new Error("Claude request failed after retry.");
}

// Minimal request whose only purpose is to capture the rate-limit headers so the
// usage panel can show data before the first real chat happens.
export async function probeClaudeUsage(model: string): Promise<ClaudeUsage | null> {
  try {
    const rateLimitRevision = claudeRateLimitGate.beginRequest();
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
    if (res.status === 429) {
      claudeRateLimitGate.pauseUntil(
        parseUsageResetMs(res.headers.get("anthropic-ratelimit-unified-5h-reset")),
      );
    }
    if (res.ok) {
      claudeRateLimitGate.recordSuccess(rateLimitRevision);
      await res.json().catch(() => null);
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
  decision: string;
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
  const decision = llm.decision_profile?.trim() || active;
  if (!llm.profiles[decision]) {
    throw new Error(`LLM decision profile '${decision}' not found in ${configPath}.`);
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
    decision,
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
  const usageQueue = new TokenUsageQueue(profile.model);
  const recordUsage = (usage: TokenUsageBreakdown): void => usageQueue.record(usage);

  return {
    profileName: profile.name,
    provider: profile.provider,
    model: profile.model,
    systemPrompt: profile.systemPrompt,
    displayName: `${profile.name} (${profile.model})`,
    consumeTokenUsage: () => usageQueue.consume(),
    async generateText(input): Promise<string> {
      const { systemPrompt, contents } = splitSystemPrompt(
        input.messages,
        input.systemPrompt ?? profile.systemPrompt,
      );

      if (profile.provider === "claude") {
        return requestClaudeText(
          profile.model,
          systemPrompt,
          contents,
          {
            jsonSchema: input.jsonSchema,
            cacheStablePrefix: true,
            // Every production generateText caller puts its per-request input in
            // the final LlmMessage. Cache the stable history immediately before it.
            volatileTailMessages: 1,
          },
          recordUsage,
        );
      }

      return requestCodexText(profile.model, systemPrompt, contents, recordUsage);
    },
    async warmContext(input): Promise<void> {
      if (profile.provider !== "claude") {
        return;
      }

      const { systemPrompt, contents } = splitSystemPrompt(
        input.messages,
        input.systemPrompt ?? profile.systemPrompt,
      );
      if (contents.length === 0) {
        return;
      }

      // A volatile placeholder keeps an assistant-ending history valid for the
      // Messages API while leaving the breakpoint on the complete stable history.
      const warm = prepareClaudeCacheWarmRequest(contents);
      await requestClaudeText(
        profile.model,
        systemPrompt,
        warm.messages,
        warm.options,
        recordUsage,
      );
    },
  };
}
