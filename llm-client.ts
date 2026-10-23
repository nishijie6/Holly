import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { LlmHttpError, ProviderRateLimitGate, type ProviderQuotaAvailability } from "./connection-watchdog.js";
import {
  TokenUsageQueue,
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

// A tool call and its result share an ID. Preserve both halves when translating
// the transcript to Responses input items.
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
  // Raw Responses output preserves encrypted reasoning and original call IDs.
  responseItems?: Record<string, unknown>[];
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function messageHasStructuralBlocks(message: LlmMessage): boolean {
  return Array.isArray(message.blocks) && message.blocks.length > 0;
}

export type LlmProvider = "codex";

type CodexProfileConfig = {
  provider: "codex";
  model?: string;
  system_prompt?: string;
};

export type LlmProfileConfig = CodexProfileConfig;

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
  // 取出并清空这个 client 记下的全部用量。只给「取空」不给「取一条」：一次工具循环有几轮
  // 就有几条，逐条取必然漏取、越积越多（见 TokenUsageQueue.drain）。
  drainTokenUsage(): import("./token-usage.js").CallTokenUsage[];
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
    // 调用方可为整理摘要等任务显式指定超时；未指定时采用客户端默认窗口。
    timeoutMs?: number;
    maxAttempts?: number;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    // 只在没有悬空工具调用的边界让出执行权，调用方随后可安全处理新消息。
    shouldYield?: () => boolean;
    onAssistantTurn?: (text: string, toolUses: LlmToolUseBlock[], responseItems?: Record<string, unknown>[]) => void;
    onToolResults?: (results: LlmToolResultBlock[]) => void;
  }): Promise<ToolLoopResult>;
};

// Best-effort diagnostics for every Codex request. main.ts
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

export type CodexRequestOptions = {
  tools?: LlmToolDefinition[];
  jsonSchema?: Record<string, unknown>;
  cacheRoute?: string;
  volatileTailMessages?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
};

type CodexRequestBody = Record<string, unknown> & {
  model: string;
  input: Record<string, unknown>[];
  instructions: string;
  prompt_cache_key: string;
  store: false;
  stream: true;
};

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Keep answers clear and concise.";
const KEYCHAIN_SERVICE = "Codex Auth";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_AUTH_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_PROMPT_CACHE_NAMESPACE = "tsbot-group-chat";
const PROJECT_AUTH_PATH = path.join(process.cwd(), ".codex", "auth.json");
const HOME_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_BUFFER_MS = 300_000;
// Max reasoning can exceed 30 seconds even for ordinary decision requests.
// Allow a complete response instead of repeatedly aborting and re-reading it.
const REQUEST_TIMEOUT_MS = 120_000;
const FETCH_FAILED_MAX_ATTEMPTS = 5;
const FETCH_FAILED_RETRY_DELAY_MS = 3_000;
const DEBUG_REQUEST = process.env.CODEX_DEBUG_REQUEST === "1";
const codexRateLimitGate = new ProviderRateLimitGate({ provider: "Codex" });

// Codex's transport uses session identity for cache routing in addition to the
// prompt cache key. Keep each model/route on one identity across text calls,
// tool rounds and retries; bound idle routes for the long-running process.
const codexSessionIds = new Map<string, string>();
const MAX_CODEX_SESSION_ROUTES = 64;
function codexSessionId(cacheKey: string): string {
  const id = codexSessionIds.get(cacheKey) ?? randomUUID();
  codexSessionIds.delete(cacheKey);
  codexSessionIds.set(cacheKey, id);
  while (codexSessionIds.size > MAX_CODEX_SESSION_ROUTES) {
    const oldest = codexSessionIds.keys().next();
    if (oldest.done) break;
    codexSessionIds.delete(oldest.value);
  }
  return id;
}

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
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const cause = error.cause;
  const code = (error as Error & { code?: unknown }).code
    ?? (cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined);
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(String(code));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConfig(configPath: string): Promise<AppConfig> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}. Copy config.example.yaml to config.yaml and fill in your local settings before starting Holly.`,
    );
  }

  const raw = await readFile(configPath, "utf-8");
  return (YAML.parse(raw) as AppConfig | null) ?? {};
}

async function saveConfig(configPath: string, config: AppConfig): Promise<void> {
  const body = YAML.stringify(config);
  await writeFile(configPath, body, "utf-8");
}

// Hoist system turns while preserving tool transcripts and Responses metadata.
export function splitSystemPrompt(messages: LlmMessage[], baseSystemPrompt: string): {
  systemPrompt: string;
  contents: LlmMessage[];
} {
  const systemBlocks = [baseSystemPrompt];
  const contents: LlmMessage[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    const blocks = messageHasStructuralBlocks(message) ? message.blocks : undefined;
    const responseItems = message.responseItems?.length ? message.responseItems : undefined;
    if (!content && !blocks && !responseItems) {
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
      ...(responseItems ? { responseItems } : {}),
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
      const raw = execFileSync(
        "security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
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

// Codex chooses cache boundaries internally. Track only the caller's stable
// prefix as a diagnostic; this is not a server-confirmed cache breakpoint.
const stableInputCounts = new WeakMap<object, number>();

function codexMessageItems(message: LlmMessage): Record<string, unknown>[] {
  if (message.responseItems?.length) return message.responseItems;
  const items: Record<string, unknown>[] = [];
  const content = message.content.trim();
  if (content) items.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  for (const block of message.blocks ?? []) {
    items.push(block.type === "tool_use"
      ? { type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) }
      : { type: "function_call_output", call_id: block.toolUseId, output: block.isError ? `Tool error: ${block.content}` : block.content });
  }
  return items;
}

export function buildCodexRequestBody(
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  options: CodexRequestOptions = {},
): CodexRequestBody {
  assertGptModel(model);
  const { systemPrompt: instructions, contents } = splitSystemPrompt(messages, systemPrompt);
  const input = contents.flatMap(codexMessageItems);
  const stableMessages = contents.slice(0, Math.max(0, contents.length - (options.volatileTailMessages ?? 0)));
  const body: CodexRequestBody = {
    model,
    input,
    instructions,
    prompt_cache_key: `${CODEX_PROMPT_CACHE_NAMESPACE}:${model}:${options.cacheRoute ?? "default"}`,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(options.reasoningEffort
      ? { reasoning: { effort: options.reasoningEffort } }
      : model === "gpt-6.1-sol"
      ? { reasoning: { effort: "max" } }
      : model === "gpt-5.4" ? { reasoning: { effort: "medium" } } : {}),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({
      type: "function", name: tool.name, description: tool.description,
      parameters: tool.inputSchema, strict: false,
    })) } : {}),
    ...(options.jsonSchema ? { text: { format: {
      type: "json_schema", name: "holly_response", strict: true, schema: options.jsonSchema,
    } } } : {}),
  };
  stableInputCounts.set(body, stableMessages.flatMap(codexMessageItems).length);
  return body;
}

export function digestCodexCachedPrefix(body: Record<string, unknown>): CachePrefixDigest {
  const input = Array.isArray(body.input) ? body.input : [];
  return buildCachePrefixDigest(
    [String(body.instructions ?? ""), JSON.stringify(body.tools ?? []), JSON.stringify(body.text ?? null)],
    input.slice(0, stableInputCounts.get(body) ?? input.length).map(item => JSON.stringify(item)),
  );
}

export function readCodexUsageTokens(data: unknown): TokenUsageBreakdown | null {
  if (!data || typeof data !== "object") return null;
  const usage = (data as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  const inputTokens = num(u.input_tokens);
  const details = u.input_tokens_details && typeof u.input_tokens_details === "object"
    ? u.input_tokens_details as Record<string, unknown> : {};
  const cacheReadInputTokens = Math.min(inputTokens, num(details.cached_tokens));
  const cacheCreationInputTokens = Math.min(inputTokens - cacheReadInputTokens, num(details.cache_write_tokens));
  const outputTokens = num(u.output_tokens);
  if (!inputTokens && !outputTokens) return null;
  return {
    inputTokens, uncachedInputTokens: inputTokens - cacheReadInputTokens - cacheCreationInputTokens,
    cacheCreationInputTokens, cacheReadInputTokens, outputTokens,
  };
}

function responseError(response: Record<string, unknown>): Error {
  const error = response.error as { message?: string } | undefined;
  const details = response.incomplete_details as { reason?: string } | undefined;
  return new Error(`Codex response ${String(response.status ?? "failed")}: ${error?.message ?? details?.reason ?? "stream did not complete"}`);
}

// Consume complete SSE frames, including the final frame without a newline.
// Completed items replace their partial/delta form rather than duplicating it.
async function readCodexResponse(res: Response): Promise<Record<string, unknown>> {
  if (res.headers.get("content-type")?.includes("application/json")) {
    const response = await res.json() as Record<string, unknown>;
    if (response.status && response.status !== "completed") throw responseError(response);
    return response;
  }
  if (!res.body) throw new Error("Codex response stream has no body.");
  const items = new Map<number, Record<string, unknown>>();
  const itemIndexes = new Map<string, number>();
  const textDeltas = new Map<string, string>();
  let completed: Record<string, unknown> | null = null;
  const handleEvent = (payload: string): void => {
    if (!payload.trim() || payload.trim() === "[DONE]") return;
    const event = JSON.parse(payload) as Record<string, unknown>;
    const type = String(event.type ?? "");
    if (type === "error" || type === "response.failed" || type === "response.incomplete") {
      const response = event.response && typeof event.response === "object"
        ? event.response as Record<string, unknown> : { status: "failed", error: event.error ?? event };
      throw responseError(response);
    }
    if ((type === "response.completed" || type === "response.done") && event.response && typeof event.response === "object") {
      const response = event.response as Record<string, unknown>;
      if (response.status && response.status !== "completed") throw responseError(response);
      completed = response;
      return;
    }
    if ((type === "response.output_item.added" || type === "response.output_item.done") && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      const index = typeof event.output_index === "number" ? event.output_index : items.size;
      items.set(index, item);
      if (typeof item.id === "string") itemIndexes.set(item.id, index);
      return;
    }
    const index = typeof event.output_index === "number" ? event.output_index
      : typeof event.item_id === "string" ? itemIndexes.get(event.item_id) : undefined;
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const item = index === undefined ? undefined : items.get(index);
      if (!item) throw new Error("Codex function arguments arrived without a function call item.");
      item.arguments = type.endsWith(".done") ? String(event.arguments ?? "")
        : String(item.arguments ?? "") + String(event.delta ?? "");
    }
    if (type === "response.output_text.delta" || type === "response.output_text.done") {
      const key = `${index ?? 0}:${event.content_index ?? 0}`;
      textDeltas.set(key, type.endsWith(".done") ? String(event.text ?? "")
        : (textDeltas.get(key) ?? "") + String(event.delta ?? ""));
    }
  };
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  const flushEvent = (): void => {
    if (dataLines.length) handleEvent(dataLines.join("\n"));
    dataLines = [];
  };
  const consumeLine = (line: string): void => {
    line = line.replace(/\r$/, "");
    if (!line) flushEvent();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  flushEvent();
  if (!completed) throw new Error("Codex response stream ended before completion.");
  const response = completed as Record<string, unknown>;
  if (!Array.isArray(response.output) || response.output.length === 0) {
    response.output = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  }
  if (!extractCodexText(response) && textDeltas.size) response.output_text = [...textDeltas.values()].join("");
  return response;
}

function extractCodexText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string") return response.output_text.trim();
  const texts: string[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!item || typeof item !== "object" || item.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.join("").trim();
}

async function requestCodexResponse(
  body: CodexRequestBody,
  recordUsage: (usage: TokenUsageBreakdown) => void,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = FETCH_FAILED_MAX_ATTEMPTS,
): Promise<Record<string, unknown>> {
  if (codexRateLimitGate.getPausedUntil() !== null) {
    // 仅查询额度，不生成探测回复；失败仍由原来的暂停闸拦下，不能当成额度已恢复。
    await refreshCodexUsage(false).catch(() => null);
  }
  const rateLimitRevision = codexRateLimitGate.beginRequest();
  const sessionId = codexSessionId(body.prompt_cache_key);
  let creds = await getCodexCredentials();
  let fetchAttempts = 0;
  let authAttempt = 0;
  while (authAttempt < 2) {
    const headers = buildCodexHeaders(creds);
    headers.session_id = sessionId;
    headers.Accept = "text/event-stream";
    logCodexRequest(body, headers);
    let res: Response;
    try {
      fetchAttempts += 1;
      res = await fetch(CODEX_RESPONSES_URL, {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isRetryableTransportError(error) && fetchAttempts < maxAttempts) {
        const wait = retryDelayMs(fetchAttempts);
        console.warn(`[${new Date().toISOString()}] Codex transport failed (${fetchAttempts}/${maxAttempts}), retrying in ${Math.round(wait / 100) / 10}s: ${describeTransportError(error)}`);
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
        ? codexRateLimitGate.pauseUntil(parseUsageResetMs(res.headers.get("x-codex-primary-reset-at"))) : null;
      throw new LlmHttpError("Codex", res.status, (errorText || "<empty>").slice(0, 2_000), retryAt);
    }
    // A response is successful only after the streamed completion arrives.
    let data: Record<string, unknown>;
    try {
      data = await readCodexResponse(res);
    } catch (error) {
      if (isRetryableTransportError(error) && fetchAttempts < maxAttempts) {
        const wait = retryDelayMs(fetchAttempts);
        console.warn(`[${new Date().toISOString()}] Codex response stream failed (${fetchAttempts}/${maxAttempts}), retrying in ${Math.round(wait / 100) / 10}s: ${describeTransportError(error)}`);
        await delay(wait);
        continue;
      }
      throw error;
    }
    const usage = readCodexUsageTokens(data);
    if (usage) recordUsage(usage);
    codexRateLimitGate.recordSuccess(rateLimitRevision);
    return data;
  }
  throw new Error("Codex request failed after retry.");
}

export type ProviderUsageWindow = {
  id: "primary" | "secondary";
  windowDurationMins: number | null;
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
};
export type ProviderUsage = {
  windows: ProviderUsageWindow[];
  capturedAt: number;
};
let latestProviderUsage: ProviderUsage | null = null;
export function getLatestProviderUsage(): ProviderUsage | null { return latestProviderUsage; }

function parseUsageNumber(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}
function parseUsageResetMs(value: unknown): number | null {
  const numeric = parseUsageNumber(value);
  if (numeric === null) return null;
  const milliseconds = numeric * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
function parseUsagePercent(value: unknown): number | null {
  const numeric = parseUsageNumber(value);
  return numeric === null ? null : numeric / 100;
}
function codexUsageStatus(utilization: number | null): string | null {
  return utilization === null ? null : utilization >= 1 ? "limited" : "allowed";
}
function readCodexUsageWindows(headers: Headers): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const windowDurationMins = parseUsageNumber(headers.get(`x-codex-${id}-window-minutes`));
    // Codex uses a zero-minute window to signal that this quota is disabled.
    if (windowDurationMins === 0) continue;
    const utilization = parseUsagePercent(headers.get(`x-codex-${id}-used-percent`));
    const resetAt = parseUsageResetMs(headers.get(`x-codex-${id}-reset-at`));
    if (windowDurationMins === null && utilization === null && resetAt === null) continue;
    windows.push({ id, windowDurationMins, utilization, resetAt, status: codexUsageStatus(utilization) });
  }
  return windows;
}
function captureCodexUsage(res: Response): void {
  const hasQuotaHeaders = ["primary", "secondary"].some(id =>
    ["window-minutes", "used-percent", "reset-at"].some(field => res.headers.has(`x-codex-${id}-${field}`)),
  );
  if (!hasQuotaHeaders) return;
  const windows = readCodexUsageWindows(res.headers);
  latestProviderUsage = { windows, capturedAt: Date.now() };
}

function parseCodexQuota(data: unknown): { usage: ProviderUsage; availability: ProviderQuotaAvailability | null } | null {
  if (!data || typeof data !== "object") return null;
  const rate = (data as Record<string, unknown>).rate_limit;
  if (!rate || typeof rate !== "object") return null;
  const limit = rate as Record<string, unknown>;
  const windows: ProviderUsageWindow[] = [];
  let malformedWindow = false;
  for (const id of ["primary", "secondary"] as const) {
    const value = limit[`${id}_window`];
    if (value === null || value === undefined) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      malformedWindow = true;
      windows.push({ id, windowDurationMins: null, utilization: null, resetAt: null, status: null });
      continue;
    }
    const window = value as Record<string, unknown>;
    const seconds = parseUsageNumber(window.limit_window_seconds);
    if (seconds === 0) continue;
    const utilization = parseUsagePercent(window.used_percent);
    const resetAt = parseUsageResetMs(window.reset_at == null ? null : String(window.reset_at));
    windows.push({ id, windowDurationMins: seconds === null ? null : seconds / 60, utilization, resetAt, status: codexUsageStatus(utilization) });
  }
  const exhausted = windows.filter(window => window.utilization !== null && window.utilization >= 1);
  let availability: ProviderQuotaAvailability | null = null;
  if (limit.allowed === false || limit.limit_reached === true || exhausted.length > 0) {
    const resets = exhausted.flatMap(window => window.resetAt !== null && window.resetAt > Date.now() ? [window.resetAt] : []);
    availability = { available: false, retryAt: resets.length ? Math.max(...resets) : null };
  } else if (!malformedWindow && (limit.allowed === true || (windows.length > 0 && windows.every(window => window.utilization !== null && window.utilization < 1)))) {
    availability = { available: true, retryAt: null };
  }
  return { usage: { windows, capturedAt: Date.now() }, availability };
}

async function refreshCodexUsage(force: boolean): Promise<ProviderUsage | null> {
  await codexRateLimitGate.refresh(async (revision) => {
    let creds = await getCodexCredentials();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(CODEX_USAGE_URL, {
        headers: buildCodexHeaders(creds), signal: AbortSignal.timeout(10_000),
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0 && creds.refreshToken) {
        const refreshed = await refreshCodexCredentials(creds).catch(() => null);
        if (refreshed) { creds = refreshed; continue; }
      }
      if (!res.ok) throw new LlmHttpError("Codex usage", res.status, "Could not refresh usage limits.", null);
      const quota = parseCodexQuota(await res.json());
      if (!quota) throw new Error("Codex usage endpoint returned no recognizable quota information.");
      // 正在查询时若来了新的 429，旧查询不得覆盖新额度快照或解除新暂停。
      if (codexRateLimitGate.getRevision() === revision) latestProviderUsage = quota.usage;
      return quota.availability;
    }
    return null;
  }, force);
  return getLatestProviderUsage();
}

export type ToolLoopResult = { text: string; messages: LlmMessage[]; rounds: number; exhausted: boolean; yielded?: boolean };
const TOOL_LOOP_MAX_ROUNDS = 12;

function parseFunctionArguments(item: Record<string, unknown>): Record<string, unknown> {
  try {
    const value = JSON.parse(String(item.arguments ?? ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid function arguments for tool '${String(item.name)}'.`);
  }
}

export function parseCodexToolUses(data: Record<string, unknown>): LlmToolUseBlock[] {
  return (Array.isArray(data.output) ? data.output : []).filter(item => item?.type === "function_call").map(item => {
    if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) {
      throw new Error("Codex function call is missing its call_id or name.");
    }
    return { type: "tool_use", id: item.call_id, name: item.name, input: parseFunctionArguments(item) };
  });
}

export async function runToolLoop(input: {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  runTool: (call: LlmToolUseBlock) => Promise<string>;
  options?: CodexRequestOptions;
  recordUsage: (usage: TokenUsageBreakdown) => void;
  inspectBody?: (body: Record<string, unknown>, round: number) => void;
  maxRounds?: number;
  shouldYield?: () => boolean;
  onAssistantTurn?: (text: string, toolUses: LlmToolUseBlock[], responseItems?: Record<string, unknown>[]) => void;
  onToolResults?: (results: LlmToolResultBlock[]) => void;
}): Promise<ToolLoopResult> {
  const maxRounds = Math.max(1, Math.floor(input.maxRounds ?? TOOL_LOOP_MAX_ROUNDS));
  if (!Number.isFinite(maxRounds)) throw new Error("maxRounds must be finite.");
  const messages = [...input.messages];
  const availableTools = new Set(input.tools.map(tool => tool.name));
  let lastText = "";
  for (let round = 1; round <= maxRounds; round++) {
    if (input.shouldYield?.()) {
      return { text: lastText, messages, rounds: round - 1, exhausted: false, yielded: true };
    }
    const body = buildCodexRequestBody(input.model, input.systemPrompt, messages, { ...input.options, tools: input.tools });
    input.inspectBody?.(body, round);
    const data = await requestCodexResponse(body, input.recordUsage, input.options?.timeoutMs, input.options?.maxAttempts);
    const text = extractCodexText(data);
    if (text) lastText = text;
    const responseItems = (Array.isArray(data.output) ? data.output : []) as Record<string, unknown>[];
    const calls = responseItems.filter(item => item?.type === "function_call");
    const invalid = new Map<string, string>();
    const toolUses: LlmToolUseBlock[] = calls.map(item => {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) {
        throw new Error("Codex function call is missing its call_id or name.");
      }
      let args: Record<string, unknown> = {};
      try { args = parseFunctionArguments(item); }
      catch (error) { invalid.set(item.call_id, (error as Error).message); }
      if (!availableTools.has(item.name)) invalid.set(item.call_id, `Unknown tool '${item.name}'.`);
      return { type: "tool_use", id: item.call_id, name: item.name, input: args };
    });
    if (!toolUses.length) {
      if (text || responseItems.length) {
        messages.push({ role: "assistant", content: text, ...(responseItems.length ? { responseItems } : {}) });
        input.onAssistantTurn?.(text, [], responseItems);
      }
      return { text: lastText, messages, rounds: round, exhausted: false };
    }
    messages.push({ role: "assistant", content: text, blocks: toolUses, responseItems });
    input.onAssistantTurn?.(text, toolUses, responseItems);
    const results: LlmToolResultBlock[] = [];
    for (const call of toolUses) {
      try {
        const invalidReason = invalid.get(call.id);
        if (invalidReason) throw new Error(invalidReason);
        results.push({ type: "tool_result", toolUseId: call.id, content: await input.runTool(call) });
      } catch (error) {
        results.push({ type: "tool_result", toolUseId: call.id, content: error instanceof Error ? error.message : String(error), isError: true });
      }
    }
    messages.push({ role: "user", content: "", blocks: results });
    input.onToolResults?.(results);
    if (input.shouldYield?.()) {
      return { text: lastText, messages, rounds: round, exhausted: false, yielded: true };
    }
  }
  return { text: lastText, messages, rounds: maxRounds, exhausted: true };
}

export async function probeProviderUsage(model: string): Promise<ProviderUsage | null> {
  assertGptModel(model);
  return refreshCodexUsage(true);
}

function assertGptModel(model: string): void {
  if (!/^gpt-\d[\w.-]*$/.test(model)) throw new Error(`Unsupported GPT model '${model}'. Configure a gpt-* model with provider 'codex'.`);
}

function validateProfile(profile: LlmProfileConfig, name: string, configPath: string): string {
  if (profile.provider !== "codex") throw new Error(`Unsupported provider '${(profile as { provider?: string }).provider}' for '${name}'. Only 'codex' is supported.`);
  const model = profile.model?.trim();
  if (!model) throw new Error(`Missing 'model' for llm profile '${name}' in ${configPath}.`);
  assertGptModel(model);
  return model;
}

export async function resolveLlmProfile(configPath: string, requestedProfileName?: string): Promise<ResolvedLlmProfile> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  if (!llm?.profiles || !Object.keys(llm.profiles).length) throw new Error(`Missing 'llm.profiles' in ${configPath}.`);
  const name = requestedProfileName?.trim() || llm.active?.trim();
  if (!name) throw new Error(`Missing 'llm.active' in ${configPath}.`);
  const profile = llm.profiles[name];
  if (!profile) throw new Error(`LLM profile '${name}' not found in ${configPath}.`);
  return { name, provider: "codex", model: validateProfile(profile, name, configPath), systemPrompt: profile.system_prompt ?? llm.system_prompt ?? DEFAULT_SYSTEM_PROMPT };
}

export async function listLlmProfiles(configPath: string): Promise<{ active: string; decision: string; profiles: LlmProfileSummary[] }> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  if (!llm?.profiles || !Object.keys(llm.profiles).length) throw new Error(`Missing 'llm.profiles' in ${configPath}.`);
  const active = llm.active?.trim();
  if (!active) throw new Error(`Missing 'llm.active' in ${configPath}.`);
  if (!llm.profiles[active]) throw new Error(`LLM profile '${active}' not found in ${configPath}.`);
  const decision = llm.decision_profile?.trim() || active;
  if (!llm.profiles[decision]) throw new Error(`LLM decision profile '${decision}' not found in ${configPath}.`);
  const profiles = Object.entries(llm.profiles).map(([name, profile]): LlmProfileSummary => {
    const model = validateProfile(profile, name, configPath);
    return { name, provider: "codex", model, displayName: `${name} (${model})` };
  });
  return { active, decision, profiles };
}

export async function setActiveLlmProfile(configPath: string, profileName: string): Promise<void> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  const target = profileName.trim();
  if (!target) throw new Error("profileName is required.");
  if (!llm?.profiles?.[target]) throw new Error(`LLM profile '${target}' not found in ${configPath}.`);
  validateProfile(llm.profiles[target], target, configPath);
  config.llm = { ...llm, active: target };
  await saveConfig(configPath, config);
}

export async function createLlmClient(
  configPath: string,
  requestedProfileName?: string,
  options: { cachePrefixObserver?: CachePrefixObserver } = {},
): Promise<LlmClient> {
  const profile = await resolveLlmProfile(configPath, requestedProfileName);
  const usageQueue = new TokenUsageQueue(profile.model);
  const prefixTracker = new CachePrefixTracker();
  const recordUsageFor = (purpose: LlmCallPurpose) => (usage: TokenUsageBreakdown): void => usageQueue.record(usage, purpose);
  const inspectPrefix = (body: Record<string, unknown>, purpose: LlmCallPurpose, cacheRoute: string, expectRebuild: boolean): void => {
    if (!options.cachePrefixObserver) return;
    const inspection = prefixTracker.inspect(`${profile.model}|${cacheRoute}`, digestCodexCachedPrefix(body));
    options.cachePrefixObserver({ ...inspection, model: profile.model, purpose, expectRebuild });
  };
  return {
    profileName: profile.name, provider: "codex", model: profile.model, systemPrompt: profile.systemPrompt,
    displayName: `${profile.name} (${profile.model})`, drainTokenUsage: () => usageQueue.drain(),
    async runToolLoop(input): Promise<ToolLoopResult> {
      const { systemPrompt, contents } = splitSystemPrompt(input.messages, input.systemPrompt ?? profile.systemPrompt);
      return runToolLoop({
        model: profile.model, systemPrompt, messages: contents, tools: input.tools, runTool: input.runTool,
        options: {
          cacheRoute: input.cacheRoute, volatileTailMessages: 1, timeoutMs: input.timeoutMs,
          maxAttempts: input.maxAttempts, reasoningEffort: input.reasoningEffort,
        },
        recordUsage: recordUsageFor(input.purpose),
        inspectBody: (body, round) => inspectPrefix(body, input.purpose, input.cacheRoute, round === 1 && (input.expectRebuild ?? false)),
        maxRounds: input.maxRounds, shouldYield: input.shouldYield,
        onAssistantTurn: input.onAssistantTurn, onToolResults: input.onToolResults,
      });
    },
    async generateText(input): Promise<string> {
      const { systemPrompt, contents } = splitSystemPrompt(input.messages, input.systemPrompt ?? profile.systemPrompt);
      const body = buildCodexRequestBody(profile.model, systemPrompt, contents, { jsonSchema: input.jsonSchema, cacheRoute: input.cacheRoute, volatileTailMessages: 1 });
      inspectPrefix(body, input.purpose, input.cacheRoute, input.expectRebuild ?? false);
      return extractCodexText(await requestCodexResponse(body, recordUsageFor(input.purpose)));
    },
  };
}
