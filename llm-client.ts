import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { LlmHttpError, ProviderRateLimitGate } from "./connection-watchdog.js";
import {
  TokenUsageQueue,
  estimatePromptTokens,
  type LlmCallPurpose,
  type TokenUsageBreakdown,
} from "./token-usage.js";
import {
  CachePrefixTracker,
  buildCachePrefixDigest,
  type CachePrefixDigest,
  type CachePrefixInspection,
} from "./cache-prefix.js";

export type LlmMessageRole = "system" | "user" | "assistant";

// A tool call the model asked for, and the result we feed back. The API pairs
// them by id, so both halves must survive into the request together — see the
// no-merge/no-trim rule in buildClaudeMessages.
export type LlmToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LlmToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type LlmStructuralBlock = LlmToolUseBlock | LlmToolResultBlock;

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
  // Present only on tool turns. An assistant turn may carry prose in `content`
  // and its tool calls here at once, which is what the model actually returns.
  blocks?: LlmStructuralBlock[];
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function messageHasStructuralBlocks(message: LlmMessage): boolean {
  return Array.isArray(message.blocks) && message.blocks.length > 0;
}

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
  // purpose 必填，防止新调用点产生无法归因的用量；token 账本和逐次提示缓存记录
  // 都以它作为分类依据。
  //
  // cacheRoute 同样必填，但粒度更细：它标识本次请求预期命中的提示缓存谱系，每次调用
  // 都会与同一路由的上一次请求比较（见 cache-prefix.ts）。如果调用点把易变文本放进
  // 缓存前缀，下一次请求就会报告，而不会一直悄悄承担完整重读成本。预期命中不同缓存
  // 条目（按群、按提示结构区分）的请求必须使用不同路由。
  generateText(input: {
    messages: LlmMessage[];
    systemPrompt?: string;
    jsonSchema?: Record<string, unknown>;
    purpose: LlmCallPurpose;
    cacheRoute: string;
    // 调用方明确知道前缀已重建时设置，例如上下文压缩删改了旧轮次。重建仍会记录，
    // 但不会标记为缺陷。
    expectRebuild?: boolean;
  }): Promise<string>;
  // generateText 的智能体式对应方法。它挂在客户端上而不是裸函数，是为了让焦点管线
  // 继承其他调用都有的观测能力：按用途统计 token、逐轮检查缓存前缀，以及连接看门狗。
  // 绕过客户端会让这个正在评估成本的管线反而成为唯一未被测量的调用路径。
  runToolLoop(input: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    runTool: (call: LlmToolUseBlock) => Promise<string>;
    purpose: LlmCallPurpose;
    cacheRoute: string;
    systemPrompt?: string;
    maxRounds?: number;
    // 只豁免这次循环的第一轮。第一轮的请求内容来自调用方传进来的 messages，调用方可能有意改写过它
    // （压缩换掉了账本前段、或者刚在焦点路由上发过一次压缩请求）；之后每一轮都只是在后面追加这次
    // 循环自己的 assistant / tool 轮次，必须是延长。整次循环都豁免的话，第二轮以后真出现的漂移会被
    // 当成预期内的重建放过去。
    expectRebuild?: boolean;
    onAssistantTurn?: (text: string, toolUses: LlmToolUseBlock[]) => void;
    onToolResults?: (results: LlmToolResultBlock[]) => void;
  }): Promise<ClaudeToolLoopResult>;
};

// Reported for every Claude request, including the ones that behaved. main.ts
// decides what is worth showing; the client's job is that nothing goes
// unmeasured.
export type CachePrefixObserver = (event: CachePrefixInspection & {
  model: string;
  purpose: LlmCallPurpose;
  expectRebuild: boolean;
}) => void;

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
// 在 macOS 上，Claude Code 把 OAuth 数据存进登录钥匙串，而不是 Linux/CI 使用的
// .credentials.json 文件。服务名和账户名与 CLI 的写入方式保持一致：服务名为
// "Claude Code-credentials"，账户名为当前用户名。
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const claudeRateLimitGate = new ProviderRateLimitGate({ provider: "Claude" });
// OAuth 订阅 token 仅在第一个系统块与此字符串完全一致时才会被接受。
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// Opus 4.x 支持 128K 输出 token；Sonnet 4.6 / Haiku 4.5 的上限为 64K。
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
  // Tools render before `system` on the wire, so they sit inside whatever the
  // system breakpoint caches. Keep the list byte-stable for a process (see
  // kagami's system-prompt.ts note on the same invariant) or every change to it
  // rebuilds the prefix for every route.
  tools?: LlmToolDefinition[];
};

// The cached prefix as the API will actually see it: everything from the start
// of the request up to and including the last cache_control breakpoint. Reading
// it off the built body (rather than off the caller's messages) means the
// digest covers exactly what gets hashed on the other side, including the empty
// blocks buildClaudeMessages drops and the assistant tail it trims.
// A tool block carries its identity in fields other than `text`. Digesting it as
// the empty string would make two different tool calls look byte-identical, and
// the drift detector would report a rebuilt prefix as "unchanged" — the one
// safety net this migration has, reading clean while it is broken.
function describePrefixBlock(block: Record<string, unknown>): string {
  if (block.type === "tool_use") {
    return `tool_use:${String(block.id)}:${String(block.name)}:${JSON.stringify(block.input ?? null)}`;
  }
  if (block.type === "tool_result") {
    return `tool_result:${String(block.tool_use_id)}:${String(block.content ?? "")}`;
  }
  return typeof block.text === "string" ? block.text : "";
}

function collectClaudeCachedPrefixTexts(
  body: Record<string, unknown>,
): { systemTexts: string[]; blockTexts: string[] } {
  const systemTexts: string[] = [];
  const system = Array.isArray(body.system) ? body.system : [];
  for (const block of system) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    systemTexts.push(typeof record.text === "string" ? record.text : "");
    if (record.cache_control) break;
  }

  const blockTexts: string[] = [];
  const pending: string[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  outer: for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";
    const content = Array.isArray(record.content) ? record.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const inner = block as Record<string, unknown>;
      pending.push(`${role}:${describePrefixBlock(inner)}`);
      if (inner.cache_control) {
        // Everything buffered so far is inside the breakpoint; anything after
        // it is the volatile tail and deliberately not part of the identity.
        blockTexts.push(...pending);
        pending.length = 0;
        break outer;
      }
    }
  }

  return { systemTexts, blockTexts };
}

export function digestClaudeCachedPrefix(body: Record<string, unknown>): CachePrefixDigest {
  const { systemTexts, blockTexts } = collectClaudeCachedPrefixTexts(body);
  return buildCachePrefixDigest(systemTexts, blockTexts);
}

// How much of this request a cache entry could cover at all. Everything past
// the breakpoint is reread at full price no matter how stable it is, so this —
// not the request size — is the number to compare against the model's minimum.
export function measureClaudeCachedPrefixTokens(body: Record<string, unknown>): number {
  const { systemTexts, blockTexts } = collectClaudeCachedPrefixTexts(body);
  return estimatePromptTokens([...systemTexts, ...blockTexts].join("\n"));
}

// Two shapes of the same thing: the proxy dropped this attempt. undici reports a
// refused or reset connection as "fetch failed"; a connection that opens and
// then stalls surfaces instead as AbortSignal.timeout's TimeoutError. Only the
// first was retried, so a stalled request died outright while a refused one
// recovered — and the tool loop multiplies that exposure, since one agent turn
// makes several requests and any of them can stall.
// What actually went wrong, for a log line that can be correlated with anything.
// "fetch failed" alone is undici's outer wrapper and says nothing: the cause
// underneath distinguishes a refused connection from a dropped TLS handshake
// from a stalled read, and those have different fixes.
export function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : cause !== undefined ? String(cause) : "";
  const code = (cause as { code?: string } | undefined)?.code;
  return [error.name, error.message, causeText, code && `code=${code}`]
    .filter(Boolean)
    .join(" | ");
}

// Jittered so several in-flight calls that fail together do not all come back at
// the same instant and re-create the burst they are retrying through.
function retryDelayMs(attempt: number): number {
  const backoff = FETCH_FAILED_RETRY_DELAY_MS * Math.min(4, attempt);
  return Math.round(backoff * (0.7 + Math.random() * 0.6));
}

function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.toLowerCase().includes("fetch failed")) return true;
  return error.name === "TimeoutError";
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

// Hoist system-role turns into the system prompt and normalise the rest.
//
// The emptiness test has to match buildClaudeMessages': a turn is empty only
// when it has neither prose NOR structural blocks. Testing `content` alone
// predates tool calling and quietly destroyed every tool transcript that came
// through here — a tool_result turn is `{content: "", blocks: [...]}`, so it was
// dropped outright, and a turn that survived was rebuilt as `{role, content}`,
// which threw its blocks away. runToolLoop feeds the ConversationLedger through
// this function, so every focus loop began by flattening its own history:
// the model lost which tools it had called and what came back, and the prompt
// cache lost the prefix (the flattened shape can never match the structural one
// the previous loop ended on, so every route rebuilt on the next call).
//
// It failed silently rather than as a 400 because the damage was symmetric:
// tool_result turns are always empty and were dropped, and an assistant turn
// that kept its prose lost its tool_use with it — so no orphaned id ever
// reached the API to complain about.
export function splitSystemPrompt(messages: LlmMessage[], baseSystemPrompt: string): {
  systemPrompt: string;
  contents: LlmMessage[];
} {
  const systemBlocks = [baseSystemPrompt];
  const contents: LlmMessage[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    const blocks = messageHasStructuralBlocks(message) ? message.blocks : undefined;
    if (!content && !blocks) {
      continue;
    }

    if (message.role === "system") {
      // A system turn carries prose by definition; structural blocks have no
      // meaning there, so hoisting the text and dropping the rest is correct.
      if (content) systemBlocks.push(content);
      continue;
    }

    contents.push({
      role: message.role,
      content,
      ...(blocks ? { blocks } : {}),
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
      if (isRetryableTransportError(error) && fetchAttempts < FETCH_FAILED_MAX_ATTEMPTS) {
        const wait = retryDelayMs(fetchAttempts);
        console.warn(
          `[${new Date().toISOString()}] Codex transport failed (${fetchAttempts}/${FETCH_FAILED_MAX_ATTEMPTS}), retrying in ${Math.round(wait / 100) / 10}s: ${describeTransportError(error)}`,
        );
        await delay(wait);
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
type ClaudeMergedMessage = {
  role: "user" | "assistant";
  blocks: ClaudeMessageBlock[];
  // Tool turns are structural: the API matches each tool_use to its tool_result
  // by id, so these must not merge into a neighbour and must not be trimmed away
  // — losing either half of a pair is a 400, not a degraded prompt.
  structural?: LlmStructuralBlock[];
  // Structural blocks all come from one source message, so they share its
  // volatility. Tracked because the cache breakpoint may legally sit on them.
  structuralVolatile?: boolean;
};

function toClaudeStructuralBlock(block: LlmStructuralBlock): Record<string, unknown> {
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  return {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content,
    ...(block.isError ? { is_error: true } : {}),
  };
}

// One text block per source LlmMessage (conversation turn). Consecutive
// same-role turns merge into one API message but keep their block boundaries,
// allowing a cache marker to sit immediately before the volatile tail.
function buildClaudeMessages(messages: LlmMessage[], volatileTailMessages = 0): ClaudeMergedMessage[] {
  const merged: ClaudeMergedMessage[] = [];
  const volatileFrom = messages.length - Math.max(0, volatileTailMessages);

  for (const [index, message] of messages.entries()) {
    const content = message.content.trim();
    const structural = messageHasStructuralBlocks(message) ? message.blocks : undefined;
    if (!content && !structural) {
      continue;
    }

    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const volatile = index >= volatileFrom;
    const textBlocks: ClaudeMessageBlock[] = content ? [{ text: content, volatile }] : [];
    const last = merged[merged.length - 1];
    // 结构化轮次必须独立成一条消息，不能吸收后续轮次；否则合并会打乱 tool_use /
    // tool_result 块与模型原本配对正文之间的顺序。
    if (last && last.role === role && !structural && !last.structural) {
      last.blocks.push(...textBlocks);
    } else {
      merged.push({
        role,
        blocks: textBlocks,
        ...(structural ? { structural, structuralVolatile: volatile } : {}),
      });
    }
  }

  // Messages API 要求第一条消息必须是用户轮次。
  while (merged.length > 0 && merged[0].role === "assistant" && !merged[0].structural) {
    merged.shift();
  }

  // 最后一条消息也必须是用户轮次：末尾的助手消息会被当作预填充，而订阅/OAuth 模型
  // 不支持助手消息预填充。如果调用方的当前消息为空并在上方被丢弃，机器人的上一条
  // 回复就会落在末尾，因此需要移除。
  // 结构化助手轮次除外：工具循环中它后面会紧跟对应的 tool_result；删除它会让结果 ID
  // 失去所属的调用。
  while (
    merged.length > 0
    && merged[merged.length - 1].role === "assistant"
    && !merged[merged.length - 1].structural
  ) {
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
    content: [
      ...message.blocks.map((block) => ({ type: "text", text: block.text })),
      // 结构化块始终紧跟本轮正文，保持模型生成时的原始顺序。
      ...(message.structural ?? []).map(toClaudeStructuralBlock),
    ],
  }));

  if (cacheStablePrefix) {
    // Walk the wire content backwards, not just the text blocks: in a tool loop
    // the newest stable content is a tool_use/tool_result block, and skipping
    // those pins the breakpoint to the last prose turn — the growing transcript
    // would then never be cached at all.
    outer: for (let i = merged.length - 1; i >= 0; i -= 1) {
      const message = merged[i];
      const structuralCount = message.structural?.length ?? 0;
      const volatility = [
        ...message.blocks.map((block) => block.volatile),
        ...Array.from({ length: structuralCount }, () => message.structuralVolatile ?? false),
      ];
      for (let j = volatility.length - 1; j >= 0; j -= 1) {
        if (!volatility[j]) {
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

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  if (options.jsonSchema) {
    // Structured outputs guarantee the response is schema-valid JSON (GA on Opus 4.7 / Sonnet 4.6).
    // Verified to coexist with `tools` on this transport.
    body.output_config = { format: { type: "json_schema", schema: options.jsonSchema } };
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
  inspectBody: (body: Record<string, unknown>) => void = () => {},
): Promise<string> {
  const data = await requestClaudeMessage(model, systemPrompt, messages, options, recordUsage, inspectBody);
  return extractClaudeText(data);
}

// The whole transport — auth retry, credential rotation, fetch retry, rate-limit
// gate, usage capture — in one place, returning the raw message so both the
// text path and the tool loop get identical handling.
async function requestClaudeMessage(
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  options: ClaudeRequestOptions = {},
  recordUsage: (usage: TokenUsageBreakdown) => void,
  inspectBody: (body: Record<string, unknown>) => void = () => {},
): Promise<Record<string, unknown>> {
  const rateLimitRevision = claudeRateLimitGate.beginRequest();
  let creds = await getClaudeCredentials();
  const body = buildClaudeRequestBody(model, systemPrompt, messages, options);
  // Before the wire, and before any retry: the prefix is a property of the
  // request we built, not of whether it happened to succeed.
  inspectBody(body);
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
      if (isRetryableTransportError(error) && fetchAttempts < FETCH_FAILED_MAX_ATTEMPTS) {
        const wait = retryDelayMs(fetchAttempts);
        console.warn(
          `[${new Date().toISOString()}] Claude transport failed (${fetchAttempts}/${FETCH_FAILED_MAX_ATTEMPTS}), retrying in ${Math.round(wait / 100) / 10}s: ${describeTransportError(error)}`,
        );
        await delay(wait);
        continue;
      }
      if (isRetryableTransportError(error)) {
        // Out of attempts. Say so explicitly: the alternative is a bare stack
        // trace that looks identical to a code defect.
        console.error(
          `[${new Date().toISOString()}] Claude transport gave up after ${fetchAttempts} attempts: ${describeTransportError(error)}`,
        );
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
    const data = await res.json() as Record<string, unknown>;
    const tokens = readClaudeUsageTokens(data);
    if (tokens) {
      recordUsage({ ...tokens, cacheablePrefixTokens: measureClaudeCachedPrefixTokens(body) });
    }
    return data;
  }

  throw new Error("Claude request failed after retry.");
}

// A loop with no ceiling is a loop that can spend the whole budget on one
// confused turn. Each round is a full request carrying the whole transcript, so
// the cost of a runaway grows quadratically, not linearly.
const CLAUDE_TOOL_LOOP_MAX_ROUNDS = 12;

export type ClaudeToolLoopResult = {
  text: string;
  messages: LlmMessage[];
  rounds: number;
  // True when the ceiling cut the loop off with the model still asking for
  // tools. The caller has a partial answer, not a finished one — never present
  // it as complete.
  exhausted: boolean;
};

export function parseClaudeToolUses(data: Record<string, unknown>): LlmToolUseBlock[] {
  const content = Array.isArray(data.content) ? data.content : [];
  const uses: LlmToolUseBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "tool_use") continue;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    uses.push({
      type: "tool_use",
      id: record.id,
      name: record.name,
      input: (record.input && typeof record.input === "object" ? record.input : {}) as Record<string, unknown>,
    });
  }
  return uses;
}

// Drives tool_use -> tool_result -> end_turn against the same transport as every
// other Claude call. `messages` is grown, never rewritten: each round appends the
// assistant turn and one user turn holding every result, which is both what the
// API requires and what keeps the prompt-cache prefix extending instead of
// rebuilding.
export async function runClaudeToolLoop(input: {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  runTool: (call: LlmToolUseBlock) => Promise<string>;
  options?: ClaudeRequestOptions;
  recordUsage: (usage: TokenUsageBreakdown) => void;
  // round 从 1 开始。调用方靠它区分「内容来自调用方的第一轮」和「循环自己追加出来的后续轮次」。
  inspectBody?: (body: Record<string, unknown>, round: number) => void;
  maxRounds?: number;
  // Called as each turn is decided, before the next request goes out. This is
  // the seam for an owner of the transcript (ConversationLedger): the loop stays
  // transport-level and ledger-agnostic, while the ledger still sees every turn
  // in order rather than being reconciled against a returned array afterwards.
  onAssistantTurn?: (text: string, toolUses: LlmToolUseBlock[]) => void;
  onToolResults?: (results: LlmToolResultBlock[]) => void;
}): Promise<ClaudeToolLoopResult> {
  const maxRounds = Math.max(1, input.maxRounds ?? CLAUDE_TOOL_LOOP_MAX_ROUNDS);
  const messages: LlmMessage[] = [...input.messages];
  const inspectBody = input.inspectBody;
  let lastText = "";

  for (let round = 1; round <= maxRounds; round += 1) {
    const data = await requestClaudeMessage(
      input.model,
      input.systemPrompt,
      messages,
      { ...input.options, tools: input.tools },
      input.recordUsage,
      inspectBody ? (body) => inspectBody(body, round) : undefined,
    );

    const text = extractClaudeText(data);
    if (text) lastText = text;

    const toolUses = parseClaudeToolUses(data);
    if (toolUses.length === 0) {
      // 一个字都不调工具就收尾，是这条管线上最常见的一轮：大多数群消息本来就不需要她
      // 出声，FOCUS_LOOP_PROMPT 也明写这是合法选择。但这一轮她通常不是什么都没干——
      // 她看了消息、想了一遍、决定不接话。以前这段话只作为 lastText 进监控页，account
      // 里一个字都不留，于是下一轮她看到的是同一批消息和一片空白：不知道自己已经看过，
      // 也不知道当时为什么决定放着。留下来，她才接得上自己的上一个念头。
      //
      // 代价是账本长得更快、压缩来得更勤。这是想清楚之后认的：planLedgerCompaction 本来
      // 就按 token 阈值走，多出来的这些字只是让那条线早一点到。
      //
      // 空 text 要跳过。appendAssistantTurn 对「既没有话也没有工具调用」是直接 throw 的，
      // 那种空轮确实没有任何东西值得留。
      if (text) {
        messages.push({ role: "assistant", content: text });
        input.onAssistantTurn?.(text, []);
      }
      return { text: lastText, messages, rounds: round, exhausted: false };
    }

    messages.push({ role: "assistant", content: text, blocks: toolUses });
    input.onAssistantTurn?.(text, toolUses);

    // Every result rides in ONE user turn. Splitting them across turns is
    // accepted by the API but teaches the model to stop calling tools in
    // parallel, which costs a round trip on every later multi-tool turn.
    const results: LlmToolResultBlock[] = [];
    for (const call of toolUses) {
      try {
        results.push({ type: "tool_result", toolUseId: call.id, content: await input.runTool(call) });
      } catch (error) {
        // A thrown tool still owes the model a result: an unanswered tool_use id
        // is a 400 on the next round, turning one tool bug into a dead loop.
        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    }
    messages.push({ role: "user", content: "", blocks: results });
    input.onToolResults?.(results);
  }

  return { text: lastText, messages, rounds: maxRounds, exhausted: true };
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

export async function createLlmClient(
  configPath: string,
  requestedProfileName?: string,
  options: { cachePrefixObserver?: CachePrefixObserver } = {},
): Promise<LlmClient> {
  const profile = await resolveLlmProfile(configPath, requestedProfileName);
  const usageQueue = new TokenUsageQueue(profile.model);
  // Bound per call rather than once per client: the purpose belongs to the
  // request that produced the usage, and concurrent calls must not share it.
  const recordUsageFor = (purpose: LlmCallPurpose) => (usage: TokenUsageBreakdown): void =>
    usageQueue.record(usage, purpose);

  // Per client, so two profiles pointed at different models never compare
  // prefixes with each other: a cache entry belongs to one model.
  const prefixTracker = new CachePrefixTracker();
  const inspectPrefixFor = (
    purpose: LlmCallPurpose,
    cacheRoute: string,
    expectRebuild: boolean,
  ) => (body: Record<string, unknown>): void => {
    const observer = options.cachePrefixObserver;
    if (!observer) return;
    const inspection = prefixTracker.inspect(
      `${profile.model}|${cacheRoute}`,
      digestClaudeCachedPrefix(body),
    );
    observer({ ...inspection, model: profile.model, purpose, expectRebuild });
  };

  return {
    profileName: profile.name,
    provider: profile.provider,
    model: profile.model,
    systemPrompt: profile.systemPrompt,
    displayName: `${profile.name} (${profile.model})`,
    consumeTokenUsage: () => usageQueue.consume(),
    async runToolLoop(input): Promise<ClaudeToolLoopResult> {
      if (profile.provider !== "claude") {
        // Tool use here is the Anthropic Messages shape; Codex would need its
        // own translation. Fail loudly rather than silently answering without
        // the tools the caller depends on.
        throw new Error(`runToolLoop is not implemented for provider '${profile.provider}'.`);
      }
      const { systemPrompt, contents } = splitSystemPrompt(
        input.messages,
        input.systemPrompt ?? profile.systemPrompt,
      );
      return runClaudeToolLoop({
        model: profile.model,
        systemPrompt,
        messages: contents,
        tools: input.tools,
        runTool: input.runTool,
        options: { cacheStablePrefix: true, volatileTailMessages: 1 },
        recordUsage: recordUsageFor(input.purpose),
        // 按循环轮数而不是消息轮次检查：每轮循环都是独立请求，而循环途中前缀停止延长
        // 正是账本设计要阻止的回归。
        // expectRebuild 只交给第一轮，原因见 LlmClient.runToolLoop 的类型说明。
        inspectBody: (body, round) =>
          inspectPrefixFor(input.purpose, input.cacheRoute, round === 1 && (input.expectRebuild ?? false))(body),
        maxRounds: input.maxRounds,
        onAssistantTurn: input.onAssistantTurn,
        onToolResults: input.onToolResults,
      });
    },
    async generateText(input): Promise<string> {
      const recordUsage = recordUsageFor(input.purpose);
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
            // 生产环境中每个 generateText 调用方都会把本次请求输入放在最后一条
            // LlmMessage 中，因此缓存它前面的稳定历史。
            volatileTailMessages: 1,
          },
          recordUsage,
          inspectPrefixFor(input.purpose, input.cacheRoute, input.expectRebuild ?? false),
        );
      }

      // Codex 按 prompt_cache_key 及自身前缀规则缓存，且不报告可供摘要的断点，
      // 因此这里没有可检查内容。
      return requestCodexText(profile.model, systemPrompt, contents, recordUsage);
    },
  };
}
