import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, type RawData } from "ws";
import {
  createLlmClient,
  listLlmProfiles,
  setActiveLlmProfile,
  type LlmClient,
} from "./llm-client.js";
import {
  createIncomingMessageStore,
  type IncomingMessageRecord,
  type IncomingMessageStore,
  type StoredMemoryRecord,
} from "./qdrant-store.js";

type MonitorEntryKind = "incoming" | "outgoing" | "status" | "error" | "assistant";

type MonitorConnectionState = "connecting" | "open" | "closed" | "error";

type MonitorEntry = {
  id: number;
  kind: MonitorEntryKind;
  title: string;
  body: string;
  timestamp: string;
};

type MonitorStatus = {
  state: MonitorConnectionState;
  detail: string;
  updatedAt: string;
};

type ParsedIncomingMessage = Omit<IncomingMessageRecord, "sequence">;

type ModelRequestContext = {
  groupId: string | null;
  userId: string | null;
  senderName: string | null;
  rawMessage: string | null;
  receivedAt: string;
};

type ModelDecision = {
  shouldReply: boolean;
  finalAnswer: string;
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

type MonitorSnapshot = {
  type: "snapshot";
  target: string;
  status: MonitorStatus;
  history: MonitorEntry[];
};

type MonitorEvent =
  | {
      type: "entry";
      entry: MonitorEntry;
    }
  | {
      type: "status";
      status: MonitorStatus;
    };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = existsSync(join(process.cwd(), "package.json")) ? process.cwd() : __dirname;

const CONFIG_PATH = join(APP_ROOT, "config.yaml");
const LOG_DIR = join(APP_ROOT, "logs");
const HTTP_PORT = 5000;
const HTTP_HOST = "127.0.0.1";
const WS_HOST = "127.0.0.1";
const WS_PORT = 8082;
const WS_TARGET_URL = `ws://${WS_HOST}:${WS_PORT}`;
const WS_RECONNECT_DELAY_MS = 3000;
const WS_HISTORY_LIMIT = 120;
const APP_SESSION_ID = randomUUID();
const APP_SESSION_STARTED_AT = new Date().toISOString();
const REPLY_TARGET_GROUP_ID = 20000002;
const WS_ACTION_TIMEOUT_MS = 10_000;
const MEMORY_LOOKBACK_LIMIT = 8;
const THREAD_CANDIDATE_LIMIT = 24;
const THREAD_TIME_WINDOW_MS = 15 * 60 * 1000;
const THREAD_HARD_CUTOFF_MS = 60 * 60 * 1000;
const THREAD_SCORE_THRESHOLD = 0.42;
const MODEL_DECISION_PROMPT = [
  "You are processing messages from a study group.",
  "Decide whether Holly should reply to the message.",
  "Return JSON only. Do not use markdown fences or extra explanation.",
  "Required JSON shape:",
  '{"should_reply": true, "final_answer": "reply text"}',
  "Rules:",
  "- If the message is unrelated to Holly, not directed at Holly, or does not require Holly to respond, set should_reply to false.",
  '- When should_reply is false, final_answer must be an empty string "".',
  "- final_answer is the text that will be sent to the group if should_reply is true.",
  "- Do not return any reasoning, analysis, or extra fields.",
  "- final_answer must contain only the exact message Holly would send, with no helper prefixes or status markers.",
].join("\n");

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
let pendingWsActions = new Map<string, PendingWsAction>();
let configWatcher: FSWatcher | null = null;
let configReloadTimer: NodeJS.Timeout | null = null;
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
  activeLlmClient = nextClient;
  activeLlmLabel = nextClient.displayName;
  pushMonitorEntry(
    "status",
    "Config Reloaded",
    `${reason}\nActive profile: ${nextClient.profileName}\nModel: ${nextClient.model}`,
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

  if (isBinary) {
    return {
      receivedAt,
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

    if (messageType !== "group") {
      return {
        ...fallback,
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
      messageType,
      groupId,
      groupName,
      userId,
      senderName,
      rawMessage,
      displayText: rawMessage ? `${prefix} ${rawMessage}`.trim() : prefix,
    };
  } catch (error) {
    void error;
    return fallback;
  }
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

function pushMonitorEntry(kind: MonitorEntryKind, title: string, body: string): MonitorEntry {
  const entry: MonitorEntry = {
    id: ++monitorEntryId,
    kind,
    title,
    body,
    timestamp: new Date().toISOString(),
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
  };
}

function formatElapsedDuration(startedAt: number, finishedAt: number): string {
  const elapsedMs = Math.max(0, finishedAt - startedAt);
  return elapsedMs >= 1000
    ? `${(elapsedMs / 1000).toFixed(2)}s`
    : `${elapsedMs}ms`;
}

function buildModelSystemPrompt(basePrompt: string): string {
  return `${basePrompt}\n\n${MODEL_DECISION_PROMPT}`;
}

function formatMemoryLine(record: StoredMemoryRecord): string | null {
  const receivedAt = record.receivedAt ?? "unknown_time";
  const groupName = record.groupName ?? "unknown_group";
  const groupId = record.groupId ?? "unknown_group_id";
  const senderName = record.senderName ?? "unknown_user";
  const userId = record.userId ?? "unknown_user_id";
  const content = record.displayText?.trim() || record.rawMessage?.trim();

  if (!content) {
    return null;
  }

  return `[${receivedAt}] group=${groupName}(${groupId}) sender=${senderName}(${userId}) ${content}`;
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

async function buildMemoryPrompt(context: ModelRequestContext, currentMessage: string): Promise<string> {
  const store = incomingMessageStore;
  if (!store) {
    return "";
  }

  const memories = await store.listRecentMemories({
    groupId: context.groupId,
    limit: THREAD_CANDIDATE_LIMIT + 1,
  });

  const scoredMemories = memories
    .filter((record) => (record.displayText?.trim() || record.rawMessage?.trim()) !== currentMessage.trim())
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
      return line
        ? `${line} [thread_score=${item.score.total.toFixed(2)} sim=${item.score.similarity.toFixed(2)} time=${item.score.time.toFixed(2)} directed=${item.score.directed.toFixed(2)} link=${item.score.participantLink.toFixed(2)} sender=${item.score.sameSender.toFixed(2)}]`
        : null;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return "";
  }

  return [
    "Recent memory for the same conversation thread:",
    `- Retrieval scope: group_id=${context.groupId ?? "null"}, recent_group_messages=${THREAD_CANDIDATE_LIMIT}`,
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

  if (/^(?:\u601d\u8def\u6458\u8981|reasoning_summary|reasoning summary|thought summary)\s*[:\uFF1A]?/i.test(cleaned)) {
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
          /^(?:\u601d\u8def\u6458\u8981|reasoning_summary|reasoning summary|thought summary)\s*[:\uFF1A]?/i.test(line) ||
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

  return {
    shouldReply,
    finalAnswer,
    raw,
  };
}

function formatModelReplyEntry(decision: ModelDecision): string {
  const lines = [
    `should_reply: ${decision.shouldReply}`,
    `final_answer: ${decision.finalAnswer || "(empty)"}`,
  ];

  if (!decision.shouldReply) {
    lines.push("reply_status: skipped");
    lines.push("skip_reason: Model marked the message as unrelated; nothing will be sent.");
  } else if (!decision.finalAnswer) {
    lines.push("reply_status: skipped");
    lines.push("skip_reason: Model chose to reply but final_answer is empty.");
  } else {
    lines.push("reply_status: ready_to_send");
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

async function forwardMessageToModel(message: string, context: ModelRequestContext): Promise<void> {
  const client = getActiveLlmClient();
  const startedAt = Date.now();
  const memoryPrompt = await buildMemoryPrompt(context, message);

  pushMonitorEntry("status", "Model Request", message);
  await appendChatLog("user", message);

  const reply = await client.generateText({
    systemPrompt: [buildModelSystemPrompt(client.systemPrompt), memoryPrompt].filter(Boolean).join("\n\n"),
    messages: [
      { role: "user", content: message },
    ],
  });

  const decision = parseModelDecision(reply);
  const content = formatModelReplyEntry(decision);
  await appendChatLog("assistant", content);
  pushMonitorEntry(
    "assistant",
    `Model Reply - ${formatElapsedDuration(startedAt, Date.now())}`,
    content,
  );

  if (!decision.shouldReply) {
    return;
  }

  if (!decision.finalAnswer) {
    return;
  }

  await sendGroupMessage(REPLY_TARGET_GROUP_ID, decision.finalAnswer);
  pushMonitorEntry(
    "outgoing",
    "Group Message Sent",
    `group_id=${REPLY_TARGET_GROUP_ID}\n${decision.finalAnswer}`,
  );
}

function enqueueMessageForModel(message: string, context: ModelRequestContext): void {
  modelQueue = modelQueue
    .catch(() => {
      // Keep the queue alive after a previous failure.
    })
    .then(async () => {
      await forwardMessageToModel(message, context);
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      pushMonitorEntry("error", "Model Error", detail);
      console.error("Model request failed:", error);
    });
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

  pushMonitorEntry("status", "Reconnect Scheduled", `${reason}\nRetrying in 3 seconds.`);
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
    const message = await enrichMessageWithImageOcr(parsedMessage);
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

    pushMonitorEntry("incoming", "Incoming Message", message.displayText);
    console.log(`WebSocket client received: ${message.displayText}`);

    if (isHollyMessage(message)) {
      pushMonitorEntry("status", "Message Skipped", "Sender is holly; skipping model processing.");
      return;
    }

    enqueueMessageForModel(message.displayText, {
      groupId: message.groupId,
      userId: message.userId,
      senderName: message.senderName,
      rawMessage: message.rawMessage,
      receivedAt: message.receivedAt,
    });
  });

  client.on("close", (code, reasonBuffer) => {
    if (wsClient === client) {
      wsClient = null;
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

const WS_MONITOR_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebSocket Monitor</title>
  <style>
    :root {
      --bg-a: #fdf2f8;
      --bg-b: #ecfeff;
      --panel: rgba(255, 255, 255, 0.88);
      --ink: #172033;
      --muted: #5b6472;
      --line: rgba(148, 163, 184, 0.35);
      --accent: #0f766e;
      --accent-strong: #155e75;
      --entry-in: #ecfeff;
      --entry-out: #ecfdf5;
      --entry-status: #eff6ff;
      --entry-error: #fff1f2;
      --entry-assistant: #f5f3ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(244, 114, 182, 0.18), transparent 30%),
        radial-gradient(circle at top right, rgba(45, 212, 191, 0.20), transparent 28%),
        linear-gradient(135deg, var(--bg-a), var(--bg-b));
      padding: 24px;
    }
    .shell {
      width: min(1100px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      backdrop-filter: blur(10px);
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
    }
    .hero {
      padding: 28px;
    }
    .eyebrow {
      display: inline-block;
      margin-bottom: 10px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #0f766e;
      background: rgba(15, 118, 110, 0.10);
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(30px, 5vw, 52px);
      line-height: 1;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 760px;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.85fr);
      gap: 18px;
    }
    .panel {
      padding: 22px;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .panel-title {
      margin: 0;
      font-size: 20px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      background: #e2e8f0;
      color: #334155;
    }
    .badge[data-state="open"] {
      background: #dcfce7;
      color: #166534;
    }
    .badge[data-state="connecting"] {
      background: #fef3c7;
      color: #92400e;
    }
    .badge[data-state="closed"] {
      background: #e2e8f0;
      color: #334155;
    }
    .badge[data-state="error"] {
      background: #ffe4e6;
      color: #be123c;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
    }
    .socket-url {
      flex: 1 1 280px;
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(248, 250, 252, 0.95);
      border: 1px solid var(--line);
      font-family: Consolas, "Courier New", monospace;
      color: #0f172a;
      word-break: break-all;
    }
    .log {
      min-height: 460px;
      max-height: 70vh;
      overflow-y: auto;
      display: grid;
      gap: 12px;
      padding-right: 4px;
    }
    .entry {
      border-radius: 18px;
      border: 1px solid var(--line);
      padding: 14px 16px;
      background: #fff;
    }
    .entry.incoming { background: var(--entry-in); }
    .entry.outgoing { background: var(--entry-out); }
    .entry.status { background: var(--entry-status); }
    .entry.error { background: var(--entry-error); }
    .entry.assistant { background: var(--entry-assistant); }
    .entry-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .entry pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 1.6;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 18px;
      padding: 22px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.7);
    }
    .hint {
      margin: 0 0 10px;
      color: var(--muted);
      line-height: 1.6;
    }
    select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 12px 14px;
      font: inherit;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.94);
    }
    .stack {
      display: grid;
      gap: 12px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 13px 20px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: white;
      background: var(--accent);
      transition: background 0.2s ease;
    }
    button:hover { background: var(--accent-strong); }
    button.secondary {
      color: var(--ink);
      background: #e2e8f0;
    }
    button.secondary:hover {
      background: #cbd5e1;
    }
    @media (max-width: 900px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .log {
        min-height: 320px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <span class="eyebrow">WebSocket</span>
      <h1>WS To LLM Monitor</h1>
      <p>This page only shows the backend workflow: receive messages from the local 8082 WebSocket, send them to the active LLM, and display the resulting replies and status changes.</p>
    </section>

    <section class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Live Messages</h2>
          <span class="badge" id="status" data-state="connecting">Syncing</span>
        </div>
        <div class="toolbar">
          <div class="socket-url" id="socketUrl"></div>
          <button class="secondary" id="reconnect">Reconnect Client</button>
        </div>
        <p class="hint" id="statusDetail">Waiting for backend updates...</p>
        <div class="log" id="log">
          <div class="empty" id="emptyState">Waiting for WebSocket messages...</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Model Settings</h2>
        </div>
        <div class="stack">
          <p class="hint">Choose which model profile should process incoming WebSocket messages. The switch is applied immediately and written back to <code>config.yaml</code>.</p>
          <select id="profileSelect"></select>
          <button id="applyProfile">Switch Model</button>
          <div class="socket-url" id="profileMeta">Loading model profiles...</div>
        </div>
      </section>
    </section>
  </main>

  <script>
    const statusBadge = document.getElementById("status");
    const statusDetail = document.getElementById("statusDetail");
    const socketUrl = document.getElementById("socketUrl");
    const profileSelect = document.getElementById("profileSelect");
    const profileMeta = document.getElementById("profileMeta");
    const applyProfileButton = document.getElementById("applyProfile");
    const reconnectButton = document.getElementById("reconnect");
    const log = document.getElementById("log");
    const upstreamTarget = ${JSON.stringify(WS_TARGET_URL)};

    let eventSource = null;
    let streamConnected = false;
    let renderedEntryIds = new Set();

    function labelForState(state) {
      if (state === "open") {
        return "Connected";
      }

      if (state === "connecting") {
        return "Connecting";
      }

      if (state === "error") {
        return "Error";
      }

      return "Disconnected";
    }

    function setStatus(status) {
      statusBadge.textContent = labelForState(status.state);
      statusBadge.dataset.state = status.state;
      statusDetail.textContent = status.detail || upstreamTarget;
    }

    function formatBody(body) {
      if (typeof body !== "string") {
        return JSON.stringify(body, null, 2);
      }

      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch (error) {
        void error;
        return body;
      }
    }

    function appendEntry(kind, title, body, timestamp) {
      const placeholder = log.querySelector(".empty");
      if (placeholder) {
        placeholder.remove();
      }

      const entry = document.createElement("article");
      entry.className = "entry " + kind;

      const head = document.createElement("div");
      head.className = "entry-head";

      const heading = document.createElement("span");
      heading.textContent = title;

      const time = document.createElement("span");
      time.textContent = new Date(timestamp || Date.now()).toLocaleTimeString();

      const content = document.createElement("pre");
      content.textContent = formatBody(body);

      head.appendChild(heading);
      head.appendChild(time);
      entry.appendChild(head);
      entry.appendChild(content);
      log.prepend(entry);
      log.scrollTop = 0;
    }

    function renderSnapshot(payload) {
      renderedEntryIds = new Set();
      socketUrl.textContent = payload.target;
      setStatus(payload.status);
      log.innerHTML = "";

      if (!payload.history.length) {
        log.innerHTML = '<div class="empty">Waiting for WebSocket messages...</div>';
        return;
      }

      for (const entry of payload.history) {
        renderEntry(entry);
      }
    }

    function renderEntry(entry) {
      if (renderedEntryIds.has(entry.id)) {
        return;
      }

      renderedEntryIds.add(entry.id);
      appendEntry(entry.kind, entry.title, entry.body, entry.timestamp);
    }

    function handlePayload(payload) {
      if (payload.type === "snapshot") {
        renderSnapshot(payload);
        return;
      }

      if (payload.type === "status") {
        setStatus(payload.status);
        return;
      }

      if (payload.type === "entry") {
        renderEntry(payload.entry);
      }
    }

    function connectEventStream() {
      if (eventSource) {
        eventSource.close();
      }

      socketUrl.textContent = upstreamTarget;
      eventSource = new EventSource("/api/ws/events");

      eventSource.addEventListener("open", () => {
        if (!streamConnected) {
          appendEntry("status", "Monitor Stream", "Connected to backend event stream.", new Date().toISOString());
          streamConnected = true;
        }
      });

      eventSource.addEventListener("snapshot", (event) => {
        const payload = JSON.parse(event.data);
        handlePayload(payload);
      });

      eventSource.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        handlePayload(payload);
      };

      eventSource.onerror = () => {
        if (!streamConnected) {
          return;
        }

        streamConnected = false;
        appendEntry("error", "Monitor Stream", "Lost connection to backend event stream. The browser will retry automatically.", new Date().toISOString());
      };
    }

    async function loadProfiles() {
      const result = await fetch("/api/llm/profiles");
      const data = await result.json();
      if (!result.ok) {
        throw new Error(data.error || "Failed to load profiles");
      }

      profileSelect.innerHTML = "";
      for (const profile of data.profiles) {
        const option = document.createElement("option");
        option.value = profile.name;
        option.textContent = profile.displayName;
        option.selected = profile.name === data.active;
        profileSelect.appendChild(option);
      }

      profileMeta.textContent = "Active model: " + data.displayName;
    }

    async function switchProfile() {
      const profile = profileSelect.value;
      if (!profile) {
        return;
      }

      applyProfileButton.disabled = true;

      try {
        const result = await fetch("/api/llm/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile })
        });

        const data = await result.json();
        if (!result.ok) {
          throw new Error(data.error || "Failed to switch profile");
        }

        profileMeta.textContent = "Active model: " + data.displayName;
        appendEntry("status", "Profile Switched", data.displayName, new Date().toISOString());
      } catch (error) {
        appendEntry("error", "Profile Switch Failed", error.message, new Date().toISOString());
        await loadProfiles().catch(() => {});
      } finally {
        applyProfileButton.disabled = false;
      }
    }

    async function reconnectClient() {
      try {
        const result = await fetch("/api/ws/reconnect", { method: "POST" });
        const data = await result.json();
        if (!result.ok) {
          throw new Error(data.error || "Reconnect failed");
        }

        appendEntry("status", "Reconnect Requested", data.message, new Date().toISOString());
      } catch (error) {
        appendEntry("error", "Reconnect Failed", error.message, new Date().toISOString());
      }
    }

    reconnectButton.addEventListener("click", reconnectClient);
    applyProfileButton.addEventListener("click", switchProfile);

    window.addEventListener("beforeunload", () => {
      if (eventSource) {
        eventSource.close();
      }
    });

    connectEventStream();
    loadProfiles().catch((error) => {
      profileMeta.textContent = "Failed to load profiles: " + error.message;
    });
    socketUrl.textContent = upstreamTarget;
  </script>
</body>
</html>
`;

const MEMORIES_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stored Memories</title>
  <style>
    :root {
      --bg-a: #fff8eb;
      --bg-b: #eef6ff;
      --panel: rgba(255, 255, 255, 0.9);
      --ink: #1f2937;
      --muted: #667085;
      --line: rgba(148, 163, 184, 0.32);
      --accent: #0f766e;
      --accent-strong: #115e59;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 24px;
      font-family: "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(251, 191, 36, 0.18), transparent 28%),
        radial-gradient(circle at top right, rgba(14, 165, 233, 0.14), transparent 30%),
        linear-gradient(135deg, var(--bg-a), var(--bg-b));
    }
    .shell {
      width: min(1180px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      backdrop-filter: blur(10px);
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
    }
    .hero, .panel-body {
      padding: 24px;
    }
    .eyebrow {
      display: inline-block;
      margin-bottom: 10px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #9a3412;
      background: rgba(251, 146, 60, 0.14);
    }
    h1, h2 {
      margin: 0;
    }
    .hero p, .hint {
      margin: 10px 0 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 24px 24px 0;
    }
    .filters {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
      gap: 12px;
      align-items: end;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 14px;
      font: inherit;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.94);
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: white;
      background: var(--accent);
    }
    button:hover { background: var(--accent-strong); }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      margin-top: 16px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      color: var(--muted);
      font-size: 14px;
    }
    .code {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(248, 250, 252, 0.95);
      font-family: Consolas, "Courier New", monospace;
      word-break: break-all;
    }
    .list {
      display: grid;
      gap: 12px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      background: #fff;
    }
    .item-head {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: space-between;
      margin-bottom: 10px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #475467;
    }
    .item-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 1.6;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 18px;
      padding: 22px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.7);
    }
    @media (max-width: 980px) {
      .filters {
        grid-template-columns: 1fr 1fr;
      }
    }
    @media (max-width: 640px) {
      .filters {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <span class="eyebrow">Memories</span>
      <h1>Stored Qdrant Memories</h1>
      <p>Browse the recent records saved from the upstream WebSocket. By default this page shows recent group messages only, so heartbeat and meta events stay out of the way.</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Filters</h2>
      </div>
      <div class="panel-body">
        <form class="filters" id="filters">
          <label>
            Group ID
            <input id="groupId" name="group_id" placeholder="20000001" />
          </label>
          <label>
            User ID
            <input id="userId" name="user_id" placeholder="10000003" />
          </label>
          <label>
            Message Type
            <select id="messageType" name="message_type">
              <option value="group" selected>group</option>
              <option value="">all</option>
            </select>
          </label>
          <label>
            Limit
            <input id="limit" name="limit" type="number" min="1" max="100" value="20" />
          </label>
          <button type="submit">Load</button>
        </form>

        <div class="toolbar">
          <div class="meta">
            <span id="resultCount">0 records</span>
            <span id="collectionName">Loading...</span>
          </div>
          <div class="code" id="apiPath">/api/memories</div>
        </div>
        <p class="hint" id="statusText">Loading memories...</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Results</h2>
      </div>
      <div class="panel-body">
        <div class="list" id="list">
          <div class="empty">Loading memories...</div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const filtersForm = document.getElementById("filters");
    const groupIdInput = document.getElementById("groupId");
    const userIdInput = document.getElementById("userId");
    const messageTypeInput = document.getElementById("messageType");
    const limitInput = document.getElementById("limit");
    const resultCount = document.getElementById("resultCount");
    const collectionName = document.getElementById("collectionName");
    const apiPath = document.getElementById("apiPath");
    const statusText = document.getElementById("statusText");
    const list = document.getElementById("list");

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function buildQuery() {
      const params = new URLSearchParams();
      if (groupIdInput.value.trim()) params.set("group_id", groupIdInput.value.trim());
      if (userIdInput.value.trim()) params.set("user_id", userIdInput.value.trim());
      if (messageTypeInput.value.trim()) params.set("message_type", messageTypeInput.value.trim());
      if (limitInput.value.trim()) params.set("limit", limitInput.value.trim());
      return params;
    }

    function renderItems(items) {
      if (!items.length) {
        list.innerHTML = '<div class="empty">No memories matched the current filters.</div>';
        return;
      }

      list.innerHTML = items.map((item) => {
        const text = item.displayText || item.rawMessage || item.rawContent || "(empty)";
        return [
          '<article class="item">',
          '<div class="item-head">',
          '<span>' + escapeHtml(item.receivedAt || "unknown time") + '</span>',
          '<span>seq ' + escapeHtml(item.sequence ?? "-") + '</span>',
          '</div>',
          '<div class="item-meta">',
          '<span>group: ' + escapeHtml(item.groupName || "-") + ' (' + escapeHtml(item.groupId || "-") + ')</span>',
          '<span>user: ' + escapeHtml(item.senderName || "-") + ' (' + escapeHtml(item.userId || "-") + ')</span>',
          '<span>type: ' + escapeHtml(item.messageType || "-") + '</span>',
          '</div>',
          '<pre>' + escapeHtml(text) + '</pre>',
          '</article>',
        ].join("");
      }).join("");
    }

    async function loadMemories() {
      const query = buildQuery();
      const path = "/api/memories" + (query.toString() ? "?" + query.toString() : "");
      apiPath.textContent = path;
      statusText.textContent = "Loading memories...";

      try {
        const result = await fetch(path);
        const data = await result.json();
        if (!result.ok) {
          throw new Error(data.error || "Failed to load memories");
        }

        resultCount.textContent = data.items.length + " records";
        collectionName.textContent = data.collection || "Qdrant unavailable";
        statusText.textContent = "Showing most recent matching records.";
        renderItems(data.items);
      } catch (error) {
        resultCount.textContent = "0 records";
        collectionName.textContent = "Unavailable";
        statusText.textContent = error.message;
        list.innerHTML = '<div class="empty">Failed to load memories.</div>';
      }
    }

    filtersForm.addEventListener("submit", (event) => {
      event.preventDefault();
      loadMemories();
    });

    loadMemories();
  </script>
</body>
</html>
`;

async function bootstrap(): Promise<void> {
  const requestedProfile = process.env.LLM_PROFILE?.trim() || undefined;
  const client = await createLlmClient(CONFIG_PATH, requestedProfile);
  const store = await createIncomingMessageStore(CONFIG_PATH, {
    sessionId: APP_SESSION_ID,
    sessionStartedAt: APP_SESSION_STARTED_AT,
    wsTargetUrl: WS_TARGET_URL,
  });

  activeLlmClient = client;
  activeLlmLabel = client.displayName;
  incomingMessageStore = store;
  startConfigWatcher();
  if (store) {
    pushMonitorEntry("status", "Qdrant Ready", store.description);
  }

  connectWebSocketClient();

  const server = createServer(async (req, res) => {
    try {
      const url = getRequestUrl(req);

      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, WS_MONITOR_PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/ws") {
        sendHtml(res, WS_MONITOR_PAGE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/memories") {
        sendHtml(res, MEMORIES_PAGE);
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
