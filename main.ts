import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, type RawData } from "ws";
import YAML from "yaml";
import {
  createLlmClient,
  consumeLatestCallTokenUsage,
  getLatestClaudeUsage,
  probeClaudeUsage,
  listLlmProfiles,
  setActiveLlmProfile,
  type ClaudeUsage,
  type LlmClient,
  type LlmMessage,
} from "./llm-client.js";
import {
  createIncomingMessageStore,
  type IncomingMessageRecord,
  type IncomingMessageStore,
  type StoredMemoryRecord,
} from "./qdrant-store.js";
import { HollyStateStore } from "./holly-state.js";
import {
  runProactiveTick,
  buildProactiveRevivePrompt,
  type ProactiveConfig,
  type ProactiveDecision,
  type ProactiveDeps,
} from "./proactive-engine.js";
import { searchWeb, type SearchResult } from "./web-search.js";
import { MODEL_DECISION_JSON_SCHEMA, buildModelSystemPrompt } from "./decision-prompt.js";

type MonitorEntryKind = "incoming" | "outgoing" | "status" | "error" | "assistant";

type MonitorConnectionState = "connecting" | "open" | "closed" | "error";

type MonitorEntry = {
  id: number;
  kind: MonitorEntryKind;
  title: string;
  body: string;
  timestamp: string;
  label?: string;
};

type MonitorStatus = {
  state: MonitorConnectionState;
  detail: string;
  updatedAt: string;
};

type MonitorConversationPreview = {
  groupId: string | null;
  updatedAt: string;
  messages: LlmMessage[];
  estimatedTokens: number;
  compressed: boolean;
  contextLimitTokens: number;
  compressThresholdTokens: number;
};

type ParsedIncomingMessage = Omit<IncomingMessageRecord, "sequence"> & {
  messageTimestampMs: number | null;
  messageLagMs: number | null;
};

type ModelRequestContext = {
  groupId: string | null;
  userId: string | null;
  senderName: string | null;
  rawMessage: string | null;
  receivedAt: string;
  messageLagMs: number | null;
};

type PendingModelMessage = {
  message: string;
  context: ModelRequestContext;
};

class RetryableModelBatchError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "RetryableModelBatchError";
    this.cause = cause;
  }
}

type ModelDecision = {
  shouldReply: boolean;
  finalAnswer: string;
  thinkingProcess: string;
  raw: string;
};

type ThreadScoreBreakdown = {
  total: number;
  similarity: number;
  time: number;
  directed: number;
  participantLink: number;
  sameSender: number;
};

type ConversationTurn = {
  groupId: string | null;
  role: "user" | "assistant";
  senderName: string | null;
  userId: string | null;
  content: string;
  timestamp: string;
};

type GroupHistoryMessage = Record<string, unknown>;

type MessageSegment = {
  type?: unknown;
  data?: unknown;
};

type OcrTextBlock = {
  text?: unknown;
};

type PendingWsAction = {
  action: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type RuntimeLlmConfig = {
  context_limit_tokens?: unknown;
  context_compress_threshold_tokens?: unknown;
};

type AppConfig = {
  llm?: RuntimeLlmConfig;
  fetch?: { proxy_url?: string };
};

type ContextBudgetConfig = {
  limitTokens: number;
  compressThresholdTokens: number;
};

type PreparedModelRequest = {
  systemPrompt: string;
  messages: LlmMessage[];
  estimatedTokens: number;
  usedCompression: boolean;
};

type MonitorSnapshot = {
  type: "snapshot";
  target: string;
  status: MonitorStatus;
  history: MonitorEntry[];
  conversationPreview: MonitorConversationPreview | null;
  claudeUsage: ClaudeUsage | null;
  tokenStats: DailyTokenStats;
};

type MonitorEvent =
  | {
      type: "entry";
      entry: MonitorEntry;
    }
  | {
      type: "status";
      status: MonitorStatus;
    }
  | {
      type: "conversation";
      conversationPreview: MonitorConversationPreview | null;
    }
  | {
      type: "turn";
      groupId: string;
      turn: ConversationTurn;
    }
  | {
      type: "usage";
      claudeUsage: ClaudeUsage | null;
    }
  | {
      type: "tokens";
      tokenStats: DailyTokenStats;
    };

type ModelTokenStat = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type DailyTokenStats = {
  date: string;
  models: ModelTokenStat[];
  totalTokens: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = existsSync(join(process.cwd(), "package.json")) ? process.cwd() : __dirname;

const CONFIG_PATH = join(APP_ROOT, "config.yaml");
const LOG_DIR = join(APP_ROOT, "logs");
const VENDOR_DIR = join(APP_ROOT, "vendor");

// Serve the Vue runtime from disk so the monitor page never depends on an
// external CDN (the bot typically runs behind a proxy where unpkg is unreachable
// from the browser, which would leave the whole page blank).
const VUE_RUNTIME_SOURCE = (() => {
  try {
    return readFileSync(join(VENDOR_DIR, "vue.global.prod.js"), "utf-8");
  } catch {
    console.warn("Vendored Vue runtime missing at vendor/vue.global.prod.js; monitor page will not render.");
    return "";
  }
})();
const HTTP_PORT = 5000;
const HTTP_HOST = "127.0.0.1";
const WS_HOST = "127.0.0.1";
const WS_PORT = 8082;
const WS_TARGET_URL = `ws://${WS_HOST}:${WS_PORT}`;
const WS_RECONNECT_DELAY_MS = 8000;
const WS_HISTORY_LIMIT = 120;
const APP_SESSION_ID = randomUUID();
const APP_SESSION_STARTED_AT = new Date().toISOString();
const WS_ACTION_TIMEOUT_MS = 10_000;
const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_FETCH_MAX_PER_MESSAGE = 2;
const URL_CONTENT_MAX_CHARS = 3000;
const MEMORY_LOOKBACK_LIMIT = 8;
const THREAD_CANDIDATE_LIMIT = 24;
const THREAD_TIME_WINDOW_MS = 15 * 60 * 1000;
const THREAD_HARD_CUTOFF_MS = 60 * 60 * 1000;
const THREAD_SCORE_THRESHOLD = 0.42;
const MESSAGE_REPLY_MAX_AGE_MS = 5 * 60 * 1000;
const UNREAD_MODEL_FLUSH_INTERVAL_MS = 60 * 1000;
// Re-send the merged global context with max_tokens=1 on this cadence to keep the
// 1h prompt cache warm. 20min < the 1h cache TTL, so the cache never goes cold.
const CONTEXT_WARM_INTERVAL_MS = 20 * 60 * 1000;
// Memory-safety ceiling on retained per-group turns. The context_limit_tokens
// budget (190K) binds well before this many short group turns, so in practice
// history is "keep everything that fits in the window", not capped by count.
const CONVERSATION_HISTORY_LIMIT = 50000;
// The monitor only needs a recent slice; shipping the whole global context over
// SSE on every request would bloat the payload and freeze the conversation panel.
const MONITOR_PREVIEW_MESSAGE_LIMIT = 50;
const GROUP_HISTORY_BOOTSTRAP_PAGE_SIZE = 50;
const GROUP_HISTORY_BOOTSTRAP_MAX_PAGES = 200;
const DEFAULT_CONTEXT_LIMIT_TOKENS = 128000;
const DEFAULT_CONTEXT_COMPRESS_THRESHOLD_TOKENS = 120000;
const MIN_CONTEXT_LIMIT_TOKENS = 128;
// Headroom left below the model's input window for estimation drift + output.
const CONTEXT_MODEL_WINDOW_MARGIN_TOKENS = 16_000;
const CONTEXT_RECENT_MESSAGES_TO_KEEP = 2;
const CONTEXT_MIN_SECTION_BUDGET = 48;
// MODEL_DECISION_PROMPT / MODEL_DECISION_JSON_SCHEMA / buildModelSystemPrompt now
// live in decision-prompt.ts (imported above) so smokes/tests can exercise the
// exact production prompt without importing this self-starting entrypoint.

// Proactive Holly (slice 1): how often the engine wakes to consider reviving a
// dropped interest thread. Shares the 60s cadence with the reactive flush.
const PROACTIVE_TICK_INTERVAL_MS = 60 * 1000;

type SearchRuntimeConfig = {
  enabled: boolean;
  topK: number;
  timeoutMs: number;
};

const DEFAULT_SEARCH_CONFIG: SearchRuntimeConfig = {
  enabled: true,
  topK: 5,
  timeoutMs: 10_000,
};

const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  enabled: true,
  mode: "shadow",
  liveGroupAllowlist: [],
  lullMinMs: 10 * 60 * 1000,
  lullDeadzoneMs: 3 * 60 * 60 * 1000,
  interestWindowMs: 45 * 60 * 1000,
  perGroupDailyCap: 6,
  globalDailyCap: 20,
  cooldownMs: 30 * 60 * 1000,
  observationWindowMs: 15 * 60 * 1000,
  successWindowMs: 10 * 60 * 1000,
  backoffMultiplier: 1.5,
  engagedTtlMs: 60 * 60 * 1000,
  maxReplyChars: 80,
  interestKeywords: [
    "数学", "微积分", "代数", "几何", "概率", "统计", "素数", "方程", "math",
    "AI", "人工智能", "机器学习", "深度学习", "神经网络", "大模型", "算法", "llm", "gpt", "transformer",
    "天文", "星空", "星系", "宇宙", "行星", "恒星", "黑洞", "望远镜", "nasa", "卫星", "月球", "火星",
  ],
  echoOnlyGroups: ["20000003"],
};

let sessionLogPath: string | null = null;
let monitorEntryId = 0;
let wsClient: WebSocket | null = null;
let wsReconnectTimer: NodeJS.Timeout | null = null;
let monitorHistory: MonitorEntry[] = [];
let activeLlmClient: LlmClient | null = null;
let activeLlmLabel = "Assistant";
let incomingMessageStore: IncomingMessageStore | null = null;
let incomingMessageStoreQueue: Promise<void> = Promise.resolve();
let incomingMessageSequence = 0;
let llmProfileSwitchQueue: Promise<void> = Promise.resolve();
let modelQueue: Promise<void> = Promise.resolve();
let unreadModelMessagesByGroup = new Map<string, PendingModelMessage[]>();
let hollyStateStore: HollyStateStore | null = null;
let proactiveConfig: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG;
let proactiveShadowQueue: Promise<void> = Promise.resolve();
let searchConfig: SearchRuntimeConfig = DEFAULT_SEARCH_CONFIG;
let conversationHistoryByGroup = new Map<string, ConversationTurn[]>();
// Set whenever the merged global context grows; the warmer only fires when true
// so quiet periods don't burn rate-limit budget re-warming an unchanged context.
let globalContextDirty = true;
let conversationHistoryBootstrapByGroup = new Map<string, Promise<void>>();
let conversationHistoryBootstrapDayByGroup = new Map<string, string>();
let latestConversationPreview: MonitorConversationPreview | null = null;
let pendingWsActions = new Map<string, PendingWsAction>();
let configWatcher: FSWatcher | null = null;
let configReloadTimer: NodeJS.Timeout | null = null;
let contextBudgetConfig: ContextBudgetConfig = {
  limitTokens: DEFAULT_CONTEXT_LIMIT_TOKENS,
  compressThresholdTokens: DEFAULT_CONTEXT_COMPRESS_THRESHOLD_TOKENS,
};
let monitorStatus: MonitorStatus = {
  state: "closed",
  detail: `Waiting to connect to ${WS_TARGET_URL}`,
  updatedAt: new Date().toISOString(),
};

const monitorStreams = new Set<ServerResponse>();

function getActiveLlmClient(): LlmClient {
  if (!activeLlmClient) {
    throw new Error("LLM client is not initialized.");
  }

  return activeLlmClient;
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const normalized = Math.floor(numeric);
  return normalized > 0 ? normalized : null;
}

async function loadContextBudgetConfig(configPath: string): Promise<ContextBudgetConfig> {
  if (!existsSync(configPath)) {
    return {
      limitTokens: DEFAULT_CONTEXT_LIMIT_TOKENS,
      compressThresholdTokens: DEFAULT_CONTEXT_COMPRESS_THRESHOLD_TOKENS,
    };
  }

  const raw = await readFile(configPath, "utf-8");
  const config = (YAML.parse(raw) as AppConfig | null) ?? {};
  const llm = config.llm ?? {};
  const limitTokens = Math.max(
    MIN_CONTEXT_LIMIT_TOKENS,
    normalizePositiveInteger(llm.context_limit_tokens) ?? DEFAULT_CONTEXT_LIMIT_TOKENS,
  );
  const compressThresholdTokens = Math.max(
    1,
    Math.min(
      limitTokens,
      normalizePositiveInteger(llm.context_compress_threshold_tokens) ?? DEFAULT_CONTEXT_COMPRESS_THRESHOLD_TOKENS,
    ),
  );

  return {
    limitTokens,
    compressThresholdTokens,
  };
}

function readProactiveMinutesMs(value: unknown, defaultMs: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric * 60 * 1000) : defaultMs;
}

function readProactiveCount(value: unknown, defaultValue: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : defaultValue;
}

function readProactiveStringArray(value: unknown, defaultValue: string[]): string[] {
  if (!Array.isArray(value)) return defaultValue;
  return value
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
    .filter(Boolean);
}

// Read the optional `proactive:` config section; any missing/invalid field falls
// back to DEFAULT_PROACTIVE_CONFIG. Durations are authored in minutes for
// readability and converted to ms here. Hot-reloaded by the config watcher (P4).
async function loadProactiveConfig(configPath: string): Promise<ProactiveConfig> {
  const base: ProactiveConfig = {
    ...DEFAULT_PROACTIVE_CONFIG,
    liveGroupAllowlist: [...DEFAULT_PROACTIVE_CONFIG.liveGroupAllowlist],
    interestKeywords: [...DEFAULT_PROACTIVE_CONFIG.interestKeywords],
    echoOnlyGroups: [...DEFAULT_PROACTIVE_CONFIG.echoOnlyGroups],
  };
  if (!existsSync(configPath)) return base;

  let parsed: { proactive?: Record<string, unknown> } | null = null;
  try {
    parsed = (YAML.parse(await readFile(configPath, "utf-8")) as { proactive?: Record<string, unknown> } | null) ?? {};
  } catch {
    return base;
  }
  const p = parsed?.proactive;
  if (!p || typeof p !== "object") return base;

  const multiplier = typeof p.backoff_multiplier === "number" ? p.backoff_multiplier : Number(p.backoff_multiplier);
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    mode: p.mode === "live" ? "live" : "shadow",
    liveGroupAllowlist: readProactiveStringArray(p.live_group_allowlist, base.liveGroupAllowlist),
    lullMinMs: readProactiveMinutesMs(p.lull_min_minutes, base.lullMinMs),
    lullDeadzoneMs: readProactiveMinutesMs(p.lull_deadzone_minutes, base.lullDeadzoneMs),
    interestWindowMs: readProactiveMinutesMs(p.interest_window_minutes, base.interestWindowMs),
    perGroupDailyCap: readProactiveCount(p.per_group_daily_cap, base.perGroupDailyCap),
    globalDailyCap: readProactiveCount(p.global_daily_cap, base.globalDailyCap),
    cooldownMs: readProactiveMinutesMs(p.cooldown_minutes, base.cooldownMs),
    observationWindowMs: readProactiveMinutesMs(p.observation_window_minutes, base.observationWindowMs),
    successWindowMs: readProactiveMinutesMs(p.success_window_minutes, base.successWindowMs),
    backoffMultiplier: Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : base.backoffMultiplier,
    engagedTtlMs: readProactiveMinutesMs(p.engaged_ttl_minutes, base.engagedTtlMs),
    maxReplyChars: readProactiveCount(p.max_reply_chars, base.maxReplyChars),
    interestKeywords: readProactiveStringArray(p.interest_keywords, base.interestKeywords),
    echoOnlyGroups: readProactiveStringArray(p.echo_only_groups, base.echoOnlyGroups),
  };
}

// Read the optional `search:` config section. The API key is NOT here — it comes
// from the SERPER_API_KEY env var (see .env). Hot-reloaded by the config watcher.
async function loadSearchConfig(configPath: string): Promise<SearchRuntimeConfig> {
  const base = { ...DEFAULT_SEARCH_CONFIG };
  if (!existsSync(configPath)) return base;
  let parsed: { search?: Record<string, unknown> } | null = null;
  try {
    parsed = (YAML.parse(await readFile(configPath, "utf-8")) as { search?: Record<string, unknown> } | null) ?? {};
  } catch {
    return base;
  }
  const s = parsed?.search;
  if (!s || typeof s !== "object") return base;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : base.enabled,
    topK: readProactiveCount(s.top_k, base.topK),
    timeoutMs: readProactiveCount(s.timeout_ms, base.timeoutMs),
  };
}

async function applyProxyConfig(configPath: string): Promise<void> {
  if (!existsSync(configPath)) return;
  const raw = await readFile(configPath, "utf-8");
  const config = (YAML.parse(raw) as AppConfig | null) ?? {};
  const proxyUrl = config.fetch?.proxy_url?.trim();
  if (proxyUrl) {
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.http_proxy = proxyUrl;
    // The proxy is for outbound web fetches (Anthropic API, URL previews). Keep
    // loopback services — Qdrant :6333, the NapCat WS, the local monitor — OFF
    // the proxy: routing 127.0.0.1 through Clash/Mihomo can reset the connection
    // ("other side closed"). Merge with any NO_PROXY the user already set.
    const localNoProxy = ["127.0.0.1", "localhost", "::1"];
    const existingNoProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const mergedNoProxy = Array.from(new Set([...existingNoProxy, ...localNoProxy])).join(",");
    process.env.NO_PROXY = mergedNoProxy;
    process.env.no_proxy = mergedNoProxy;
  }
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  let total = 0;
  let asciiRun = 0;

  const flushAsciiRun = (): void => {
    if (asciiRun <= 0) {
      return;
    }

    total += Math.max(1, Math.ceil(asciiRun / 4));
    asciiRun = 0;
  };

  for (const char of normalized) {
    if (/\s/u.test(char)) {
      flushAsciiRun();
      continue;
    }

    if (/\p{Script=Han}/u.test(char)) {
      flushAsciiRun();
      total += 1;
      continue;
    }

    if (/[A-Za-z0-9]/.test(char)) {
      asciiRun += 1;
      continue;
    }

    flushAsciiRun();
    total += 1;
  }

  flushAsciiRun();
  return Math.max(1, total);
}

function estimateSystemPromptTokens(systemPrompt: string): number {
  const normalized = systemPrompt.trim();
  return normalized ? estimateTextTokens(normalized) + 12 : 0;
}

function estimateMessageTokens(message: LlmMessage): number {
  return estimateTextTokens(message.content) + 6;
}

function estimateMessagesTokens(messages: readonly LlmMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateRequestTokens(systemPrompt: string, messages: readonly LlmMessage[]): number {
  return estimateSystemPromptTokens(systemPrompt) + estimateMessagesTokens(messages);
}

function normalizeMessageContent(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactTextToTokenBudget(text: string, maxTokens: number): string {
  const normalized = normalizeMessageContent(text);
  if (!normalized || maxTokens <= 0) {
    return "";
  }

  if (estimateTextTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const chars = Array.from(normalized);
  let headChars = Math.min(chars.length, Math.max(12, Math.floor(maxTokens * 1.8)));
  let tailChars = maxTokens >= 40 ? Math.min(chars.length - headChars, Math.floor(maxTokens * 0.6)) : 0;
  let candidate = `${chars.slice(0, headChars).join("")}${tailChars > 0 ? ` ... ${chars.slice(-tailChars).join("")}` : "..."}`.trim();

  while (estimateTextTokens(candidate) > maxTokens && (headChars > 8 || tailChars > 0)) {
    if (tailChars > 0 && headChars >= tailChars) {
      tailChars = Math.max(0, tailChars - 4);
    } else {
      headChars = Math.max(8, headChars - 6);
    }

    candidate = `${chars.slice(0, headChars).join("")}${tailChars > 0 ? ` ... ${chars.slice(-tailChars).join("")}` : "..."}`.trim();
  }

  while (estimateTextTokens(candidate) > maxTokens && headChars > 4) {
    headChars = Math.max(4, headChars - 2);
    candidate = `${chars.slice(0, headChars).join("")}...`.trim();
  }

  return candidate;
}

function sanitizeConversationMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages
    .map((message): LlmMessage => ({
      role: message.role,
      content: normalizeMessageContent(message.content),
    }))
    .filter((message) => Boolean(message.content));
}

function buildCompressedConversationSummary(messages: readonly LlmMessage[], budgetTokens: number): string {
  if (messages.length === 0 || budgetTokens <= 0) {
    return "";
  }

  const header = "Compressed earlier conversation:";
  let result = header;
  const perLineBudget = Math.max(
    10,
    Math.min(72, Math.floor(Math.max(1, budgetTokens - estimateTextTokens(header)) / messages.length)),
  );

  for (const message of messages) {
    const roleLabel = message.role === "assistant" ? "Holly" : message.role === "system" ? "system" : "user";
    const line = `- ${roleLabel}: ${compactTextToTokenBudget(message.content, perLineBudget)}`;
    const next = `${result}\n${line}`;
    if (estimateTextTokens(next) > budgetTokens) {
      break;
    }

    result = next;
  }

  return result === header ? compactTextToTokenBudget(header, budgetTokens) : result;
}

function compressConversationMessages(messages: readonly LlmMessage[], budgetTokens: number): LlmMessage[] {
  const cleaned = sanitizeConversationMessages(messages);
  if (cleaned.length === 0 || budgetTokens <= 0) {
    return [];
  }

  if (estimateMessagesTokens(cleaned) <= budgetTokens) {
    return cleaned;
  }

  for (let keepTail = Math.min(CONTEXT_RECENT_MESSAGES_TO_KEEP, cleaned.length); keepTail >= 0; keepTail -= 1) {
    const tail = keepTail > 0 ? cleaned.slice(-keepTail) : [];
    const tailTokens = estimateMessagesTokens(tail);
    if (tailTokens > budgetTokens) {
      continue;
    }

    const older = cleaned.slice(0, cleaned.length - keepTail);
    const summaryBudget = Math.max(0, budgetTokens - tailTokens);
    const summary = buildCompressedConversationSummary(older, summaryBudget);
    const next: LlmMessage[] = summary ? [{ role: "system", content: summary }, ...tail] : tail;
    if (estimateMessagesTokens(next) <= budgetTokens) {
      return next;
    }
  }

  const lastMessage = cleaned[cleaned.length - 1];
  const contentBudget = Math.max(8, budgetTokens - 6);
  return contentBudget > 0
    ? [{
        role: lastMessage.role,
        content: compactTextToTokenBudget(lastMessage.content, contentBudget),
      }]
    : [];
}

function compressMemoryPrompt(memoryPrompt: string, budgetTokens: number): string {
  const normalized = memoryPrompt.trim();
  if (!normalized || budgetTokens <= 0) {
    return "";
  }

  if (estimateTextTokens(normalized) <= budgetTokens) {
    return normalized;
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith("["));

  if (lines.length === 0) {
    return compactTextToTokenBudget(normalized, budgetTokens);
  }

  const header = "Compressed thread memory:";
  let result = header;
  const perLineBudget = Math.max(
    10,
    Math.min(56, Math.floor(Math.max(1, budgetTokens - estimateTextTokens(header)) / lines.length)),
  );

  for (const line of lines) {
    const compactLine = `- ${compactTextToTokenBudget(line.replace(/\s+\[thread_score=.*$/, ""), perLineBudget)}`;
    const next = `${result}\n${compactLine}`;
    if (estimateTextTokens(next) > budgetTokens) {
      break;
    }

    result = next;
  }

  return result === header ? compactTextToTokenBudget(header, budgetTokens) : result;
}

function allocateVariableContextBudgets(
  memoryTokens: number,
  conversationTokens: number,
  totalBudget: number,
): { memoryBudget: number; conversationBudget: number } {
  if (totalBudget <= 0) {
    return { memoryBudget: 0, conversationBudget: 0 };
  }

  if (memoryTokens <= 0) {
    return { memoryBudget: 0, conversationBudget: totalBudget };
  }

  if (conversationTokens <= 0) {
    return { memoryBudget: totalBudget, conversationBudget: 0 };
  }

  const totalTokens = memoryTokens + conversationTokens;
  let memoryBudget = Math.round(totalBudget * (memoryTokens / totalTokens));
  let conversationBudget = totalBudget - memoryBudget;
  const minimumSectionBudget = Math.min(CONTEXT_MIN_SECTION_BUDGET, Math.floor(totalBudget / 4));

  if (memoryBudget < minimumSectionBudget) {
    const delta = minimumSectionBudget - memoryBudget;
    memoryBudget += delta;
    conversationBudget = Math.max(0, conversationBudget - delta);
  }

  if (conversationBudget < minimumSectionBudget) {
    const delta = minimumSectionBudget - conversationBudget;
    conversationBudget += delta;
    memoryBudget = Math.max(0, memoryBudget - delta);
  }

  return { memoryBudget, conversationBudget };
}

function fitVariableContextToBudget(
  memoryPrompt: string,
  conversationMessages: readonly LlmMessage[],
  totalBudget: number,
): { memoryPrompt: string; conversationMessages: LlmMessage[] } {
  const cleanedMemoryPrompt = memoryPrompt.trim();
  const cleanedConversationMessages = sanitizeConversationMessages(conversationMessages);
  if (totalBudget <= 0) {
    return { memoryPrompt: "", conversationMessages: [] };
  }

  const memoryTokens = estimateTextTokens(cleanedMemoryPrompt);
  const conversationTokens = estimateMessagesTokens(cleanedConversationMessages);
  if (memoryTokens + conversationTokens <= totalBudget) {
    return {
      memoryPrompt: cleanedMemoryPrompt,
      conversationMessages: cleanedConversationMessages,
    };
  }

  const { memoryBudget, conversationBudget } = allocateVariableContextBudgets(
    memoryTokens,
    conversationTokens,
    totalBudget,
  );

  let compactMemoryPrompt = compressMemoryPrompt(cleanedMemoryPrompt, memoryBudget);
  let compactConversationMessages = compressConversationMessages(cleanedConversationMessages, conversationBudget);

  let total = estimateTextTokens(compactMemoryPrompt) + estimateMessagesTokens(compactConversationMessages);
  if (total <= totalBudget) {
    return {
      memoryPrompt: compactMemoryPrompt,
      conversationMessages: compactConversationMessages,
    };
  }

  const memoryOnlyBudget = Math.max(0, totalBudget - estimateMessagesTokens(compactConversationMessages));
  compactMemoryPrompt = compressMemoryPrompt(cleanedMemoryPrompt, memoryOnlyBudget);
  total = estimateTextTokens(compactMemoryPrompt) + estimateMessagesTokens(compactConversationMessages);
  if (total <= totalBudget) {
    return {
      memoryPrompt: compactMemoryPrompt,
      conversationMessages: compactConversationMessages,
    };
  }

  const conversationOnlyBudget = Math.max(0, totalBudget - estimateTextTokens(compactMemoryPrompt));
  compactConversationMessages = compressConversationMessages(cleanedConversationMessages, conversationOnlyBudget);

  return {
    memoryPrompt: compactMemoryPrompt,
    conversationMessages: compactConversationMessages,
  };
}

function modelContextWindowTokens(model: string): number {
  // Haiku 4.5 has a 200K window; Opus 4.x and Sonnet 4.6 are 1M.
  return /haiku/i.test(model) ? 200_000 : 1_000_000;
}

function prepareModelRequest(
  baseSystemPrompt: string,
  memoryPrompt: string,
  conversationMessages: readonly LlmMessage[],
  currentMessage: string,
): PreparedModelRequest {
  const fixedSystemPrompt = buildModelSystemPrompt(baseSystemPrompt).trim();
  const currentUserMessage: LlmMessage = {
    role: "user",
    content: normalizeMessageContent(currentMessage),
  };

  // Clamp the configured budget to the active model's input window so an 800K
  // global context can't overflow a smaller window (e.g. Haiku's 200K).
  const modelWindowTokens = modelContextWindowTokens(activeLlmClient?.model ?? "");
  const limitTokens = Math.min(
    contextBudgetConfig.limitTokens,
    Math.max(MIN_CONTEXT_LIMIT_TOKENS, modelWindowTokens - CONTEXT_MODEL_WINDOW_MARGIN_TOKENS),
  );
  const compressThresholdTokens = Math.min(contextBudgetConfig.compressThresholdTokens, limitTokens);

  let usedCompression = false;
  let fittedVariableContext = {
    memoryPrompt: memoryPrompt.trim(),
    conversationMessages: sanitizeConversationMessages(conversationMessages),
  };

  let systemPrompt = [fixedSystemPrompt, fittedVariableContext.memoryPrompt].filter(Boolean).join("\n\n");
  let messages = [...fittedVariableContext.conversationMessages, currentUserMessage];
  let estimatedTokens = estimateRequestTokens(systemPrompt, messages);

  const fixedBudget = estimateSystemPromptTokens(fixedSystemPrompt) + estimateMessageTokens(currentUserMessage);

  if (estimatedTokens > compressThresholdTokens) {
    const softVariableBudget = Math.max(0, compressThresholdTokens - fixedBudget);
    fittedVariableContext = fitVariableContextToBudget(
      memoryPrompt,
      conversationMessages,
      softVariableBudget,
    );
    systemPrompt = [fixedSystemPrompt, fittedVariableContext.memoryPrompt].filter(Boolean).join("\n\n");
    messages = [...fittedVariableContext.conversationMessages, currentUserMessage];
    estimatedTokens = estimateRequestTokens(systemPrompt, messages);
    usedCompression = true;
  }

  if (estimatedTokens > limitTokens) {
    const hardVariableBudget = Math.max(0, limitTokens - fixedBudget);
    fittedVariableContext = fitVariableContextToBudget(
      memoryPrompt,
      conversationMessages,
      hardVariableBudget,
    );
    systemPrompt = [fixedSystemPrompt, fittedVariableContext.memoryPrompt].filter(Boolean).join("\n\n");
    messages = [...fittedVariableContext.conversationMessages, currentUserMessage];
    estimatedTokens = estimateRequestTokens(systemPrompt, messages);
    usedCompression = true;
  }

  if (estimatedTokens > limitTokens) {
    const systemAndHistoryBudget = estimateSystemPromptTokens(systemPrompt) + estimateMessagesTokens(fittedVariableContext.conversationMessages);
    const currentMessageBudget = Math.max(8, limitTokens - systemAndHistoryBudget - 6);
    const compactCurrentUserMessage: LlmMessage = {
      role: "user",
      content: compactTextToTokenBudget(currentUserMessage.content, currentMessageBudget),
    };
    messages = [...fittedVariableContext.conversationMessages, compactCurrentUserMessage];
    estimatedTokens = estimateRequestTokens(systemPrompt, messages);
    usedCompression = true;
  }

  if (estimatedTokens > limitTokens) {
    systemPrompt = fixedSystemPrompt;
    messages = [{
      role: "user",
      content: compactTextToTokenBudget(
        currentUserMessage.content,
        Math.max(8, limitTokens - estimateSystemPromptTokens(systemPrompt) - 6),
      ),
    }];
    estimatedTokens = estimateRequestTokens(systemPrompt, messages);
    usedCompression = true;
  }

  return {
    systemPrompt,
    messages,
    estimatedTokens,
    usedCompression,
  };
}

async function switchActiveProfile(profileName: string): Promise<LlmClient> {
  const target = profileName.trim();
  if (!target) {
    throw new Error("profile is required.");
  }

  let nextClient: LlmClient | null = null;
  const run = llmProfileSwitchQueue.catch(() => {
    // Keep the switch queue alive after a previous failure.
  }).then(async () => {
    await setActiveLlmProfile(CONFIG_PATH, target);
    nextClient = await createLlmClient(CONFIG_PATH, target);
    activeLlmClient = nextClient;
    activeLlmLabel = nextClient.displayName;
  });

  llmProfileSwitchQueue = run.catch(() => {
    // Keep the switch queue alive after a previous failure.
  });

  await run;
  if (!nextClient) {
    throw new Error(`Failed to switch to llm profile '${target}'.`);
  }

  return nextClient;
}

async function reloadActiveProfileFromConfig(reason: string): Promise<void> {
  const envProfile = process.env.LLM_PROFILE?.trim();
  const currentProfile = activeLlmClient?.profileName ?? (envProfile || undefined);
  const nextClient = await createLlmClient(CONFIG_PATH, currentProfile);
  const nextContextBudgetConfig = await loadContextBudgetConfig(CONFIG_PATH);
  const nextProactiveConfig = await loadProactiveConfig(CONFIG_PATH);
  const nextSearchConfig = await loadSearchConfig(CONFIG_PATH);
  activeLlmClient = nextClient;
  activeLlmLabel = nextClient.displayName;
  contextBudgetConfig = nextContextBudgetConfig;
  proactiveConfig = nextProactiveConfig;
  searchConfig = nextSearchConfig;
  hollyStateStore?.setEngagedTtl(nextProactiveConfig.engagedTtlMs);
  pushMonitorEntry(
    "status",
    "Config Reloaded",
    `${reason}\nActive profile: ${nextClient.profileName}\nModel: ${nextClient.model}\nContext budget: ${contextBudgetConfig.limitTokens} tokens (compress at ${contextBudgetConfig.compressThresholdTokens})`,
  );
}

function scheduleConfigReload(reason: string): void {
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
  }

  configReloadTimer = setTimeout(() => {
    configReloadTimer = null;
    void reloadActiveProfileFromConfig(reason).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Config Reload Error", detail);
      console.error("Failed to reload config:", error);
    });
  }, 300);
}

function startConfigWatcher(): void {
  if (configWatcher) {
    return;
  }

  configWatcher = watch(CONFIG_PATH, (eventType) => {
    if (eventType === "change" || eventType === "rename") {
      scheduleConfigReload(`Detected ${eventType} on config.yaml`);
    }
  });

  configWatcher.on("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    pushMonitorEntry("error", "Config Watch Error", detail);
    console.error("Config watcher error:", error);
  });
}

function nowTimestamp(): string {
  return new Date().toISOString().slice(0, 19);
}

async function getSessionLogPath(): Promise<string> {
  if (sessionLogPath) {
    return sessionLogPath;
  }

  await mkdir(LOG_DIR, { recursive: true });
  const startedAt = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  sessionLogPath = join(LOG_DIR, `chat-session-${startedAt}.log`);

  await appendFile(
    sessionLogPath,
    `Session started: ${nowTimestamp()}\nProcess ID: ${process.pid}\n${"=".repeat(60)}\n\n`,
    "utf-8",
  );

  return sessionLogPath;
}

async function appendChatLog(role: "user" | "assistant", text: string): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) {
    return;
  }

  const logPath = await getSessionLogPath();
  const speaker = role === "user" ? "User" : activeLlmLabel;
  await appendFile(logPath, `[${nowTimestamp()}] ${speaker}\n${cleanText}\n\n`, "utf-8");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

const TOKEN_STATS_PATH = join(LOG_DIR, "token-usage.json");

type ModelTokenCounts = { inputTokens: number; outputTokens: number };

let tokenStatsByDate = new Map<string, Map<string, ModelTokenCounts>>();
let tokenStatsSaveQueue: Promise<void> = Promise.resolve();

function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function loadTokenStats(): Promise<void> {
  try {
    const raw = await readFile(TOKEN_STATS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, ModelTokenCounts>>;
    const next = new Map<string, Map<string, ModelTokenCounts>>();
    for (const [date, models] of Object.entries(parsed)) {
      const modelMap = new Map<string, ModelTokenCounts>();
      for (const [model, counts] of Object.entries(models)) {
        modelMap.set(model, {
          inputTokens: Number(counts?.inputTokens) || 0,
          outputTokens: Number(counts?.outputTokens) || 0,
        });
      }
      next.set(date, modelMap);
    }
    tokenStatsByDate = next;
  } catch {
    // No stats file yet; start with an empty map.
  }
}

function persistTokenStats(): void {
  tokenStatsSaveQueue = tokenStatsSaveQueue
    .then(async () => {
      const plain: Record<string, Record<string, ModelTokenCounts>> = {};
      for (const [date, models] of tokenStatsByDate) {
        plain[date] = {};
        for (const [model, counts] of models) {
          plain[date][model] = counts;
        }
      }
      await mkdir(LOG_DIR, { recursive: true });
      await writeFile(TOKEN_STATS_PATH, JSON.stringify(plain, null, 2), "utf-8");
    })
    .catch((error) => {
      console.error("Failed to persist token stats:", error);
    });
}

function recordTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
  if (!model || (inputTokens <= 0 && outputTokens <= 0)) {
    return;
  }
  const date = localDateKey();
  let models = tokenStatsByDate.get(date);
  if (!models) {
    models = new Map<string, ModelTokenCounts>();
    tokenStatsByDate.set(date, models);
  }
  let counts = models.get(model);
  if (!counts) {
    counts = { inputTokens: 0, outputTokens: 0 };
    models.set(model, counts);
  }
  counts.inputTokens += inputTokens;
  counts.outputTokens += outputTokens;
  persistTokenStats();
}

function buildDailyTokenStats(
  date: string,
  models: Map<string, ModelTokenCounts> | undefined,
): DailyTokenStats {
  const list: ModelTokenStat[] = [];
  let totalTokens = 0;
  if (models) {
    for (const [model, counts] of models) {
      const total = counts.inputTokens + counts.outputTokens;
      totalTokens += total;
      list.push({
        model,
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        totalTokens: total,
      });
    }
  }
  list.sort((a, b) => b.totalTokens - a.totalTokens);
  return { date, models: list, totalTokens };
}

function getTodayTokenStats(): DailyTokenStats {
  const date = localDateKey();
  return buildDailyTokenStats(date, tokenStatsByDate.get(date));
}

// Per-day history (most recent first) for the usage dashboard, plus the
// combined token total across the returned days.
function getTokenStatsHistory(limit = 60): { days: DailyTokenStats[]; grandTotal: number } {
  const dates = Array.from(tokenStatsByDate.keys()).sort().reverse();
  const limited = limit > 0 ? dates.slice(0, limit) : dates;
  const days = limited.map((date) => buildDailyTokenStats(date, tokenStatsByDate.get(date)));
  const grandTotal = days.reduce((sum, day) => sum + day.totalTokens, 0);
  return { days, grandTotal };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url || "/", `http://${HTTP_HOST}:${HTTP_PORT}`);
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function describeSocketMessage(data: RawData, isBinary: boolean): string {
  const buffer = toBuffer(data);
  if (isBinary) {
    return `binary message (${buffer.byteLength} bytes)`;
  }

  return buffer.toString("utf-8");
}

function asDisplayText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return fallback;
}

function extractIncomingDisplayMessage(data: RawData, isBinary: boolean): string | null {
  const content = describeSocketMessage(data, isBinary);
  if (isBinary) {
    return content;
  }

  try {
    const payload = JSON.parse(content) as Record<string, unknown>;
    if (payload.message_type !== "group") {
      return null;
    }

    const sender =
      typeof payload.sender === "object" && payload.sender !== null
        ? (payload.sender as Record<string, unknown>)
        : {};
    const groupName = asDisplayText(payload.group_name, "\u672a\u77e5\u7fa4");
    const groupId = asDisplayText(payload.group_id, "\u672a\u77e5\u7fa4\u53f7");
    const senderName = asDisplayText(sender.nickname, "\u672a\u77e5\u7528\u6237");
    const userId = asDisplayText(payload.user_id ?? sender.user_id, "\u672a\u77e5\u7528\u6237ID");
    const rawMessage = payload.raw_message;
    const prefix = `\u7fa4\u804a [${groupName}(${groupId})] [${senderName}(${userId})]`;

    if (typeof rawMessage === "string") {
      return `${prefix} ${rawMessage}`.trim();
    }

    if (rawMessage === null || rawMessage === undefined) {
      return prefix;
    }

    return `${prefix} ${JSON.stringify(rawMessage)}`.trim();
  } catch (error) {
    void error;
    return content;
  }
}

function asOptionalText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
}

function stringifyMessageContent(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function readMessageTimestampMs(record: Record<string, unknown>): number | null {
  const candidates = [
    record.msgTime,
    record.time,
    record.message_time,
    record.timestamp,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate > 10_000_000_000 ? candidate : candidate * 1000;
    }

    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }

      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function formatDisplayMessageTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("zh-CN", {
    hour12: false,
  });
}

function formatMessageAgeSeconds(lagMs: number | null): string {
  if (lagMs === null) {
    return "unknown";
  }

  return String(Math.floor(lagMs / 1000));
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseMessageSegments(value: unknown): MessageSegment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((segment) => asObjectRecord(segment))
    .filter((segment): segment is Record<string, unknown> => Boolean(segment))
    .map((segment) => ({
      type: segment.type,
      data: segment.data,
    }));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&comma;/g, ",");
}

function normalizeNapCatImageSource(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = decodeHtmlEntities(value).trim();
  if (!normalized) {
    return null;
  }

  if (
    /^https?:\/\//i.test(normalized) ||
    /^file:\/\//i.test(normalized) ||
    /^base64:\/\//i.test(normalized) ||
    /^data:/i.test(normalized) ||
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    /^\\\\/.test(normalized) ||
    normalized.startsWith("/")
  ) {
    return normalized;
  }

  return null;
}

function extractImageSourcesFromRawMessage(rawMessage: string | null): string[] {
  if (!rawMessage) {
    return [];
  }

  const normalizedRawMessage = decodeHtmlEntities(rawMessage);
  const imageSources: string[] = [];
  const imageCqMatches = normalizedRawMessage.match(/\[CQ:image,[^\]]+\]/g) ?? [];

  for (const imageCq of imageCqMatches) {
    const urlMatch = imageCq.match(/(?:^|,)url=([^,\]]+)/i);
    const fileMatch = imageCq.match(/(?:^|,)file=([^,\]]+)/i);
    const candidates = [
      normalizeNapCatImageSource(urlMatch?.[1] ?? null),
      normalizeNapCatImageSource(fileMatch?.[1] ?? null),
    ];

    for (const candidate of candidates) {
      if (!candidate || imageSources.includes(candidate)) {
        continue;
      }

      imageSources.push(candidate);
    }
  }

  return imageSources;
}

function extractImageSourcesFromRawContent(rawContent: string): string[] {
  try {
    const payload = JSON.parse(rawContent) as Record<string, unknown>;
    const segments = parseMessageSegments(payload.message);
    const imageSources: string[] = [];

    for (const segment of segments) {
      if (segment.type !== "image") {
        continue;
      }

      const data = asObjectRecord(segment.data);
      if (!data) {
        continue;
      }

      const candidates = [
        normalizeNapCatImageSource(asOptionalText(data.url)),
        normalizeNapCatImageSource(asOptionalText(data.file)),
      ];
      for (const candidate of candidates) {
        if (!candidate || imageSources.includes(candidate)) {
          continue;
        }

        imageSources.push(candidate);
      }
    }

    for (const candidate of extractImageSourcesFromRawMessage(asOptionalText(payload.raw_message))) {
      if (!imageSources.includes(candidate)) {
        imageSources.push(candidate);
      }
    }

    return imageSources;
  } catch {
    return [];
  }
}

function formatOcrTextBlocks(data: unknown): string {
  if (!Array.isArray(data)) {
    return "";
  }

  const texts = data
    .map((item) => asObjectRecord(item) as OcrTextBlock | null)
    .map((item) => asOptionalText(item?.text))
    .filter((item): item is string => Boolean(item))
    .map((item) => item.trim())
    .filter(Boolean);

  return texts.join("\n").trim();
}

async function sendWsAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = wsClient;
  if (!client || client.readyState !== WebSocket.OPEN) {
    throw new Error("Upstream WebSocket is not connected.");
  }

  const echo = `${action}:${randomUUID()}`;
  const payload = { action, params, echo };
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWsActions.delete(echo);
      reject(new Error(`Timed out waiting for ${action} response.`));
    }, WS_ACTION_TIMEOUT_MS);

    pendingWsActions.set(echo, {
      action,
      resolve,
      reject,
      timer,
    });
  });

  client.send(JSON.stringify(payload));
  return result;
}

// When the upstream connection drops, any in-flight action responses can never
// arrive on it. Fail them immediately with a clear reason instead of letting
// each sit until WS_ACTION_TIMEOUT_MS fires a misleading "Timed out" error.
function rejectAllPendingWsActions(reason: string): void {
  if (pendingWsActions.size === 0) {
    return;
  }
  const pending = Array.from(pendingWsActions.values());
  pendingWsActions.clear();
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}

async function runNapCatOcr(image: string): Promise<string> {
  const actions = [".ocr_image", "ocr_image"];
  let lastError: Error | null = null;

  for (const action of actions) {
    try {
      const response = await sendWsAction(action, { image });
      const text = formatOcrTextBlocks(response.data);
      if (text) {
        return text;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }

  return "";
}

function extractUrlsFromText(text: string): string[] {
  const full = text.match(/https?:\/\/[^\s\]）\)》"'"']+/g) ?? [];
  // bare domains like pova.cc or www.example.com/path (not already preceded by ://)
  const bare = text.match(/(?<![/:@\w])(?:www\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,}){1,3}(?:\/[^\s\]）\)》"'"']*)?(?=[^\w]|$)/g) ?? [];
  const bareWithScheme = bare
    .filter((b) => !full.some((f) => f.includes(b)))
    .map((b) => `https://${b}`);
  return [...new Set([...full, ...bareWithScheme])]
    .filter((url) => !/\.(jpg|jpeg|png|gif|webp|mp4|mp3|pdf|svg)(\?|$)/i.test(url))
    .slice(0, URL_FETCH_MAX_PER_MESSAGE);
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchUrlContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, URL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://www.google.com/",
      },
    });
    if (!res.ok) {
      pushMonitorEntry("status", "URL Fetch Skip", `status=${res.status} url=${url}`);
      return "";
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      pushMonitorEntry("status", "URL Fetch Skip", `content-type=${contentType} url=${url}`);
      return "";
    }
    const html = await res.text();
    const text = extractTextFromHtml(html).slice(0, URL_CONTENT_MAX_CHARS);
    pushMonitorEntry("status", "URL Fetch OK", `chars=${text.length} url=${url}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function toHttpFallbackUrl(url: string): string | null {
  return /^https:\/\//i.test(url) ? url.replace(/^https:\/\//i, "http://") : null;
}

async function fetchUrlContentWithFallback(url: string): Promise<{ url: string; content: string }> {
  let originalError: unknown = null;
  try {
    const content = await fetchUrlContent(url);
    if (content) {
      return { url, content };
    }
  } catch (error) {
    originalError = error;
  }

  const fallbackUrl = toHttpFallbackUrl(url);
  if (!fallbackUrl) {
    if (originalError) {
      throw originalError;
    }
    return { url, content: "" };
  }

  pushMonitorEntry("status", "URL Fetch Fallback", `from=${url}\nto=${fallbackUrl}`);
  const fallbackContent = await fetchUrlContent(fallbackUrl);
  return { url: fallbackUrl, content: fallbackContent };
}

async function enrichMessageWithUrlContent(message: ParsedIncomingMessage): Promise<ParsedIncomingMessage> {
  if (message.isBinary || message.messageType !== "group" || !message.displayText) {
    return message;
  }

  const searchText = [message.rawMessage, message.displayText].filter(Boolean).join(" ");
  const urls = extractUrlsFromText(searchText);
  if (urls.length === 0) {
    return message;
  }

  pushMonitorEntry("status", "URL Fetch Start", `urls=${urls.join(", ")}`);

  const fetchedBlocks: string[] = [];
  for (const url of urls) {
    try {
      const fetched = await fetchUrlContentWithFallback(url);
      const content = fetched.content;
      if (content) {
        fetchedBlocks.push(`[网页内容 ${url}]\n${content}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "URL Fetch Error", `url=${url}\n${detail}`);
      console.error(`Failed to fetch URL ${url}:`, error);
    }
  }

  if (fetchedBlocks.length === 0) {
    return message;
  }

  return {
    ...message,
    displayText: `${message.displayText}\n[网页内容]\n${fetchedBlocks.join("\n---\n")}`.trim(),
  };
}

async function enrichMessageWithImageOcr(message: ParsedIncomingMessage): Promise<ParsedIncomingMessage> {
  if (message.isBinary || message.messageType !== "group" || !message.displayText) {
    return message;
  }

  const imageSources = extractImageSourcesFromRawContent(message.rawContent);
  if (imageSources.length === 0) {
    return message;
  }

  const recognizedBlocks: string[] = [];

  for (const imageSource of imageSources) {
    try {
      const text = await runNapCatOcr(imageSource);
      if (text) {
        recognizedBlocks.push(text);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Image OCR Error", `image=${imageSource}\n${detail}`);
      console.error(`Failed to OCR image ${imageSource}:`, error);
    }
  }

  if (recognizedBlocks.length === 0) {
    return message;
  }

  const ocrText = recognizedBlocks.join("\n---\n").trim();
  return {
    ...message,
    displayText: `${message.displayText}\n[图片OCR]\n${ocrText}`.trim(),
  };
}

function isHollyMessage(message: ParsedIncomingMessage): boolean {
  return (message.senderName ?? "").trim().toLowerCase() === "holly";
}

function parseIncomingMessage(data: RawData, isBinary: boolean): ParsedIncomingMessage {
  const buffer = toBuffer(data);
  const receivedAt = new Date().toISOString();
  const receivedAtMs = Date.parse(receivedAt);

  if (isBinary) {
    return {
      receivedAt,
      messageTimestampMs: null,
      messageLagMs: null,
      isBinary: true,
      rawEncoding: "base64",
      rawContent: buffer.toString("base64"),
      binarySize: buffer.byteLength,
      displayText: `binary message (${buffer.byteLength} bytes)`,
      messageType: null,
      groupId: null,
      groupName: null,
      userId: null,
      senderName: null,
      rawMessage: null,
    };
  }

  const content = buffer.toString("utf-8");
  const fallback: ParsedIncomingMessage = {
    receivedAt,
    messageTimestampMs: null,
    messageLagMs: null,
    isBinary: false,
    rawEncoding: "utf8",
    rawContent: content,
    binarySize: null,
    displayText: content,
    messageType: null,
    groupId: null,
    groupName: null,
    userId: null,
    senderName: null,
    rawMessage: null,
  };

  try {
    const payload = JSON.parse(content) as Record<string, unknown>;
    const sender =
      typeof payload.sender === "object" && payload.sender !== null
        ? (payload.sender as Record<string, unknown>)
        : {};
    const messageType = asOptionalText(payload.message_type);
    const groupName = asOptionalText(payload.group_name);
    const groupId = asOptionalText(payload.group_id);
    const senderName = asOptionalText(sender.nickname);
    const userId = asOptionalText(payload.user_id ?? sender.user_id);
    const rawMessage = stringifyMessageContent(payload.raw_message);
    const messageTimestampMs = readMessageTimestampMs(payload);
    const messageLagMs = messageTimestampMs === null ? null : receivedAtMs - messageTimestampMs;
    const displayTime = formatDisplayMessageTime(messageTimestampMs ?? receivedAtMs);

    if (messageType !== "group") {
      return {
        ...fallback,
        messageTimestampMs,
        messageLagMs,
        messageType,
        groupId,
        groupName,
        userId,
        senderName,
        rawMessage,
        displayText: null,
      };
    }

    const prefix = `\u7fa4\u804a [${asDisplayText(groupName, "\u672a\u77e5\u7fa4")}(${asDisplayText(groupId, "\u672a\u77e5\u7fa4\u53f7")})] [${asDisplayText(senderName, "\u672a\u77e5\u7528\u6237")}(${asDisplayText(userId, "\u672a\u77e5\u7528\u6237ID")})]`;

    return {
      ...fallback,
      messageTimestampMs,
      messageLagMs,
      messageType,
      groupId,
      groupName,
      userId,
      senderName,
      rawMessage,
      displayText: rawMessage ? `${displayTime} ${prefix} ${rawMessage}`.trim() : `${displayTime} ${prefix}`,
    };
  } catch (error) {
    void error;
    return fallback;
  }
}

function getLocalDayRange(referenceTime: string): { startMs: number; endMs: number } {
  const referenceTs = parseIsoTimestamp(referenceTime) ?? Date.now();
  const start = new Date(referenceTs);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function getLocalDayBootstrapKey(referenceTime: string): string {
  return String(getLocalDayRange(referenceTime).startMs);
}

function readHistoryMessageTimestampMs(message: GroupHistoryMessage): number | null {
  const candidates = [
    message.time,
    message.message_time,
    message.msgTime,
    message.timestamp,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate > 10_000_000_000 ? candidate : candidate * 1000;
    }

    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }

      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function readHistoryMessageSequence(message: GroupHistoryMessage): string | null {
  const candidates = [
    message.message_seq,
    message.msg_seq,
    message.seq,
    message.message_id,
    message.msgId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }

    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return null;
}

function extractGroupHistoryMessages(response: Record<string, unknown>): GroupHistoryMessage[] {
  const data = asObjectRecord(response.data);
  const messages = data?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => asObjectRecord(message))
    .filter((message): message is GroupHistoryMessage => Boolean(message));
}

function formatHistoryMessageContent(message: GroupHistoryMessage): string {
  const rawMessage = stringifyMessageContent(
    message.raw_message ?? message.message ?? message.content,
  );
  return rawMessage?.trim() ?? "";
}

function historyMessageToConversationTurn(groupId: string, message: GroupHistoryMessage): ConversationTurn | null {
  const timestampMs = readHistoryMessageTimestampMs(message);
  const content = formatHistoryMessageContent(message);
  if (timestampMs === null || !content) {
    return null;
  }

  const sender = asObjectRecord(message.sender) ?? {};
  const senderName = asOptionalText(sender.nickname ?? sender.card ?? message.nickname ?? message.senderName);
  const userId = asOptionalText(message.user_id ?? sender.user_id ?? sender.uin);
  const role = senderName?.trim().toLowerCase() === "holly" ? "assistant" : "user";

  return {
    groupId,
    role,
    senderName,
    userId,
    content,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

async function persistIncomingMessage(record: ParsedIncomingMessage): Promise<void> {
  const store = incomingMessageStore;
  if (!store) {
    return;
  }

  const nextSequence = ++incomingMessageSequence;
  const run = incomingMessageStoreQueue
    .catch(() => {
      // Keep the storage queue alive after a previous failure.
    })
    .then(async () => {
      await store.saveMessage({
        sequence: nextSequence,
        ...record,
      });
    });

  incomingMessageStoreQueue = run.catch(() => {
    // Keep the storage queue alive after a previous failure.
  });

  await run;
}

function writeMonitorEvent(res: ServerResponse, payload: MonitorSnapshot | MonitorEvent, eventName = "message"): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastMonitorEvent(payload: MonitorEvent): void {
  for (const stream of monitorStreams) {
    writeMonitorEvent(stream, payload);
  }
}

function pushMonitorEntry(kind: MonitorEntryKind, title: string, body: string, label?: string): MonitorEntry {
  const entry: MonitorEntry = {
    id: ++monitorEntryId,
    kind,
    title,
    body,
    timestamp: new Date().toISOString(),
    ...(label ? { label } : {}),
  };

  monitorHistory = [...monitorHistory.slice(-(WS_HISTORY_LIMIT - 1)), entry];
  broadcastMonitorEvent({
    type: "entry",
    entry,
  });

  return entry;
}

function updateMonitorStatus(state: MonitorConnectionState, detail: string): void {
  monitorStatus = {
    state,
    detail,
    updatedAt: new Date().toISOString(),
  };

  broadcastMonitorEvent({
    type: "status",
    status: monitorStatus,
  });
}

function buildMonitorSnapshot(): MonitorSnapshot {
  return {
    type: "snapshot",
    target: WS_TARGET_URL,
    status: monitorStatus,
    history: monitorHistory,
    conversationPreview: latestConversationPreview,
    claudeUsage: getLatestClaudeUsage(),
    tokenStats: getTodayTokenStats(),
  };
}

function updateConversationPreview(preview: MonitorConversationPreview | null): void {
  latestConversationPreview = preview
    ? {
        groupId: preview.groupId,
        updatedAt: preview.updatedAt,
        messages: preview.messages
          .slice(-MONITOR_PREVIEW_MESSAGE_LIMIT)
          .map((message): LlmMessage => ({
            role: message.role,
            content: message.content,
          })),
        estimatedTokens: preview.estimatedTokens,
        compressed: preview.compressed,
        contextLimitTokens: preview.contextLimitTokens,
        compressThresholdTokens: preview.compressThresholdTokens,
      }
    : null;

  broadcastMonitorEvent({
    type: "conversation",
    conversationPreview: latestConversationPreview,
  });
}

function formatElapsedDuration(startedAt: number, finishedAt: number): string {
  const elapsedMs = Math.max(0, finishedAt - startedAt);
  return elapsedMs >= 1000
    ? `${(elapsedMs / 1000).toFixed(2)}s`
    : `${elapsedMs}ms`;
}

function normalizeConversationGroupKey(groupId: string | null): string | null {
  const normalized = groupId?.trim() || null;
  return normalized;
}

function parseReplyGroupId(groupId: string | null): number {
  const normalized = normalizeConversationGroupKey(groupId);
  const numeric = normalized ? Number(normalized) : Number.NaN;
  if (!normalized || !Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`Cannot resolve reply group_id from incoming message: ${groupId ?? "null"}`);
  }

  return numeric;
}

function pruneConversationTurns(turns: ConversationTurn[], referenceTime: string): ConversationTurn[] {
  const referenceTs = parseIsoTimestamp(referenceTime);
  const filtered = referenceTs === null
    ? turns
    : turns.filter((turn) => {
        const turnTs = parseIsoTimestamp(turn.timestamp);
        if (turnTs === null) {
          return true;
        }

        // Keep the full per-group history (no daily reset); only drop turns
        // newer than the message being processed. context_limit_tokens in
        // prepareModelRequest is what actually bounds what reaches the model.
        return turnTs <= referenceTs;
      });

  return filtered.slice(-CONVERSATION_HISTORY_LIMIT);
}

function getConversationTurnKey(turn: ConversationTurn): string {
  return [
    turn.timestamp,
    turn.role,
    normalizeConversationGroupKey(turn.groupId) ?? "",
    turn.userId ?? "",
    turn.senderName ?? "",
    turn.content,
  ].join("\u0000");
}

function mergeConversationTurns(turns: ConversationTurn[], referenceTime: string): ConversationTurn[] {
  const deduped = new Map<string, ConversationTurn>();
  for (const turn of turns) {
    const content = turn.content.trim();
    if (!content) {
      continue;
    }
    deduped.set(getConversationTurnKey({ ...turn, content }), { ...turn, content });
  }

  const sorted = Array.from(deduped.values()).sort((left, right) => {
    const leftTs = parseIsoTimestamp(left.timestamp) ?? 0;
    const rightTs = parseIsoTimestamp(right.timestamp) ?? 0;
    return leftTs - rightTs;
  });

  return pruneConversationTurns(sorted, referenceTime);
}

function appendConversationTurn(turn: ConversationTurn): void {
  const groupKey = normalizeConversationGroupKey(turn.groupId);
  const content = turn.content.trim();
  if (!groupKey || !content) {
    return;
  }

  const normalizedTurn: ConversationTurn = {
    ...turn,
    groupId: groupKey,
    content,
  };
  const existing = conversationHistoryByGroup.get(groupKey) ?? [];
  const next = mergeConversationTurns([...existing, normalizedTurn], turn.timestamp);
  conversationHistoryByGroup.set(groupKey, next);
  globalContextDirty = true;
  broadcastMonitorEvent({
    type: "turn",
    groupId: groupKey,
    turn: normalizedTurn,
  });
}

function getLatestConversationTurn(groupId: string | null): ConversationTurn | null {
  const groupKey = normalizeConversationGroupKey(groupId);
  if (!groupKey) {
    return null;
  }

  const turns = conversationHistoryByGroup.get(groupKey) ?? [];
  return turns.at(-1) ?? null;
}

function buildConversationMessages(context: ModelRequestContext, currentMessages: readonly PendingModelMessage[]): LlmMessage[] {
  const groupKey = normalizeConversationGroupKey(context.groupId);
  if (!groupKey) {
    return [];
  }

  const currentTurnKeys = new Set(
    currentMessages.map((item) => getConversationTurnKey({
      groupId: groupKey,
      role: "user",
      senderName: item.context.senderName,
      userId: item.context.userId,
      content: item.message.trim(),
      timestamp: item.context.receivedAt,
    })),
  );
  const turns = pruneConversationTurns(
    conversationHistoryByGroup.get(groupKey) ?? [],
    context.receivedAt,
  ).filter((turn) => !currentTurnKeys.has(getConversationTurnKey(turn)));

  return turns.map(formatConversationTurnForModel);
}

// Merge every group's history into one chronological context. Used for both the
// real reply and the cache warmer so they share an identical cacheable prefix.
function buildGlobalConversationMessages(
  context: ModelRequestContext,
  currentMessages: readonly PendingModelMessage[],
): LlmMessage[] {
  const groupKey = normalizeConversationGroupKey(context.groupId);
  const currentTurnKeys = new Set(
    currentMessages.map((item) => getConversationTurnKey({
      groupId: groupKey,
      role: "user",
      senderName: item.context.senderName,
      userId: item.context.userId,
      content: item.message.trim(),
      timestamp: item.context.receivedAt,
    })),
  );

  const allTurns: ConversationTurn[] = [];
  for (const turns of conversationHistoryByGroup.values()) {
    for (const turn of turns) {
      allTurns.push(turn);
    }
  }

  // mergeConversationTurns dedupes (by group-aware key), sorts by timestamp, and
  // prunes anything newer than the message being processed.
  return mergeConversationTurns(allTurns, context.receivedAt)
    .filter((turn) => !currentTurnKeys.has(getConversationTurnKey(turn)))
    .map(formatGlobalConversationTurnForModel);
}

function hasConversationContextForGroup(groupId: string | null, referenceTime: string): boolean {
  const groupKey = normalizeConversationGroupKey(groupId);
  if (!groupKey) {
    return false;
  }

  const existing = conversationHistoryByGroup.get(groupKey) ?? [];
  const pruned = pruneConversationTurns(existing, referenceTime);
  if (pruned.length !== existing.length) {
    if (pruned.length > 0) {
      conversationHistoryByGroup.set(groupKey, pruned);
    } else {
      conversationHistoryByGroup.delete(groupKey);
    }
  }

  return pruned.length > 0;
}

async function bootstrapTodayGroupHistoryContext(groupId: string, referenceTime: string): Promise<void> {
  const groupKey = normalizeConversationGroupKey(groupId);
  if (!groupKey) {
    return;
  }

  const { startMs, endMs } = getLocalDayRange(referenceTime);
  const loadedTurns: ConversationTurn[] = [];
  let messageSeq = "0";

  pushMonitorEntry(
    "status",
    "Context Bootstrap",
    `group_id=${groupKey}\nLoading today's group history into context.`,
  );

  for (let page = 0; page < GROUP_HISTORY_BOOTSTRAP_MAX_PAGES; page += 1) {
    const response = await sendWsAction("get_group_msg_history", {
      group_id: groupKey,
      message_seq: messageSeq,
      count: GROUP_HISTORY_BOOTSTRAP_PAGE_SIZE,
      reverse_order: true,
      reverseOrder: true,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: false,
    });

    const messages = extractGroupHistoryMessages(response);
    if (messages.length === 0) {
      break;
    }

    let oldestTimestampMs: number | null = null;
    let oldestSequence: string | null = null;
    for (const historyMessage of messages) {
      const timestampMs = readHistoryMessageTimestampMs(historyMessage);
      const sequence = readHistoryMessageSequence(historyMessage);
      if (timestampMs !== null && (oldestTimestampMs === null || timestampMs < oldestTimestampMs)) {
        oldestTimestampMs = timestampMs;
        oldestSequence = sequence;
      }

      if (timestampMs === null || timestampMs < startMs || timestampMs >= endMs) {
        continue;
      }

      const turn = historyMessageToConversationTurn(groupKey, historyMessage);
      if (turn) {
        loadedTurns.push(turn);
      }
    }

    if (oldestTimestampMs !== null && oldestTimestampMs < startMs) {
      break;
    }

    if (!oldestSequence || oldestSequence === messageSeq) {
      break;
    }

    messageSeq = oldestSequence;
  }

  if (loadedTurns.length === 0) {
    pushMonitorEntry(
      "status",
      "Context Bootstrap",
      `group_id=${groupKey}\nNo messages found for today's group history.`,
    );
    return;
  }

  const existing = conversationHistoryByGroup.get(groupKey) ?? [];
  const next = mergeConversationTurns([...existing, ...loadedTurns], referenceTime);
  conversationHistoryByGroup.set(groupKey, next);
  pushMonitorEntry(
    "status",
    "Context Bootstrap",
    `group_id=${groupKey}\nLoaded ${next.length} messages from today's group history into context.`,
  );
}

async function ensureTodayGroupHistoryContext(groupId: string | null, referenceTime: string): Promise<void> {
  const groupKey = normalizeConversationGroupKey(groupId);
  if (!groupKey) {
    return;
  }

  hasConversationContextForGroup(groupKey, referenceTime);
  const dayKey = getLocalDayBootstrapKey(referenceTime);
  if (conversationHistoryBootstrapDayByGroup.get(groupKey) === dayKey) {
    return;
  }

  const existingBootstrap = conversationHistoryBootstrapByGroup.get(groupKey);
  if (existingBootstrap) {
    await existingBootstrap;
    return;
  }

  const bootstrap = bootstrapTodayGroupHistoryContext(groupKey, referenceTime)
    .then(() => {
      conversationHistoryBootstrapDayByGroup.set(groupKey, dayKey);
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Context Bootstrap Error", `group_id=${groupKey}\n${detail}`);
      console.error(`Failed to load group history for ${groupKey}:`, error);
    })
    .finally(() => {
      conversationHistoryBootstrapByGroup.delete(groupKey);
    });

  conversationHistoryBootstrapByGroup.set(groupKey, bootstrap);
  await bootstrap;
}


function formatConversationSenderLabel(senderName: string | null, userId: string | null): string | null {
  const normalizedSenderName = senderName?.trim() || null;
  const normalizedUserId = userId?.trim() || null;

  if (normalizedSenderName && normalizedUserId) {
    return `[${normalizedSenderName}(${normalizedUserId})]`;
  }

  if (normalizedSenderName) {
    return `[${normalizedSenderName}]`;
  }

  if (normalizedUserId) {
    return `[${normalizedUserId}]`;
  }

  return null;
}

function compactSameGroupConversationContent(content: string): string {
  return normalizeMessageContent(stripConversationPrefix(content));
}

function formatSameGroupUserContent(
  content: string,
  senderName: string | null,
  userId: string | null,
): string {
  const compactContent = compactSameGroupConversationContent(content);
  const senderLabel = formatConversationSenderLabel(senderName, userId);
  if (!senderLabel) {
    return compactContent;
  }

  return compactContent ? `${senderLabel} ${compactContent}` : senderLabel;
}

function formatConversationTurnForModel(turn: ConversationTurn): LlmMessage {
  const content = turn.role === "user"
    ? formatSameGroupUserContent(turn.content, turn.senderName, turn.userId)
    : normalizeMessageContent(turn.content);

  return {
    role: turn.role,
    content,
  };
}

// Like formatConversationTurnForModel but preserves group labeling so a merged
// cross-group log stays unambiguous about which group each line belongs to.
function formatGlobalConversationTurnForModel(turn: ConversationTurn): LlmMessage {
  if (turn.role === "user") {
    // Keep the raw "群聊 [群名(群号)] [发送人(编号)] 内容" prefix intact.
    return { role: "user", content: normalizeMessageContent(turn.content) };
  }

  // Assistant turns carry only Holly's reply text; tag the group she spoke in.
  const groupTag = turn.groupId ? `[群${turn.groupId}] ` : "";
  return { role: "assistant", content: `${groupTag}${normalizeMessageContent(turn.content)}` };
}

function getCurrentMessageLagMs(context: ModelRequestContext): number {
  const receivedAtMs = parseIsoTimestamp(context.receivedAt) ?? Date.now();
  const queuedMs = Math.max(0, Date.now() - receivedAtMs);
  return Math.max(0, context.messageLagMs ?? 0) + queuedMs;
}

// Local wall-clock time for the model. Injected into the per-request batch
// message (the cache tail), never the cached system prefix, so the constantly
// changing value never busts the 1h prompt cache.
function formatLocalDateTimeForModel(date = new Date()): string {
  const weekday = "日一二三四五六"[date.getDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())} 星期${weekday}`;
}

function formatUnreadMessagesForModel(messages: readonly PendingModelMessage[]): string {
  // The batch is single-group (queued per group), so any message carries the
  // current group_id. Surface it so the system prompt's per-group rules (e.g.
  // "group_id=20000003 只复读") can actually be applied — the compact message
  // format strips the group prefix, so this is the model's only signal of which
  // group it is in. Lives in the per-request tail, so it costs no prompt cache.
  const groupId = normalizeConversationGroupKey(messages.at(-1)?.context.groupId ?? null);
  const lines = [
    "Scheduled unread-message scan for this group:",
    `- current_time: ${formatLocalDateTimeForModel()}`,
    ...(groupId ? [`- group_id: ${groupId}`] : []),
    `- unread_message_count: ${messages.length}`,
    `- stale_after_seconds: ${Math.floor(MESSAGE_REPLY_MAX_AGE_MS / 1000)}`,
    "- Decide whether to reply to anything in this unread batch. Send at most one reply.",
  ];

  for (const [index, item] of messages.entries()) {
    lines.push(
      "",
      `Unread message ${index + 1}:`,
      `- message_age_seconds: ${formatMessageAgeSeconds(item.context.messageLagMs)}`,
      formatSameGroupUserContent(item.message, item.context.senderName, item.context.userId),
    );
  }

  return lines.join("\n");
}

function formatMemoryLine(record: StoredMemoryRecord): string | null {
  const receivedAt = record.receivedAt ?? "unknown_time";
  const senderName = record.senderName ?? "unknown_user";
  const userId = record.userId ?? "unknown_user_id";
  const contentSource = record.displayText?.trim() || record.rawMessage?.trim();
  const content = contentSource ? compactSameGroupConversationContent(contentSource) : "";

  if (!content) {
    return null;
  }

  return `[${receivedAt}] sender=${senderName}(${userId}) ${content}`;
}

function parseIsoTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripConversationPrefix(text: string): string {
  return text
    .replace(/^群聊\s*\[[^\]]+\]\s*\[[^\]]+\]\s*/u, "")
    .replace(/\[图片OCR\]\s*/gu, " ")
    .trim();
}

function extractMentionTargets(text: string): string[] {
  const normalized = decodeHtmlEntities(text);
  const mentions = Array.from(normalized.matchAll(/@([^\s,@，。:：]+)/gu))
    .map((match) => match[1]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));

  if (normalized.toLowerCase().includes("holly")) {
    mentions.push("holly");
  }

  return Array.from(new Set(mentions));
}

function normalizeLooseText(text: string): string {
  return decodeHtmlEntities(text)
    .toLowerCase()
    .replace(/\[cq:[^\]]+\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasReplySegment(text: string | null): boolean {
  if (!text) {
    return false;
  }

  return /\[CQ:reply,[^\]]+\]/i.test(text);
}

function containsLooseNameReference(text: string | null, targetName: string | null): boolean {
  if (!text || !targetName) {
    return false;
  }

  const normalizedText = normalizeLooseText(text);
  const normalizedTarget = targetName.trim().toLowerCase();
  if (!normalizedText || !normalizedTarget || normalizedTarget.length < 2) {
    return false;
  }

  return normalizedText.includes(`@${normalizedTarget}`) || normalizedText.includes(normalizedTarget);
}

function computeParticipantLinkScore(context: ModelRequestContext, candidate: StoredMemoryRecord): number {
  const currentText = context.rawMessage?.trim() || "";
  const candidateText = candidate.rawMessage?.trim() || candidate.displayText?.trim() || "";
  let score = 0;

  if (hasReplySegment(currentText)) {
    score += 0.45;
  }

  if (containsLooseNameReference(currentText, candidate.senderName)) {
    score += 0.35;
  }

  if (containsLooseNameReference(candidateText, context.senderName)) {
    score += 0.2;
  }

  return Math.min(score, 1);
}

function buildSimilarityUnits(text: string): string[] {
  const normalized = stripConversationPrefix(text)
    .toLowerCase()
    .replace(/\[cq:[^\]]+\]/gi, " ")
    .replace(/[^\p{L}\p{N}\p{Script=Han}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const units = new Set<string>();
  const asciiWords = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  for (const word of asciiWords) {
    units.add(`w:${word}`);
  }

  const hanChars = Array.from(normalized.replace(/[^\p{Script=Han}]/gu, ""));
  for (let index = 0; index < hanChars.length; index += 1) {
    units.add(`c:${hanChars[index]}`);
    if (index < hanChars.length - 1) {
      units.add(`b:${hanChars[index]}${hanChars[index + 1]}`);
    }
  }

  return Array.from(units);
}

function computeTokenJaccard(left: string, right: string): number {
  const leftUnits = buildSimilarityUnits(left);
  const rightUnits = buildSimilarityUnits(right);
  if (leftUnits.length === 0 || rightUnits.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftUnits);
  const rightSet = new Set(rightUnits);
  let intersection = 0;
  for (const unit of leftSet) {
    if (rightSet.has(unit)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function computeTimeScore(currentReceivedAt: string, candidateReceivedAt: string | null): number {
  const currentTs = parseIsoTimestamp(currentReceivedAt);
  const candidateTs = parseIsoTimestamp(candidateReceivedAt);
  if (currentTs === null || candidateTs === null) {
    return 0;
  }

  const deltaMs = currentTs - candidateTs;
  if (deltaMs < 0 || deltaMs > THREAD_HARD_CUTOFF_MS) {
    return 0;
  }

  if (deltaMs <= THREAD_TIME_WINDOW_MS) {
    return 1 - (deltaMs / THREAD_TIME_WINDOW_MS) * 0.35;
  }

  const remainingWindow = THREAD_HARD_CUTOFF_MS - THREAD_TIME_WINDOW_MS;
  return remainingWindow <= 0 ? 0 : 0.65 * (1 - (deltaMs - THREAD_TIME_WINDOW_MS) / remainingWindow);
}

function computeDirectedScore(context: ModelRequestContext, candidate: StoredMemoryRecord): number {
  const currentText = context.rawMessage?.trim() || "";
  const candidateText = candidate.rawMessage?.trim() || candidate.displayText?.trim() || "";
  const currentMentions = extractMentionTargets(currentText);
  const candidateMentions = extractMentionTargets(candidateText);
  const currentTargetsHolly = currentMentions.includes("holly");
  const candidateTargetsHolly = candidateMentions.includes("holly");
  const sameSender =
    Boolean(context.userId && candidate.userId) &&
    context.userId === candidate.userId;

  let score = 0;
  if (currentTargetsHolly) {
    score += 0.55;
  }
  if (candidateTargetsHolly) {
    score += 0.25;
  }
  if (sameSender) {
    score += 0.15;
  }

  return Math.min(score, 1);
}

function computeConversationThreadScore(
  context: ModelRequestContext,
  currentMessage: string,
  candidate: StoredMemoryRecord,
): ThreadScoreBreakdown {
  const candidateText = candidate.displayText?.trim() || candidate.rawMessage?.trim() || "";
  if (!candidateText) {
    return {
      total: 0,
      similarity: 0,
      time: 0,
      directed: 0,
      participantLink: 0,
      sameSender: 0,
    };
  }

  const timeScore = computeTimeScore(context.receivedAt, candidate.receivedAt);
  if (timeScore === 0) {
    return {
      total: 0,
      similarity: 0,
      time: 0,
      directed: 0,
      participantLink: 0,
      sameSender: 0,
    };
  }

  const directedScore = computeDirectedScore(context, candidate);
  const participantLinkScore = computeParticipantLinkScore(context, candidate);
  const sameSender =
    Boolean(context.userId && candidate.userId) &&
    context.userId === candidate.userId;
  const senderScore = sameSender ? 1 : 0;
  const similarityScore = Math.max(
    computeTokenJaccard(currentMessage, candidateText),
    computeTokenJaccard(context.rawMessage ?? currentMessage, candidate.rawMessage ?? candidateText),
  );

  const weightedScore =
    similarityScore * 0.42 +
    timeScore * 0.25 +
    directedScore * 0.15 +
    participantLinkScore * 0.13 +
    senderScore * 0.05;

  const total =
    participantLinkScore >= 0.45 && timeScore >= 0.3
      ? Math.max(weightedScore, 0.68)
      : weightedScore;

  return {
    total,
    similarity: similarityScore,
    time: timeScore,
    directed: directedScore,
    participantLink: participantLinkScore,
    sameSender: senderScore,
  };
}

async function buildMemoryPrompt(
  context: ModelRequestContext,
  currentMessage: string,
  excludedMessages: readonly string[] = [currentMessage],
): Promise<string> {
  const store = incomingMessageStore;
  if (!store) {
    return "";
  }

  const contextGroupId = normalizeConversationGroupKey(context.groupId);
  if (!contextGroupId) {
    return "";
  }

  const memories = await store.listRecentMemories({
    groupId: contextGroupId,
    limit: THREAD_CANDIDATE_LIMIT + 1,
  });

  const excludedMessageSet = new Set(excludedMessages.map((message) => message.trim()));
  const scoredMemories = memories
    .filter((record) => !excludedMessageSet.has(record.displayText?.trim() || record.rawMessage?.trim() || ""))
    .map((record) => ({
      record,
      score: computeConversationThreadScore(context, currentMessage, record),
    }))
    .filter((item) => item.score.total >= THREAD_SCORE_THRESHOLD)
    .sort((left, right) => {
      if (right.score.total !== left.score.total) {
        return right.score.total - left.score.total;
      }

      const leftTs = parseIsoTimestamp(left.record.receivedAt) ?? 0;
      const rightTs = parseIsoTimestamp(right.record.receivedAt) ?? 0;
      return rightTs - leftTs;
    })
    .slice(0, MEMORY_LOOKBACK_LIMIT);

  const lines = scoredMemories
    .map((item) => {
      const line = formatMemoryLine(item.record);
      return line ? line : null;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return "";
  }

  return [
    "Recent memory for the same conversation thread:",
    `- Retrieval scope: group_id=${contextGroupId}, recent_group_messages=${THREAD_CANDIDATE_LIMIT}`,
    `- Thread rule: time proximity + directed-to-Holly + participant link + text similarity`,
    `- Returned memories: ${lines.length}`,
    lines.join("\n"),
    "Use these memories only as conversation context. Prioritize the current incoming message if there is any conflict.",
  ].join("\n");
}

function unwrapJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```[a-zA-Z]*\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function readDecisionText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("; ");
  }

  return "";
}

function keepTextAfterLastMarker(text: string, marker: RegExp): string {
  const matches = Array.from(text.matchAll(marker));
  if (matches.length === 0) {
    return text;
  }

  const lastMatch = matches[matches.length - 1];
  if (typeof lastMatch.index !== "number") {
    return text;
  }

  const start = lastMatch.index + lastMatch[0].length;

  return text.slice(start).trim();
}

function sanitizeFinalAnswer(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) {
    return "";
  }

  cleaned = keepTextAfterLastMarker(
    cleaned,
    /(?:\u6700\u7ec8\u56de\u7b54|\u6700\u7ec8\u56de\u590d|final_answer|final answer)\s*[:\uFF1A]/gi,
  );

  if (
    /^(?:\u601d\u8def\u6458\u8981|\u601d\u8003\u8fc7\u7a0b|reasoning_summary|reasoning summary|thought summary|thinking_process|thinking process)\s*[:\uFF1A]?/i.test(cleaned)
  ) {
    const lines = cleaned.split(/\r?\n/);
    const answerLines: string[] = [];
    let skippingMeta = true;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (!skippingMeta) {
          answerLines.push(rawLine);
        }
        continue;
      }

      if (skippingMeta) {
        if (
          /^(?:\u601d\u8def\u6458\u8981|\u601d\u8003\u8fc7\u7a0b|reasoning_summary|reasoning summary|thought summary|thinking_process|thinking process)\s*[:\uFF1A]?/i.test(line) ||
          /^(?:[-*\u2022]|\d+\.)\s*/.test(line) ||
          /^(?:answer|should_reply|shouldReply|reply)\s*[:\uFF1A]\s*(?:true|false)\s*$/i.test(line)
        ) {
          continue;
        }

        skippingMeta = false;
      }

      answerLines.push(rawLine);
    }

    cleaned = answerLines.join("\n").trim();
  }

  cleaned = cleaned
    .replace(/^(?:answer|should_reply|shouldReply|reply)\s*[:\uFF1A]\s*(?:true|false)\s*/i, "")
    .replace(/^(?:\u6700\u7ec8\u56de\u7b54|\u6700\u7ec8\u56de\u590d|final_answer|final answer)\s*[:\uFF1A]\s*/i, "")
    .trim();

  return cleaned;
}

function sanitizeThinkingProcess(text: string): string {
  return text
    .trim()
    .replace(
      /^(?:\u601d\u8003\u8fc7\u7a0b|\u601d\u8def\u6458\u8981|thinking_process|thinking process|reasoning_summary|reasoning summary|thought summary)\s*[:\uFF1A]\s*/i,
      "",
    )
    .trim();
}

function parseModelDecision(raw: string): ModelDecision {
  const normalized = unwrapJsonBlock(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`Model response is not valid JSON: ${raw}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Model response must be a JSON object: ${raw}`);
  }

  const payload = parsed as Record<string, unknown>;
  const shouldReply =
    payload.should_reply === true ||
    payload.shouldReply === true ||
    payload.reply === true ||
    payload.should_reply === "true" ||
    payload.shouldReply === "true";
  const finalAnswer = sanitizeFinalAnswer(
    readDecisionText(payload.final_answer ?? payload.finalAnswer),
  );
  const thinkingProcess = sanitizeThinkingProcess(
    readDecisionText(
      payload.thinking_process ??
      payload.thinkingProcess ??
      payload.reasoning_summary ??
      payload.reasoningSummary ??
      payload.thought_summary ??
      payload.thoughtSummary,
    ),
  );

  return {
    shouldReply,
    finalAnswer,
    thinkingProcess,
    raw,
  };
}

function formatModelReplyEntry(decision: ModelDecision): string {
  const lines = [
    `是否回复: ${decision.shouldReply ? "是" : "否"}`,
    `思考过程: ${decision.thinkingProcess || "（空）"}`,
    `最终回复: ${decision.finalAnswer || "（空）"}`,
  ];

  if (!decision.shouldReply) {
    lines.push("回复状态: 跳过");
    lines.push("跳过原因: 模型判定该消息与自己无关，不会发送。");
  } else if (!decision.finalAnswer) {
    lines.push("回复状态: 跳过");
    lines.push("跳过原因: 模型选择回复，但最终回复内容为空。");
  } else {
    lines.push("回复状态: 待发送");
  }

  return lines.join("\n");
}

function handleWsActionResponse(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const payload = parsed as Record<string, unknown>;
  const echo = typeof payload.echo === "string" ? payload.echo : "";
  if (!echo) {
    return false;
  }

  const pending = pendingWsActions.get(echo);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timer);
  pendingWsActions.delete(echo);

  const status = typeof payload.status === "string" ? payload.status : "";
  const retcode = typeof payload.retcode === "number" ? payload.retcode : -1;
  if (status === "ok" && retcode === 0) {
    pending.resolve(payload);
  } else {
    pending.reject(new Error(`${pending.action} failed: ${JSON.stringify(payload)}`));
  }

  return true;
}

async function sendGroupMessage(groupId: number, message: string): Promise<void> {
  await sendWsAction("send_group_msg", {
      group_id: groupId,
      message,
  });
}

function parseLookupRequest(raw: string): { needSearch: boolean; searchQuery: string } {
  try {
    const parsed = JSON.parse(unwrapJsonBlock(raw)) as Record<string, unknown>;
    const flag =
      parsed.need_search === true ||
      parsed.needSearch === true ||
      parsed.need_search === "true" ||
      parsed.needSearch === "true";
    const query =
      typeof parsed.search_query === "string"
        ? parsed.search_query.trim()
        : typeof parsed.searchQuery === "string"
          ? parsed.searchQuery.trim()
          : "";
    return { needSearch: flag && query.length > 0, searchQuery: query };
  } catch {
    return { needSearch: false, searchQuery: "" };
  }
}

function formatSearchResultsForModel(query: string, results: readonly SearchResult[]): string {
  if (results.length === 0) {
    return `[搜索结果] 关于「${query}」没有查到相关资料。`;
  }
  const lines = results.map(
    (result, index) => `${index + 1}. ${result.title}\n   ${result.snippet}\n   来源: ${result.url}`,
  );
  return `[搜索结果] 关于「${query}」查到以下资料(仅供参考,自行判断可信度):\n${lines.join("\n")}`;
}

// "查一下再答" step (snippets-only, reactive). If the first decision asked to look
// something up, run the search and re-ask the model with the snippets injected
// into the current-message slot (same cached system+history prefix). Returns the
// reply to parse: the original one when no search was requested, the second-pass
// reply when it was, or a stay-silent decision when search was wanted but
// unavailable (so a placeholder first answer is never sent).
async function applyLookupIfRequested(
  firstReply: string,
  ctx: {
    client: LlmClient;
    memoryPrompt: string;
    conversationMessages: readonly LlmMessage[];
    batchMessage: string;
    startedAt: number;
  },
): Promise<string> {
  const lookup = parseLookupRequest(firstReply);
  if (!lookup.needSearch) {
    return firstReply;
  }

  if (!searchConfig.enabled || !process.env.SERPER_API_KEY) {
    pushMonitorEntry(
      "status",
      "Web Search Unavailable",
      `query=${lookup.searchQuery}(搜索未启用或缺 SERPER_API_KEY,保持沉默)`,
    );
    return JSON.stringify({
      should_reply: false,
      final_answer: "",
      thinking_process: "想查证但搜索不可用,保持沉默",
      need_search: false,
      search_query: "",
    });
  }

  pushMonitorEntry("status", "Web Search", `query=${lookup.searchQuery}`);
  let results: SearchResult[] = [];
  try {
    results = await searchWeb(lookup.searchQuery, { topK: searchConfig.topK, timeoutMs: searchConfig.timeoutMs });
  } catch (error) {
    pushMonitorEntry("error", "Web Search Failed", error instanceof Error ? error.message : String(error));
  }

  const resultsBlock = formatSearchResultsForModel(lookup.searchQuery, results);
  const augmentedMessage =
    `${ctx.batchMessage}\n\n${resultsBlock}\n\n` +
    "(以上是你刚查到的资料,请据此决定要不要回复并作答;need_search 设为 false,不要再要求搜索。)";
  const prepared = prepareModelRequest(
    ctx.client.systemPrompt,
    ctx.memoryPrompt,
    ctx.conversationMessages,
    augmentedMessage,
  );

  pushMonitorEntry("status", "Search-Augmented Model Request", `${results.length} 条结果\n${resultsBlock}`);
  let secondReply: string;
  try {
    secondReply = await ctx.client.generateText({
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
      jsonSchema: MODEL_DECISION_JSON_SCHEMA,
    });
  } catch (error) {
    pushMonitorEntry("error", "Search Re-ask Failed", error instanceof Error ? error.message : String(error));
    return JSON.stringify({
      should_reply: false,
      final_answer: "",
      thinking_process: "搜索后重问失败,保持沉默",
      need_search: false,
      search_query: "",
    });
  }

  broadcastMonitorEvent({ type: "usage", claudeUsage: getLatestClaudeUsage() });
  const callTokens = consumeLatestCallTokenUsage();
  if (callTokens) {
    recordTokenUsage(callTokens.model, callTokens.inputTokens, callTokens.outputTokens);
    broadcastMonitorEvent({ type: "tokens", tokenStats: getTodayTokenStats() });
  }
  return secondReply;
}

async function forwardUnreadMessagesToModel(pendingMessages: readonly PendingModelMessage[]): Promise<void> {
  const messages = pendingMessages
    .map((item) => ({
      ...item,
      context: {
        ...item.context,
        messageLagMs: getCurrentMessageLagMs(item.context),
      },
    }))
    .filter((item) => (item.context.messageLagMs ?? 0) <= MESSAGE_REPLY_MAX_AGE_MS);

  if (messages.length === 0) {
    pushMonitorEntry("status", "Unread Batch Skipped", "All queued messages became stale before the scheduled model scan ran.");
    return;
  }

  const client = getActiveLlmClient();
  const startedAt = Date.now();
  const latestMessage = messages[messages.length - 1];
  const batchMessage = formatUnreadMessagesForModel(messages);
  const context = latestMessage.context;
  const replyGroupId = parseReplyGroupId(context.groupId);
  const effectiveContext: ModelRequestContext = {
    ...context,
    groupId: normalizeConversationGroupKey(context.groupId),
  };
  const memoryPrompt = await buildMemoryPrompt(
    effectiveContext,
    batchMessage,
    messages.map((item) => item.message),
  );
  const conversationMessages = buildGlobalConversationMessages(effectiveContext, messages);
  const preparedRequest = prepareModelRequest(
    client.systemPrompt,
    memoryPrompt,
    conversationMessages,
    batchMessage,
  );

  updateConversationPreview({
    groupId: effectiveContext.groupId,
    updatedAt: context.receivedAt,
    messages: preparedRequest.messages,
    estimatedTokens: preparedRequest.estimatedTokens,
    compressed: preparedRequest.usedCompression,
    contextLimitTokens: contextBudgetConfig.limitTokens,
    compressThresholdTokens: contextBudgetConfig.compressThresholdTokens,
  });

  pushMonitorEntry("status", "Scheduled Model Request", batchMessage);
  await appendChatLog("user", batchMessage);

  let reply: string;
  try {
    reply = await client.generateText({
      systemPrompt: preparedRequest.systemPrompt,
      messages: preparedRequest.messages,
      jsonSchema: MODEL_DECISION_JSON_SCHEMA,
    });
  } catch (error) {
    throw new RetryableModelBatchError("Model request failed; unread batch will be retried.", error);
  }

  broadcastMonitorEvent({ type: "usage", claudeUsage: getLatestClaudeUsage() });

  const callTokens = consumeLatestCallTokenUsage();
  if (callTokens) {
    recordTokenUsage(callTokens.model, callTokens.inputTokens, callTokens.outputTokens);
    broadcastMonitorEvent({ type: "tokens", tokenStats: getTodayTokenStats() });
  }

  // "查一下再答": if the model asked to look something up, search and re-ask.
  reply = await applyLookupIfRequested(reply, {
    client,
    memoryPrompt,
    conversationMessages,
    batchMessage,
    startedAt,
  });

  let decision: ModelDecision;
  try {
    decision = parseModelDecision(reply);
  } catch (error) {
    throw new RetryableModelBatchError("Model response was invalid; unread batch will be retried.", error);
  }
  const content = formatModelReplyEntry(decision);
  await appendChatLog("assistant", content);
  pushMonitorEntry(
    "assistant",
    `Model Reply - ${formatElapsedDuration(startedAt, Date.now())}`,
    content,
    client.model,
  );

  if (!decision.shouldReply) {
    return;
  }

  if (!decision.finalAnswer) {
    return;
  }

  const latestTurn = getLatestConversationTurn(effectiveContext.groupId);
  if (latestTurn?.role === "assistant") {
    pushMonitorEntry(
      "status",
      "Reply Skipped",
      "Latest same-group conversation turn is already an assistant message; waiting for another user message before speaking again.",
    );
    return;
  }

  await sendGroupMessage(replyGroupId, decision.finalAnswer);
  appendConversationTurn({
    groupId: effectiveContext.groupId,
    role: "assistant",
    senderName: null,
    userId: null,
    content: decision.finalAnswer,
    timestamp: new Date().toISOString(),
  });
  pushMonitorEntry(
    "outgoing",
    "Group Message Sent",
    `group_id=${replyGroupId}\n${decision.finalAnswer}`,
  );
}

function enqueueUnreadBatchForModel(messages: PendingModelMessage[]): void {
  modelQueue = modelQueue
    .catch(() => {
      // Keep the queue alive after a previous failure.
    })
    .then(async () => {
      await forwardUnreadMessagesToModel(messages);
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof RetryableModelBatchError) {
        restoreUnreadBatchForModel(messages);
      }
      pushMonitorEntry("error", "Model Error", detail);
      console.error("Model request failed:", error);
    });
}

async function warmGlobalContext(): Promise<void> {
  if (!globalContextDirty) {
    return;
  }

  const client = activeLlmClient;
  if (!client || client.provider !== "claude") {
    // Only Anthropic prompt caching benefits from warming.
    return;
  }

  const warmRequestContext: ModelRequestContext = {
    groupId: null,
    userId: null,
    senderName: null,
    rawMessage: null,
    receivedAt: new Date().toISOString(),
    messageLagMs: null,
  };

  const conversationMessages = buildGlobalConversationMessages(warmRequestContext, []);
  if (conversationMessages.length === 0) {
    globalContextDirty = false;
    return;
  }

  // Build the same system + history prefix a real reply uses (empty current
  // message, no memory) so the warmed cache is the one the next reply reads.
  const prepared = prepareModelRequest(client.systemPrompt, "", conversationMessages, "");
  if (prepared.messages.length === 0) {
    globalContextDirty = false;
    return;
  }

  // Clear before awaiting so messages arriving during the call re-arm the flag.
  globalContextDirty = false;
  const startedAt = Date.now();
  await client.warmContext({
    systemPrompt: prepared.systemPrompt,
    messages: prepared.messages,
  });

  broadcastMonitorEvent({ type: "usage", claudeUsage: getLatestClaudeUsage() });
  const callTokens = consumeLatestCallTokenUsage();
  if (callTokens) {
    recordTokenUsage(callTokens.model, callTokens.inputTokens, callTokens.outputTokens);
    broadcastMonitorEvent({ type: "tokens", tokenStats: getTodayTokenStats() });
  }

  pushMonitorEntry(
    "status",
    `Context Warmed - ${formatElapsedDuration(startedAt, Date.now())}`,
    `Refreshed prompt cache with ${prepared.messages.length} messages (~${prepared.estimatedTokens} tokens).`,
  );
}

function scheduleGlobalContextWarm(): void {
  // Serialize on the model queue so warming never races a real reply; concurrent
  // requests sharing a prefix would all miss the cache.
  modelQueue = modelQueue
    .catch(() => {
      // Keep the queue alive after a previous failure.
    })
    .then(async () => {
      await warmGlobalContext();
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Context Warm Error", detail);
      console.error("Context warm failed:", error);
    });
}

const PROACTIVE_SHADOW_LOG_PATH = join(LOG_DIR, "proactive-shadow.jsonl");

function appendProactiveShadowLog(record: Record<string, unknown>): void {
  proactiveShadowQueue = proactiveShadowQueue
    .then(async () => {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(PROACTIVE_SHADOW_LOG_PATH, `${JSON.stringify(record)}\n`, "utf-8");
    })
    .catch((error) => {
      console.error("Failed to write proactive shadow log:", error);
    });
}

// Gate B (6A): reuse the exact cached system + global-history prefix a reactive
// reply uses; the proactive instruction rides only in the current-message slot,
// so this call hits the 1h prompt cache instead of reprocessing the full context.
async function evaluateProactiveRevival(
  groupKey: string,
  threadSummary: string,
): Promise<ProactiveDecision | null> {
  const client = activeLlmClient;
  if (!client) return null;

  const context: ModelRequestContext = {
    groupId: groupKey,
    userId: null,
    senderName: null,
    rawMessage: null,
    receivedAt: new Date().toISOString(),
    messageLagMs: null,
  };
  const conversationMessages = buildGlobalConversationMessages(context, []);
  const instruction = buildProactiveRevivePrompt(threadSummary);
  const prepared = prepareModelRequest(client.systemPrompt, "", conversationMessages, instruction);
  if (prepared.messages.length === 0) return null;

  let reply: string;
  try {
    reply = await client.generateText({
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
      jsonSchema: MODEL_DECISION_JSON_SCHEMA,
    });
  } catch (error) {
    pushMonitorEntry("error", "Proactive Model Error", error instanceof Error ? error.message : String(error));
    return null;
  }

  broadcastMonitorEvent({ type: "usage", claudeUsage: getLatestClaudeUsage() });
  const callTokens = consumeLatestCallTokenUsage();
  if (callTokens) {
    recordTokenUsage(callTokens.model, callTokens.inputTokens, callTokens.outputTokens);
    broadcastMonitorEvent({ type: "tokens", tokenStats: getTodayTokenStats() });
  }

  try {
    const decision = parseModelDecision(reply);
    return {
      shouldReply: decision.shouldReply,
      finalAnswer: decision.finalAnswer,
      thinkingProcess: decision.thinkingProcess,
    };
  } catch {
    // Invalid JSON → fail safe: treat as "do not speak".
    return null;
  }
}

function buildProactiveDeps(): ProactiveDeps | null {
  const store = hollyStateStore;
  if (!store) return null;
  return {
    now: () => Date.now(),
    listGroups: () => Array.from(conversationHistoryByGroup.keys()),
    getHistory: (groupKey) => conversationHistoryByGroup.get(groupKey) ?? [],
    evaluateRevival: evaluateProactiveRevival,
    send: sendGroupMessage,
    appendAssistantTurn: (groupKey, text) =>
      appendConversationTurn({
        groupId: groupKey,
        role: "assistant",
        senderName: null,
        userId: null,
        content: text,
        timestamp: new Date().toISOString(),
      }),
    parseGroupId: (groupKey) => {
      const numeric = Number(groupKey);
      return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    },
    log: (kind, title, body) => {
      pushMonitorEntry(kind, title, body);
    },
    shadowLog: appendProactiveShadowLog,
    config: proactiveConfig,
    state: store,
  };
}

// Serialize on the model queue so the proactive tick never races a reactive
// reply or the cache warmer (shared prefix → all-or-nothing cache hits).
function scheduleProactiveTick(): void {
  const deps = buildProactiveDeps();
  if (!deps || !deps.config.enabled) return;
  modelQueue = modelQueue
    .catch(() => {
      // Keep the queue alive after a previous failure.
    })
    .then(async () => {
      await runProactiveTick(deps);
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Proactive Tick Error", detail);
      console.error("Proactive tick failed:", error);
    });
}

function restoreUnreadBatchForModel(messages: PendingModelMessage[]): void {
  const groupKey = normalizeConversationGroupKey(messages[0]?.context.groupId ?? null);
  if (!groupKey || messages.length === 0) {
    return;
  }

  const pendingMessages = unreadModelMessagesByGroup.get(groupKey) ?? [];
  unreadModelMessagesByGroup.set(groupKey, [...messages, ...pendingMessages]);
  pushMonitorEntry(
    "status",
    "Unread Batch Restored",
    `group_id=${groupKey}\nrestored_messages=${messages.length}\nunread_messages=${messages.length + pendingMessages.length}`,
  );
}

function queueUnreadMessageForModel(message: string, context: ModelRequestContext): number | null {
  const groupKey = normalizeConversationGroupKey(context.groupId);
  if (!groupKey) {
    pushMonitorEntry("status", "Message Skipped", "Cannot schedule model processing without a group_id.");
    return null;
  }

  const pendingMessages = unreadModelMessagesByGroup.get(groupKey) ?? [];
  pendingMessages.push({
    message,
    context: {
      ...context,
      groupId: groupKey,
    },
  });
  unreadModelMessagesByGroup.set(groupKey, pendingMessages);
  return pendingMessages.length;
}

function flushUnreadMessagesToModel(): void {
  if (unreadModelMessagesByGroup.size === 0) {
    return;
  }

  const batches = Array.from(unreadModelMessagesByGroup.entries());
  unreadModelMessagesByGroup.clear();
  for (const [groupId, messages] of batches) {
    pushMonitorEntry(
      "status",
      "Unread Batch Ready",
      `group_id=${groupId}\nunread_messages=${messages.length}`,
    );
    enqueueUnreadBatchForModel(messages);
  }
}

function handleMonitorStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  monitorStreams.add(res);
  writeMonitorEvent(res, buildMonitorSnapshot(), "snapshot");

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    monitorStreams.delete(res);
    res.end();
  });
}

function scheduleWebSocketReconnect(reason: string): void {
  if (wsReconnectTimer) {
    return;
  }

  pushMonitorEntry("status", "Reconnect Scheduled", `${reason}\nRetrying in ${WS_RECONNECT_DELAY_MS / 1000} seconds.`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocketClient();
  }, WS_RECONNECT_DELAY_MS);
}

function connectWebSocketClient(forceReconnect = false): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  if (wsClient) {
    const state = wsClient.readyState;
    if (!forceReconnect && (state === WebSocket.OPEN || state === WebSocket.CONNECTING)) {
      return;
    }

    if (forceReconnect && state !== WebSocket.CLOSED) {
      wsClient.removeAllListeners();
      wsClient.terminate();
      // terminate() drops the socket without firing our close handler, so clear
      // any in-flight actions here too.
      rejectAllPendingWsActions("Upstream WebSocket force-reconnected before the action response arrived.");
    }

    wsClient = null;
  }

  updateMonitorStatus("connecting", `Connecting to ${WS_TARGET_URL}`);
  pushMonitorEntry("status", forceReconnect ? "Reconnect Requested" : "Connecting", WS_TARGET_URL);

  const client = new WebSocket(WS_TARGET_URL);
  wsClient = client;

  client.on("open", () => {
    if (wsClient !== client) {
      return;
    }

    updateMonitorStatus("open", `Connected to ${WS_TARGET_URL}`);
    pushMonitorEntry("status", "Connection Opened", `Connected to ${WS_TARGET_URL}`);
    console.log(`WebSocket client connected to ${WS_TARGET_URL}`);
  });

  client.on("message", async (data, isBinary) => {
    if (wsClient !== client) {
      return;
    }

    if (!isBinary) {
      const content = toBuffer(data).toString("utf-8");
      if (handleWsActionResponse(content)) {
        return;
      }
    }

    const parsedMessage = parseIncomingMessage(data, isBinary);
    const ocrMessage = await enrichMessageWithImageOcr(parsedMessage);
    const message = await enrichMessageWithUrlContent(ocrMessage);
    try {
      await persistIncomingMessage(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Qdrant Store Error", detail);
      console.error("Failed to store incoming message:", error);
    }

    if (message.displayText === null) {
      return;
    }

    console.log(`WebSocket client received: ${message.displayText}`);

    if (isHollyMessage(message)) {
      pushMonitorEntry("status", "Message Skipped", "Sender is holly; skipping model processing.");
      return;
    }

    await ensureTodayGroupHistoryContext(message.groupId, message.receivedAt);

    appendConversationTurn({
      groupId: message.groupId,
      role: "user",
      senderName: message.senderName,
      userId: message.userId,
      content: message.displayText,
      timestamp: message.receivedAt,
    });

    const isStale = message.messageLagMs !== null && message.messageLagMs > MESSAGE_REPLY_MAX_AGE_MS;
    const unreadCount = isStale
      ? null
      : queueUnreadMessageForModel(message.displayText, {
          groupId: message.groupId,
          userId: message.userId,
          senderName: message.senderName,
          rawMessage: message.rawMessage,
          receivedAt: message.receivedAt,
          messageLagMs: message.messageLagMs,
        });

    pushMonitorEntry(
      "incoming",
      "Group Message",
      `group_id=${message.groupId ?? "unknown"}\n${message.displayText}` +
        (unreadCount !== null ? `\nunread_messages=${unreadCount}` : ""),
    );

    if (isStale) {
      pushMonitorEntry(
        "status",
        "Message Skipped",
        `Message is older than 5 minutes; added to context but skipping model processing.\nage_seconds=${formatMessageAgeSeconds(message.messageLagMs)}\n${message.displayText}`,
      );
      return;
    }
  });

  client.on("close", (code, reasonBuffer) => {
    if (wsClient === client) {
      wsClient = null;
      rejectAllPendingWsActions("Upstream WebSocket disconnected before the action response arrived.");
    }

    const reason = reasonBuffer.toString("utf-8").trim();
    const detail = reason
      ? `Connection closed (code ${code}, reason: ${reason})`
      : `Connection closed (code ${code})`;

    updateMonitorStatus("closed", detail);
    pushMonitorEntry("status", "Connection Closed", detail);
    console.log(`WebSocket client closed: ${detail}`);
    scheduleWebSocketReconnect("Upstream WebSocket disconnected.");
  });

  client.on("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    updateMonitorStatus("error", detail);
    pushMonitorEntry("error", "Client Error", detail);
    console.error("WebSocket client error:", error);
  });
}

const UNIFIED_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Holly</title>
  <style>
    :root {
      --sidebar-w: 220px;
      --sidebar-bg: #18202e;
      --sidebar-text: #8899b0;
      --panel: rgba(255,255,255,0.92);
      --ink: #1e293b;
      --muted: #64748b;
      --line: rgba(148,163,184,0.28);
      --accent: #0f766e;
      --accent-h: #0d5e57;
      --radius: 14px;
      --entry-in: #ecfeff;
      --entry-out: #ecfdf5;
      --entry-status: #eff6ff;
      --entry-error: #fff1f2;
      --entry-assistant: #f5f3ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      display: flex; min-height: 100vh; width: 100%;
      font-family: "Segoe UI", system-ui, sans-serif;
      color: var(--ink);
      background: linear-gradient(135deg, #f0f4f8, #e8eef5);
    }
    #app { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .sidebar {
      width: var(--sidebar-w); min-height: 100vh;
      background: var(--sidebar-bg);
      display: flex; flex-direction: column; flex-shrink: 0;
      position: fixed; left: 0; top: 0; bottom: 0; z-index: 10;
    }
    .brand { padding: 22px 18px 18px; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .brand-name { font-size: 18px; font-weight: 800; color: #fff; letter-spacing: -0.02em; }
    .brand-sub { font-size: 11px; color: var(--sidebar-text); margin-top: 2px; }
    .nav { flex: 1; padding: 14px 10px; display: flex; flex-direction: column; gap: 3px; list-style: none; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: 9px; cursor: pointer;
      color: var(--sidebar-text); font-size: 13px; font-weight: 500;
      transition: background 0.12s, color 0.12s; user-select: none;
    }
    .nav-item:hover { background: rgba(255,255,255,0.06); color: #c8d6e5; }
    .nav-item.active { background: rgba(255,255,255,0.11); color: #fff; }
    .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .ws-status {
      padding: 14px 18px; border-top: 1px solid rgba(255,255,255,0.07);
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; color: var(--sidebar-text);
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #475569; flex-shrink: 0; }
    .dot.open { background: #22c55e; }
    .dot.connecting { background: #eab308; animation: pulse 1.2s infinite; }
    .dot.error { background: #ef4444; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    .main { margin-left: var(--sidebar-w); flex: 1; padding: 24px; min-height: 100vh; min-width: 0; width: calc(100% - var(--sidebar-w)); }
    .ph { margin-bottom: 18px; }
    .ph-eye { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin-bottom: 3px; }
    .ph-title { font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
    .ph-desc { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); backdrop-filter: blur(8px); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    .ph2 { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
    .ph2-title { font-size: 14px; font-weight: 700; }
    .pb { padding: 16px 18px; }
    .g2 { display: grid; grid-template-columns: minmax(0,1.6fr) minmax(260px,0.75fr); gap: 16px; }
    .g2l { display: grid; grid-template-columns: 200px 1fr; gap: 16px; }
    .badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #e2e8f0; color: #334155; }
    .badge.open { background: #dcfce7; color: #166534; }
    .badge.connecting { background: #fef3c7; color: #92400e; }
    .badge.error { background: #ffe4e6; color: #be123c; }
    .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .url-tag { flex: 1 1 180px; padding: 8px 11px; border-radius: 9px; background: rgba(248,250,252,0.9); border: 1px solid var(--line); font-family: Consolas,monospace; font-size: 11px; color: #0f172a; word-break: break-all; }
    button { border: 0; border-radius: 999px; padding: 9px 15px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; color: #fff; background: var(--accent); transition: background 0.12s; }
    button:hover { background: var(--accent-h); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.sec { color: var(--ink); background: #e2e8f0; }
    button.sec:hover { background: #cbd5e1; }
    button.sm { padding: 6px 11px; font-size: 11px; }
    .log { min-height: 380px; max-height: 66vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 3px; }
    .group-log { min-height: 180px; max-height: 260px; }
    .entry { border-radius: 10px; border: 1px solid var(--line); padding: 10px 13px; background: #fff; flex-shrink: 0; }
    .entry.incoming { background: var(--entry-in); }
    .entry.outgoing { background: var(--entry-out); }
    .entry.status { background: var(--entry-status); }
    .entry.error { background: var(--entry-error); }
    .entry.assistant { background: var(--entry-assistant); }
    .entry-h { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
    .entry pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas,monospace; font-size: 13px; line-height: 1.5; }
    .empty { border: 1px dashed var(--line); border-radius: 10px; padding: 18px; color: var(--muted); background: rgba(255,255,255,0.6); text-align: center; font-size: 13px; }
    .stack { display: flex; flex-direction: column; gap: 10px; }
    select { width: 100%; border: 1px solid var(--line); border-radius: 9px; padding: 9px 11px; font: inherit; font-size: 13px; color: var(--ink); background: rgba(255,255,255,0.94); }
    .meta-tag { padding: 8px 11px; border-radius: 9px; background: rgba(248,250,252,0.9); border: 1px solid var(--line); font-family: Consolas,monospace; font-size: 11px; color: #0f172a; }
    .conv-box { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 12px; }
    .conv-log { display: flex; flex-direction: column; gap: 7px; max-height: 260px; overflow-y: auto; margin-top: 8px; }
    .ci { border-radius: 9px; border: 1px solid var(--line); padding: 9px 11px; background: rgba(255,255,255,0.8); }
    .ci.user { background: rgba(224,242,254,0.9); }
    .ci.assistant { background: rgba(237,233,254,0.9); }
    .ci.system { background: rgba(240,249,255,0.9); }
    .ci-h { display: flex; justify-content: space-between; font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
    .ci pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas,monospace; font-size: 11px; line-height: 1.4; }
    .usage-total-row { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 16px; margin-bottom: 14px; border-radius: 10px; background: rgba(248,250,252,0.9); border: 1px solid var(--line); font-size: 14px; font-weight: 700; color: var(--ink); }
    .usage-day { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; background: rgba(255,255,255,0.7); }
    .usage-day-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .usage-date { font-size: 13px; font-weight: 700; color: var(--ink); }
    .usage-day-total { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--accent); }
    .usage-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .usage-table th { text-align: right; font-weight: 600; color: var(--muted); padding: 4px 6px; border-bottom: 1px solid var(--line); }
    .usage-table th:first-child { text-align: left; }
    .usage-table td { text-align: right; padding: 4px 6px; font-variant-numeric: tabular-nums; color: var(--ink); border-bottom: 1px solid rgba(226,232,240,0.5); }
    .usage-table td:first-child { text-align: left; font-family: Consolas,monospace; color: var(--muted); word-break: break-all; }
    .usage-table tr:last-child td { border-bottom: 0; }
    .fgrid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)) auto; gap: 10px; align-items: end; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: var(--muted); }
    input { width: 100%; border: 1px solid var(--line); border-radius: 9px; padding: 9px 11px; font: inherit; font-size: 13px; color: var(--ink); background: rgba(255,255,255,0.94); }
    .mem-meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; margin-top: 10px; }
    .mem-list { display: flex; flex-direction: column; gap: 9px; }
    .mi { border: 1px solid var(--line); border-radius: 11px; padding: 13px 15px; background: #fff; }
    .mi-h { display: flex; flex-wrap: wrap; gap: 6px; justify-content: space-between; margin-bottom: 7px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #475467; }
    .mi-m { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; color: var(--muted); font-size: 11px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas,monospace; font-size: 12px; line-height: 1.55; }
    .glist { display: flex; flex-direction: column; gap: 5px; }
    .gi { padding: 11px 13px; border-radius: 9px; border: 1px solid var(--line); background: #fff; cursor: pointer; transition: background 0.12s; }
    .gi:hover { background: #f1f5f9; }
    .gi.active { background: #ecfeff; border-color: #67e8f9; }
    .gi-name { font-size: 13px; font-weight: 600; }
    .gi-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    /* Group Talk full-height layout */
    .group-view { display: flex; flex-direction: column; height: calc(100vh - 48px); gap: 0; width: 100%; }
    .gp-live { flex: none; min-height: 80px; }
    .gp-resizer { flex: none; height: 6px; cursor: row-resize; background: transparent; position: relative; z-index: 10; transition: background 0.15s; }
    .gp-resizer:hover, .gp-resizer.dragging { background: #6366f1; }
    .gp-resizer::before { content: ''; position: absolute; left: 50%; transform: translateX(-50%); top: 2px; width: 36px; height: 2px; border-radius: 2px; background: #cbd5e1; pointer-events: none; }
    .gp-resizer:hover::before, .gp-resizer.dragging::before { background: #fff; }
    .gp-bottom { flex: 1; min-height: 0; width: 100%; grid-template-rows: 1fr; margin-top: 16px; }
    .gp-panel { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    .gp-scroll { flex: 1; overflow-y: auto; padding: 12px 14px; min-height: 0; }
    .chat-scroll { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; }
    /* Full-width message rows */
    .msg-entry { width: 100%; padding: 10px 16px; border-left: 3px solid transparent; transition: background 0.1s; }
    .msg-entry:hover { filter: brightness(0.97); }
    .msg-entry.user { background: #f0f9ff; border-left-color: #38bdf8; }
    .msg-entry.assistant { background: #f5f3ff; border-left-color: #a78bfa; }
    .msg-entry.system { background: #f8fafc; border-left-color: #94a3b8; }
    .msg-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .msg-name { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .msg-entry.user .msg-name { color: #0369a1; }
    .msg-entry.assistant .msg-name { color: #7c3aed; }
    .msg-entry.system .msg-name { color: #64748b; }
    .msg-time { font-size: 12px; color: var(--muted); flex-shrink: 0; }
    .msg-body { font-size: 16px; line-height: 1.6; word-break: break-word; white-space: pre-wrap; color: var(--ink); }
    .hint { font-size: 12px; color: var(--muted); line-height: 1.6; }
    @media (max-width: 900px) {
      .g2, .g2l { grid-template-columns: 1fr; }
      .fgrid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 640px) {
      :root { --sidebar-w: 58px; }
      .brand-name, .brand-sub, .nav-label, .ws-status span:last-child { display: none; }
      .nav-item { justify-content: center; }
      .fgrid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<div id="app">
  <nav class="sidebar">
    <div class="brand">
      <div class="brand-name">Holly</div>
      <div class="brand-sub">WS Monitor</div>
    </div>
    <ul class="nav">
      <li class="nav-item" :class="{active: tab === 'agent'}" @click="tab = 'agent'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="7" height="7" rx="1" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="14" y="3" width="7" height="7" rx="1" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="3" y="14" width="7" height="7" rx="1" stroke-linecap="round" stroke-linejoin="round"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M14 17.5h7M17.5 14v7"/>
        </svg>
        <span class="nav-label">Agent</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'memory'}" @click="tab = 'memory'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 12c0 1.657 4.03 3 9 3s9-1.343 9-3"/>
        </svg>
        <span class="nav-label">Memory</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'group'}" @click="tab = 'group'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v3l-3-3H9a2 2 0 01-2-2v-1"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 8a2 2 0 012-2h10a2 2 0 012 2v5a2 2 0 01-2 2H8l-3 3V8z"/>
        </svg>
        <span class="nav-label">Group Talk</span>
      </li>
      <li class="nav-item" :class="{active: tab === 'usage'}" @click="tab = 'usage'">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 3v18h18"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 14l3-3 3 3 4-5"/>
        </svg>
        <span class="nav-label">Usage</span>
      </li>
    </ul>
    <div class="ws-status">
      <span class="dot" :class="wsStatus.state"></span>
      <span>{{ wsStatusLabel }}</span>
    </div>
  </nav>

  <main class="main">
    <!-- Agent -->
    <div v-if="tab === 'agent'">
      <div class="ph">
        <div class="ph-eye">WebSocket &#8594; LLM</div>
        <div class="ph-title">Agent Monitor</div>
        <div class="ph-desc">Model profile configuration and latest request payload.</div>
      </div>
      <div class="panel">
          <div class="ph2"><span class="ph2-title">Model Settings</span></div>
          <div class="pb">
            <div class="stack">
              <p class="hint">Switch the active LLM profile. Changes apply immediately and are written to config.yaml.</p>
              <div v-if="claudeUsage" style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted,#64748b);">
                <span>Subscription Usage</span>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="width:18px;">5h</span>
                  <div style="width:100px;height:6px;background:#eef2f7;border-radius:4px;overflow:hidden;">
                    <div :style="{ width: usageWidth(claudeUsage.fiveHourUtilization), height: '100%', background: usageColor(claudeUsage.fiveHourUtilization) }"></div>
                  </div>
                  <span style="font-variant-numeric:tabular-nums;">{{ usagePct(claudeUsage.fiveHourUtilization) }}</span>
                  <span style="opacity:.8;">&middot; resets {{ fmtReset(claudeUsage.fiveHourResetAt) }} &middot; {{ claudeUsage.fiveHourStatus || '-' }}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="width:18px;">7d</span>
                  <div style="width:100px;height:6px;background:#eef2f7;border-radius:4px;overflow:hidden;">
                    <div :style="{ width: usageWidth(claudeUsage.sevenDayUtilization), height: '100%', background: usageColor(claudeUsage.sevenDayUtilization) }"></div>
                  </div>
                  <span style="font-variant-numeric:tabular-nums;">{{ usagePct(claudeUsage.sevenDayUtilization) }}</span>
                  <span style="opacity:.8;">&middot; resets {{ fmtReset(claudeUsage.sevenDayResetAt) }} &middot; {{ claudeUsage.sevenDayStatus || '-' }}</span>
                </div>
                <span style="opacity:.7;">Updated {{ fmtTime(new Date(claudeUsage.capturedAt).toISOString()) }}</span>
              </div>
              <div v-if="tokenStats && tokenStats.models && tokenStats.models.length" style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--muted,#64748b);margin-top:4px;">
                <span>Token Usage &middot; {{ tokenStats.date }}</span>
                <div v-for="m in tokenStats.models" :key="m.model" style="display:flex;justify-content:space-between;gap:8px;">
                  <span style="opacity:.85;">{{ m.model }}</span>
                  <span style="font-variant-numeric:tabular-nums;">{{ fmtNum(m.totalTokens) }}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:8px;border-top:1px solid #eef2f7;padding-top:2px;font-weight:600;">
                  <span>Total</span>
                  <span style="font-variant-numeric:tabular-nums;">{{ fmtNum(tokenStats.totalTokens) }}</span>
                </div>
              </div>
              <select v-model="selProfile">
                <option v-for="p in profiles" :key="p.name" :value="p.name">{{ p.displayName }}</option>
              </select>
              <button @click="switchProfile" :disabled="switching">{{ switching ? 'Switching...' : 'Switch Model' }}</button>
              <div class="meta-tag">{{ profileMeta }}</div>
              <div class="conv-box">
                <p class="hint">Latest <code>messages</code> payload sent to the model.</p>
                <div class="meta-tag" style="margin-top:8px;word-break:break-word;">{{ convMetaText }}</div>
                <div class="conv-log">
                  <div v-if="!convPreview || !convPreview.messages || !convPreview.messages.length" class="empty" style="font-size:11px;">No conversation yet.</div>
                  <template v-else>
                    <article v-for="(m, i) in convPreview.messages" :key="i" class="ci" :class="m.role">
                      <div class="ci-h">
                        <span>{{ m.role === 'assistant' ? 'Holly' : m.role === 'system' ? 'System' : 'User' }}</span>
                        <span>#{{ i + 1 }}</span>
                      </div>
                      <pre>{{ m.content }}</pre>
                    </article>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
    </div>

    <!-- Memory -->
    <div v-else-if="tab === 'memory'">
      <div class="ph">
        <div class="ph-eye">Memory</div>
        <div class="ph-title">Memory</div>
        <div class="ph-desc">短期记忆（会话历史·内存，重启会丢） 与 长期记忆（Qdrant·持久化保留）。</div>
      </div>

      <div class="panel" style="margin-bottom:14px;">
        <div class="ph2">
          <span class="ph2-title">短期记忆 &middot; 会话历史</span>
          <button class="sec sm" @click="loadGroups">Refresh</button>
        </div>
        <div class="pb">
          <p class="hint">模型每次回复时直接看到的近期对话上下文，按群存在内存里，重启后丢失。</p>
          <label style="display:block;margin-top:8px;font-size:12px;color:var(--muted);">Group
            <select v-model="selGroupId" @change="onPickShortTermGroup" style="margin-top:4px;">
              <option :value="null">Select a group</option>
              <option v-for="g in groups" :key="g.groupId" :value="g.groupId">{{ g.groupId }} ({{ g.turnCount }} turns)</option>
            </select>
          </label>
          <div class="chat-scroll" style="margin-top:10px;max-height:340px;border:1px solid #eef2f7;border-radius:8px;">
            <div v-if="!selGroupId" class="empty" style="margin:16px;">Select a group to view its short-term conversation.</div>
            <div v-else-if="!groupTurns.length" class="empty" style="margin:16px;">No short-term messages for this group.</div>
            <template v-else>
              <div v-for="(t, i) in reversedGroupTurns" :key="i" class="msg-entry" :class="t.role">
                <div class="msg-head">
                  <span class="msg-name">{{ t.role === 'assistant' ? 'Holly' : (t.senderName || t.userId || 'User') }}</span>
                  <span class="msg-time">{{ fmtTime(t.timestamp) }}</span>
                </div>
                <div class="msg-body">{{ t.content }}</div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="ph" style="margin-top:18px;">
        <div class="ph-eye">Qdrant</div>
        <div class="ph-title">长期记忆 &middot; Stored Memories</div>
        <div class="ph-desc">Browse recent records saved from the upstream WebSocket stream.</div>
      </div>
      <div class="panel" style="margin-bottom:14px;">
        <div class="ph2"><span class="ph2-title">Filters</span></div>
        <div class="pb">
          <form class="fgrid" @submit.prevent="loadMemories">
            <label>Group ID <input v-model="mf.groupId" placeholder="20000001" /></label>
            <label>User ID <input v-model="mf.userId" placeholder="10000003" /></label>
            <label>Type
              <select v-model="mf.messageType">
                <option value="group">group</option>
                <option value="">all</option>
              </select>
            </label>
            <label>Limit <input v-model.number="mf.limit" type="number" min="1" max="100" /></label>
            <button type="submit" style="align-self:flex-end;">Load</button>
          </form>
          <div class="mem-meta">
            <span>{{ memItems.length }} records</span>
            <span>{{ memCollection || 'Qdrant unavailable' }}</span>
            <code style="margin-left:auto;font-size:11px;">{{ memPath }}</code>
          </div>
          <p class="hint" style="margin-top:5px;">{{ memMsg }}</p>
        </div>
      </div>
      <div class="panel">
        <div class="ph2"><span class="ph2-title">Results</span></div>
        <div class="pb">
          <div class="mem-list">
            <div v-if="memLoading" class="empty">Loading...</div>
            <div v-else-if="memErr" class="empty">{{ memErr }}</div>
            <div v-else-if="!memItems.length" class="empty">No memories matched the current filters.</div>
            <template v-else>
              <article v-for="item in memItems" :key="item.sequence" class="mi">
                <div class="mi-h">
                  <span>{{ item.receivedAt || 'unknown' }}</span>
                  <span>seq {{ item.sequence != null ? item.sequence : '-' }}</span>
                </div>
                <div class="mi-m">
                  <span>group: {{ item.groupName || '-' }} ({{ item.groupId || '-' }})</span>
                  <span>user: {{ item.senderName || '-' }} ({{ item.userId || '-' }})</span>
                  <span>type: {{ item.messageType || '-' }}</span>
                </div>
                <pre>{{ item.displayText || item.rawMessage || item.rawContent || '(empty)' }}</pre>
              </article>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Group Talk -->
    <div v-else-if="tab === 'group'" class="group-view">
      <div class="panel gp-panel gp-live" :style="{ flexBasis: gpLiveHeight + 'px' }">
        <div class="ph2">
          <span class="ph2-title">Live Messages</span>
          <button class="sec sm" @click="clearEntries">Clear</button>
        </div>
        <div class="chat-scroll" style="padding:10px 12px;gap:8px;">
          <div v-if="!entries.length" class="empty" style="margin:8px;">Waiting for messages&hellip;</div>
          <template v-else>
            <article v-for="e in entries" :key="e.id" class="entry" :class="e.kind">
              <div class="entry-h">
                <span>{{ e.label || e.kind }} &mdash; {{ e.title }}</span>
                <span>{{ fmtTime(e.timestamp) }}</span>
              </div>
              <pre>{{ fmtBody(e.body) }}</pre>
            </article>
          </template>
        </div>
      </div>

      <div class="gp-resizer" :class="{ dragging: gpDragging }" @mousedown="onResizerMousedown"></div>

      <div class="g2l gp-bottom">
        <div class="panel gp-panel">
          <div class="ph2">
            <span class="ph2-title">Groups</span>
            <button class="sec sm" @click="loadGroups">Refresh</button>
          </div>
          <div class="gp-scroll">
            <div v-if="!groups.length" class="empty">No active conversations yet.</div>
            <div class="glist" v-else>
              <div v-for="g in groups" :key="g.groupId"
                class="gi" :class="{active: selGroupId === g.groupId}"
                @click="selectGroup(g.groupId)">
                <div class="gi-name">{{ g.groupId }}</div>
                <div class="gi-meta">{{ g.turnCount }} turns &middot; {{ g.lastTurn ? fmtTime(g.lastTurn.timestamp) : '&ndash;' }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel gp-panel">
          <div class="ph2">
            <span class="ph2-title">{{ selGroupId ? 'Group ' + selGroupId : 'Select a group' }}</span>
            <button v-if="selGroupId" class="sec sm" @click="loadGroupTurns(selGroupId)">Refresh</button>
          </div>
          <div class="chat-scroll">
            <div v-if="!selGroupId" class="empty" style="margin:16px;">Select a group from the list to view its conversation.</div>
            <div v-else-if="!groupTurns.length" class="empty" style="margin:16px;">No messages in this group today.</div>
            <template v-else>
              <div v-for="(t, i) in reversedGroupTurns" :key="i" class="msg-entry" :class="t.role">
                <div class="msg-head">
                  <span class="msg-name">{{ t.role === 'assistant' ? 'Holly' : (t.senderName || t.userId || 'User') }}</span>
                  <span class="msg-time">{{ fmtTime(t.timestamp) }}</span>
                </div>
                <div class="msg-body">{{ t.content }}</div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Usage -->
    <div v-else-if="tab === 'usage'">
      <div class="ph">
        <div class="ph-eye">Token</div>
        <div class="ph-title">每日 Token 用量</div>
        <div class="ph-desc">按日期与模型统计的 token 使用量（input + output），含每日合计。</div>
      </div>
      <div class="panel">
        <div class="ph2">
          <span class="ph2-title">Daily Token Usage</span>
          <button class="sec sm" @click="loadUsageHistory">Refresh</button>
        </div>
        <div class="pb">
          <div v-if="!usageHistory.length" class="empty">No token usage recorded yet.</div>
          <template v-else>
            <div class="usage-total-row">
              <span>合计 &middot; 最近 {{ usageHistory.length }} 天</span>
              <span style="font-variant-numeric:tabular-nums;">{{ fmtNum(usageGrandTotal) }} tokens</span>
            </div>
            <div v-for="day in usageHistory" :key="day.date" class="usage-day">
              <div class="usage-day-head">
                <span class="usage-date">{{ day.date }}</span>
                <span class="usage-day-total">{{ fmtNum(day.totalTokens) }} tokens</span>
              </div>
              <table class="usage-table">
                <thead>
                  <tr><th>Model</th><th>Input</th><th>Output</th><th>Total</th></tr>
                </thead>
                <tbody>
                  <tr v-for="m in day.models" :key="m.model">
                    <td>{{ m.model }}</td>
                    <td>{{ fmtNum(m.inputTokens) }}</td>
                    <td>{{ fmtNum(m.outputTokens) }}</td>
                    <td>{{ fmtNum(m.totalTokens) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>
    </div>
  </main>
</div>

<script src="/vendor/vue.global.prod.js"></script>
<script>
var _wsTarget = ${JSON.stringify(WS_TARGET_URL)};
var _Vue = Vue;
var createApp = _Vue.createApp;
var ref = _Vue.ref;
var computed = _Vue.computed;
var onMounted = _Vue.onMounted;
var onUnmounted = _Vue.onUnmounted;
var watch = _Vue.watch;

createApp({
  setup: function() {
    var tab = ref('agent');

    // Agent state
    var wsTargetUrl = ref(_wsTarget);
    var wsStatus = ref({ state: 'connecting', detail: '', updatedAt: '' });
    var wsStatusLabel = computed(function() {
      var s = wsStatus.value.state;
      if (s === 'open') return 'Connected';
      if (s === 'connecting') return 'Connecting';
      if (s === 'error') return 'Error';
      return 'Disconnected';
    });
    var entries = ref([]);
    var renderedIds = new Set();
    var convPreview = ref(null);
    var claudeUsage = ref(null);
    var tokenStats = ref(null);
    var usageHistory = ref([]);
    var usageGrandTotal = ref(0);
    var groupEntries = computed(function() {
      return entries.value.filter(function(e) {
        return e.kind === 'incoming' || e.kind === 'outgoing' || e.kind === 'assistant';
      });
    });
    var profiles = ref([]);
    var selProfile = ref('');
    var profileMeta = ref('Loading model profiles...');
    var switching = ref(false);
    var convMetaText = computed(function() {
      var p = convPreview.value;
      if (!p) return 'Waiting for the first model request...';
      var g = p.groupId || 'unknown_group';
      var u = p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : '?';
      var tok = typeof p.estimatedTokens === 'number' ? p.estimatedTokens : '?';
      var lim = typeof p.contextLimitTokens === 'number' ? p.contextLimitTokens : '?';
      var cmp = typeof p.compressThresholdTokens === 'number' ? p.compressThresholdTokens : '?';
      var msgs = (p.messages && p.messages.length) ? p.messages.length : 0;
      return 'Group: ' + g + '  |  Msgs: ' + msgs + '  |  Tokens: ~' + tok + '/' + lim + '  |  Compress@' + cmp + '  |  ' + (p.compressed ? 'Compressed' : 'Uncompressed') + '  |  ' + u;
    });

    // Memory state
    var mf = ref({ groupId: '', userId: '', messageType: 'group', limit: 20 });
    var memItems = ref([]);
    var memCollection = ref('');
    var memLoading = ref(false);
    var memErr = ref('');
    var memMsg = ref('');
    var memPath = ref('/api/memories');

    // Group Talk state
    var groups = ref([]);
    var selGroupId = ref(null);
    var groupTurns = ref([]);
    var reversedGroupTurns = computed(function() { return groupTurns.value.slice().reverse(); });

    // Resizer drag state
    var gpLiveHeight = ref(280);
    var gpDragging = ref(false);
    var _dragStartY = 0;
    var _dragStartH = 0;
    function onResizerMousedown(e) {
      gpDragging.value = true;
      _dragStartY = e.clientY;
      _dragStartH = gpLiveHeight.value;
      e.preventDefault();
      document.addEventListener('mousemove', _onResizerMousemove);
      document.addEventListener('mouseup', _onResizerMouseup);
    }
    function _onResizerMousemove(e) {
      if (!gpDragging.value) return;
      var delta = e.clientY - _dragStartY;
      gpLiveHeight.value = Math.max(80, Math.min(_dragStartH + delta, window.innerHeight - 200));
    }
    function _onResizerMouseup() {
      gpDragging.value = false;
      document.removeEventListener('mousemove', _onResizerMousemove);
      document.removeEventListener('mouseup', _onResizerMouseup);
    }

    // SSE
    var es = null;
    var streamConn = false;

    function clearEntries() {
      entries.value = [];
      renderedIds.clear();
    }

    function fmtTime(ts) {
      if (!ts) return '-';
      try { return new Date(ts).toLocaleTimeString(); } catch(e) { return String(ts); }
    }

    function fmtBody(body) {
      if (typeof body !== 'string') return JSON.stringify(body, null, 2);
      try { return JSON.stringify(JSON.parse(body), null, 2); } catch(e) { return body; }
    }

    function usagePct(u) {
      if (typeof u !== 'number') return 'n/a';
      return (u * 100).toFixed(1) + '%';
    }
    function usageWidth(u) {
      if (typeof u !== 'number') return '0%';
      return Math.max(0, Math.min(100, u * 100)).toFixed(1) + '%';
    }
    function usageColor(u) {
      if (typeof u !== 'number') return '#cbd5e1';
      if (u >= 0.9) return '#ef4444';
      if (u >= 0.6) return '#f59e0b';
      return '#10b981';
    }
    function fmtReset(ms) {
      if (typeof ms !== 'number') return '-';
      var diff = ms - Date.now();
      if (diff <= 0) return 'soon';
      var mins = Math.round(diff / 60000);
      if (mins < 60) return 'in ' + mins + 'm';
      var hrs = Math.floor(mins / 60);
      var rem = mins % 60;
      if (hrs < 24) return 'in ' + hrs + 'h' + (rem ? ' ' + rem + 'm' : '');
      var days = Math.floor(hrs / 24);
      var remH = hrs % 24;
      return 'in ' + days + 'd' + (remH ? ' ' + remH + 'h' : '');
    }

    function pushEntry(entry) {
      if (renderedIds.has(entry.id)) return;
      renderedIds.add(entry.id);
      entries.value.unshift(entry);
      if (entries.value.length > 120) entries.value.splice(120);
    }

    function renderSnapshot(payload) {
      renderedIds.clear();
      wsStatus.value = payload.status;
      convPreview.value = payload.conversationPreview;
      if (payload.claudeUsage) { claudeUsage.value = payload.claudeUsage; }
      if (payload.tokenStats) { tokenStats.value = payload.tokenStats; }
      entries.value = [];
      var visible = payload.history || [];
      for (var i = visible.length - 1; i >= 0; i--) { pushEntry(visible[i]); }
    }

    function handlePayload(payload) {
      if (payload.type === 'snapshot') { renderSnapshot(payload); return; }
      if (payload.type === 'status') { wsStatus.value = payload.status; return; }
      if (payload.type === 'conversation') { convPreview.value = payload.conversationPreview; return; }
      if (payload.type === 'usage') { if (payload.claudeUsage) { claudeUsage.value = payload.claudeUsage; } return; }
      if (payload.type === 'tokens') { tokenStats.value = payload.tokenStats; if (tab.value === 'usage') { loadUsageHistory(); } return; }
      if (payload.type === 'turn') { applyGroupTurn(payload.groupId, payload.turn); return; }
      if (payload.type === 'entry') { pushEntry(payload.entry); }
    }

    function connectES() {
      if (es) { es.close(); }
      es = new EventSource('/api/ws/events');
      es.addEventListener('open', function() {
        if (!streamConn) {
          pushEntry({ id: Date.now(), kind: 'status', title: 'Monitor Stream', body: 'Connected to backend event stream.', timestamp: new Date().toISOString() });
          streamConn = true;
        }
      });
      es.addEventListener('snapshot', function(ev) { handlePayload(JSON.parse(ev.data)); });
      es.onmessage = function(ev) { handlePayload(JSON.parse(ev.data)); };
      es.onerror = function() {
        if (!streamConn) return;
        streamConn = false;
        pushEntry({ id: Date.now(), kind: 'error', title: 'Monitor Stream', body: 'Lost connection. Browser will retry automatically.', timestamp: new Date().toISOString() });
      };
    }

    function loadProfiles() {
      return fetch('/api/llm/profiles').then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load profiles');
          // Hide Haiku: its 200K window can't hold the 800K global context.
          profiles.value = d.profiles.filter(function(p) { return !/haiku/i.test(p.model); });
          selProfile.value = d.active;
          profileMeta.value = 'Active model: ' + d.displayName;
        });
      }).catch(function(e) {
        profileMeta.value = 'Failed: ' + e.message;
      });
    }

    function switchProfile() {
      if (!selProfile.value) return;
      switching.value = true;
      fetch('/api/llm/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: selProfile.value })
      }).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to switch');
          profileMeta.value = 'Active model: ' + d.displayName;
          pushEntry({ id: Date.now(), kind: 'status', title: 'Profile Switched', body: d.displayName, timestamp: new Date().toISOString() });
        });
      }).catch(function(e) {
        pushEntry({ id: Date.now(), kind: 'error', title: 'Profile Switch Failed', body: e.message, timestamp: new Date().toISOString() });
        return loadProfiles();
      }).finally(function() {
        switching.value = false;
      });
    }

    function reconnect() {
      fetch('/api/ws/reconnect', { method: 'POST' }).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Reconnect failed');
          pushEntry({ id: Date.now(), kind: 'status', title: 'Reconnect Requested', body: d.message, timestamp: new Date().toISOString() });
        });
      }).catch(function(e) {
        pushEntry({ id: Date.now(), kind: 'error', title: 'Reconnect Failed', body: e.message, timestamp: new Date().toISOString() });
      });
    }

    function loadMemories() {
      var f = mf.value;
      var p = new URLSearchParams();
      if (f.groupId && f.groupId.trim()) p.set('group_id', f.groupId.trim());
      if (f.userId && f.userId.trim()) p.set('user_id', f.userId.trim());
      if (f.messageType && f.messageType.trim()) p.set('message_type', f.messageType.trim());
      if (f.limit) p.set('limit', String(f.limit));
      var path = '/api/memories' + (p.toString() ? '?' + p.toString() : '');
      memPath.value = path;
      memLoading.value = true;
      memErr.value = '';
      memMsg.value = 'Loading memories...';
      fetch(path).then(function(r) {
        return r.json().then(function(d) {
          if (!r.ok) throw new Error(d.error || 'Failed to load memories');
          memItems.value = d.items;
          memCollection.value = d.collection || '';
          memMsg.value = 'Showing most recent matching records.';
        });
      }).catch(function(e) {
        memErr.value = e.message;
        memItems.value = [];
        memMsg.value = e.message;
      }).finally(function() {
        memLoading.value = false;
      });
    }

    function loadGroups() {
      fetch('/api/conversations').then(function(r) {
        return r.json().then(function(d) { groups.value = d.groups || []; });
      }).catch(function() { groups.value = []; });
    }

    function loadGroupTurns(groupId) {
      fetch('/api/conversations/' + encodeURIComponent(groupId)).then(function(r) {
        return r.json().then(function(d) { groupTurns.value = d.turns || []; });
      }).catch(function() { groupTurns.value = []; });
    }

    function selectGroup(groupId) {
      selGroupId.value = groupId;
      loadGroupTurns(groupId);
    }

    function onPickShortTermGroup() {
      if (selGroupId.value) { loadGroupTurns(selGroupId.value); }
      else { groupTurns.value = []; }
    }

    function applyGroupTurn(groupId, turn) {
      if (!groupId || !turn) return;
      var existingIndex = groups.value.findIndex(function(g) { return g.groupId === groupId; });
      if (existingIndex === -1) {
        groups.value.unshift({ groupId: groupId, turnCount: 1, lastTurn: turn });
      } else {
        var existing = groups.value[existingIndex];
        groups.value.splice(existingIndex, 1, {
          groupId: groupId,
          turnCount: (existing.turnCount || 0) + 1,
          lastTurn: turn
        });
      }
      if (selGroupId.value === groupId) {
        groupTurns.value.push(turn);
      }
    }

    watch(tab, function(t) {
      if (t === 'memory') { loadMemories(); loadGroups(); }
      if (t === 'group') { loadGroups(); }
      if (t === 'usage') { loadUsageHistory(); }
    });

    function fmtNum(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '0';
      return n.toLocaleString('en-US');
    }

    function refreshUsage() {
      fetch('/api/usage/refresh', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.claudeUsage) { claudeUsage.value = d.claudeUsage; }
        if (d.tokenStats) { tokenStats.value = d.tokenStats; }
      }).catch(function() {});
    }

    function loadUsageHistory() {
      fetch('/api/usage/history').then(function(r) {
        return r.json().then(function(d) {
          usageHistory.value = d.days || [];
          usageGrandTotal.value = d.grandTotal || 0;
        });
      }).catch(function() { usageHistory.value = []; usageGrandTotal.value = 0; });
    }

    onMounted(function() {
      connectES();
      loadProfiles();
      refreshUsage();
    });

    onUnmounted(function() {
      if (es) { es.close(); }
    });

    return {
      tab, wsTargetUrl, wsStatus, wsStatusLabel,
      entries, groupEntries, convPreview, convMetaText, claudeUsage, tokenStats,
      usageHistory, usageGrandTotal,
      profiles, selProfile, profileMeta, switching,
      mf, memItems, memCollection, memLoading, memErr, memMsg, memPath,
      groups, selGroupId, groupTurns, reversedGroupTurns,
      gpLiveHeight, gpDragging, onResizerMousedown,
      fmtTime, fmtBody, usagePct, usageWidth, usageColor, fmtReset, fmtNum,
      clearEntries, reconnect, switchProfile, loadMemories, loadGroups, loadGroupTurns, selectGroup, onPickShortTermGroup,
      loadUsageHistory
    };
  }
}).mount('#app');
</script>
</body>
</html>
`;

async function bootstrap(): Promise<void> {
  await applyProxyConfig(CONFIG_PATH);
  await loadTokenStats();
  const requestedProfile = process.env.LLM_PROFILE?.trim() || undefined;
  const loadedContextBudgetConfig = await loadContextBudgetConfig(CONFIG_PATH);
  const loadedProactiveConfig = await loadProactiveConfig(CONFIG_PATH);
  const loadedSearchConfig = await loadSearchConfig(CONFIG_PATH);
  const client = await createLlmClient(CONFIG_PATH, requestedProfile);
  const store = await createIncomingMessageStore(CONFIG_PATH, {
    sessionId: APP_SESSION_ID,
    sessionStartedAt: APP_SESSION_STARTED_AT,
    wsTargetUrl: WS_TARGET_URL,
  });

  activeLlmClient = client;
  activeLlmLabel = client.displayName;
  contextBudgetConfig = loadedContextBudgetConfig;
  proactiveConfig = loadedProactiveConfig;
  searchConfig = loadedSearchConfig;
  hollyStateStore = await HollyStateStore.load(join(LOG_DIR, "holly-state.json"), loadedProactiveConfig.engagedTtlMs);
  incomingMessageStore = store;
  startConfigWatcher();
  if (store) {
    pushMonitorEntry("status", "Qdrant Ready", store.description);
  }
  pushMonitorEntry(
    "status",
    "Context Budget Ready",
    `limit=${contextBudgetConfig.limitTokens} tokens\ncompress_at=${contextBudgetConfig.compressThresholdTokens} tokens`,
  );

  connectWebSocketClient();

  // Review unread group activity in batches so Holly responds to a conversation,
  // rather than reacting immediately to each incoming message.
  setInterval(flushUnreadMessagesToModel, UNREAD_MODEL_FLUSH_INTERVAL_MS);

  // Keep the merged global context's 1h prompt cache warm; skips when idle.
  setInterval(scheduleGlobalContextWarm, CONTEXT_WARM_INTERVAL_MS);

  // Proactive Holly (slice 1): on a timer, consider reviving a dropped interest
  // thread during a lull. Default mode=shadow (logs only, never sends).
  pushMonitorEntry(
    "status",
    "Proactive Ready",
    `mode=${proactiveConfig.mode} enabled=${proactiveConfig.enabled}\nlull_min=${Math.round(proactiveConfig.lullMinMs / 60000)}min cap=${proactiveConfig.perGroupDailyCap}/group global=${proactiveConfig.globalDailyCap}`,
  );
  setInterval(scheduleProactiveTick, PROACTIVE_TICK_INTERVAL_MS);

  // Re-broadcast cached usage + today's token stats every 5 minutes. Keeps
  // late-joining clients in sync and rolls the token panel over to a new day
  // even when the group is quiet. Per the chosen policy this timer never probes.
  setInterval(() => {
    broadcastMonitorEvent({ type: "usage", claudeUsage: getLatestClaudeUsage() });
    broadcastMonitorEvent({ type: "tokens", tokenStats: getTodayTokenStats() });
  }, 5 * 60 * 1000);

  const server = createServer(async (req, res) => {
    try {
      const url = getRequestUrl(req);

      if (req.method === "GET" && url.pathname === "/vendor/vue.global.prod.js") {
        res.writeHead(VUE_RUNTIME_SOURCE ? 200 : 404, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(VUE_RUNTIME_SOURCE || "// Vendored Vue runtime missing");
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ws" || url.pathname === "/memories")) {
        sendHtml(res, UNIFIED_PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/ws/events") {
        handleMonitorStream(req, res);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/memories") {
        const store = incomingMessageStore;
        if (!store) {
          sendJson(res, 503, { error: "Memory store is not available." });
          return;
        }

        const limitValue = Number(url.searchParams.get("limit") || "20");
        const limit = Number.isFinite(limitValue)
          ? Math.max(1, Math.min(100, Math.floor(limitValue)))
          : 20;

        const items = await store.listRecentMemories({
          groupId: url.searchParams.get("group_id"),
          userId: url.searchParams.get("user_id"),
          messageType: url.searchParams.get("message_type"),
          limit,
        });

        sendJson(res, 200, {
          collection: store.description,
          filters: {
            groupId: url.searchParams.get("group_id"),
            userId: url.searchParams.get("user_id"),
            messageType: url.searchParams.get("message_type"),
            limit,
          },
          items,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/llm/profiles") {
        const catalog = await listLlmProfiles(CONFIG_PATH);
        const current = getActiveLlmClient();
        sendJson(res, 200, {
          active: current.profileName,
          displayName: current.displayName,
          provider: current.provider,
          model: current.model,
          profiles: catalog.profiles,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/llm/active") {
        const data = (await readJsonBody(req)) as {
          profile?: string;
        };

        const profile = (data.profile ?? "").trim();
        if (!profile) {
          sendJson(res, 400, { error: "profile is required" });
          return;
        }

        const nextClient = await switchActiveProfile(profile);
        pushMonitorEntry("status", "Profile Switched", nextClient.displayName);
        sendJson(res, 200, {
          active: nextClient.profileName,
          displayName: nextClient.displayName,
          provider: nextClient.provider,
          model: nextClient.model,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ws/reconnect") {
        connectWebSocketClient(true);
        sendJson(res, 200, { message: `Reconnecting to ${WS_TARGET_URL}` });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/usage/refresh") {
        let usage = getLatestClaudeUsage();
        // User-selected policy: only probe when there is no cached usage yet.
        if (!usage) {
          const current = getActiveLlmClient();
          if (current.provider === "claude") {
            usage = await probeClaudeUsage(current.model);
            const callTokens = consumeLatestCallTokenUsage();
            if (callTokens) {
              recordTokenUsage(callTokens.model, callTokens.inputTokens, callTokens.outputTokens);
            }
            broadcastMonitorEvent({ type: "usage", claudeUsage: usage });
            broadcastMonitorEvent({ type: "tokens", tokenStats: getTodayTokenStats() });
          }
        }
        sendJson(res, 200, { claudeUsage: usage, tokenStats: getTodayTokenStats() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/usage/history") {
        const limitParam = Number(url.searchParams.get("limit") || "60");
        const limit = Number.isFinite(limitParam)
          ? Math.max(1, Math.min(365, Math.floor(limitParam)))
          : 60;
        sendJson(res, 200, getTokenStatsHistory(limit));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/conversations") {
        const groups: Array<{ groupId: string; turnCount: number; lastTurn: ConversationTurn | null }> = [];
        for (const [groupId, turns] of conversationHistoryByGroup.entries()) {
          groups.push({ groupId, turnCount: turns.length, lastTurn: turns.at(-1) ?? null });
        }
        sendJson(res, 200, { groups });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
        const groupId = decodeURIComponent(url.pathname.slice("/api/conversations/".length));
        const turns = conversationHistoryByGroup.get(groupId) ?? [];
        sendJson(res, 200, { groupId, turns });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    console.log(`LLM Chat server is running at http://${HTTP_HOST}:${HTTP_PORT}`);
    console.log(`WebSocket monitor page is available at http://${HTTP_HOST}:${HTTP_PORT}/ws`);
    console.log(`WebSocket client target is ${WS_TARGET_URL}`);
    console.log(`Active LLM profile: ${client.displayName}`);
    if (store) {
      console.log(`Qdrant store: ${store.description}`);
    }
  });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
