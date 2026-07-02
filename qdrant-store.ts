import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { QdrantClient } from "@qdrant/js-client-rest";
import YAML from "yaml";

type QdrantConfig = {
  enabled?: boolean;
  url?: string;
  api_key?: string;
  collection?: string;
  timeout_ms?: number;
  on_disk_payload?: boolean;
};

type AppConfig = {
  qdrant?: QdrantConfig;
};

export type IncomingMessageRecord = {
  sequence: number;
  receivedAt: string;
  isBinary: boolean;
  rawEncoding: "utf8" | "base64";
  rawContent: string;
  binarySize: number | null;
  displayText: string | null;
  messageType: string | null;
  groupId: string | null;
  groupName: string | null;
  userId: string | null;
  senderName: string | null;
  rawMessage: string | null;
};

export type IncomingMessageStore = {
  sessionId: string;
  sessionStartedAt: string;
  collectionName: string;
  description: string;
  saveMessage(record: IncomingMessageRecord): Promise<void>;
  saveInternalMemory(record: InternalMemoryRecord): Promise<void>;
  saveWorldObservation(record: WorldObservationMemoryRecord): Promise<void>;
  listRecentMemories(input: {
    groupId?: string | null;
    userId?: string | null;
    messageType?: string | null;
    limit: number;
  }): Promise<StoredMemoryRecord[]>;
};

export type InternalMemoryRecord = {
  receivedAt: string;
  content: string;
  topic?: string | null;
  reason?: string | null;
  urls?: string[];
};

export type WorldObservationMemoryRecord = {
  observedAt: string;
  topic: string;
  query: string;
  summary: string;
  reason?: string | null;
  urls?: string[];
  cached?: boolean;
};

export type StoredMemoryRecord = {
  sessionId: string | null;
  sessionStartedAt: string | null;
  source: string | null;
  sequence: number | null;
  receivedAt: string | null;
  displayText: string | null;
  messageType: string | null;
  groupId: string | null;
  groupName: string | null;
  userId: string | null;
  senderName: string | null;
  rawMessage: string | null;
  memoryTopic: string | null;
  memoryReason: string | null;
  memoryQuery: string | null;
  memoryUrls: string[];
};

type ResolvedQdrantConfig = {
  enabled: boolean;
  url: string;
  apiKey?: string;
  collectionName: string;
  timeoutMs: number;
  onDiskPayload: boolean;
};

const DEFAULT_COLLECTION_NAME = "ws_incoming_messages";
const DEFAULT_TIMEOUT_MS = 10000;
const STORAGE_VECTOR = [0];
const PAYLOAD_INDEXES: Array<{
  fieldName: string;
  fieldSchema: "keyword" | "integer" | "datetime";
}> = [
  { fieldName: "session_id", fieldSchema: "keyword" },
  { fieldName: "received_at", fieldSchema: "datetime" },
  { fieldName: "message_type", fieldSchema: "keyword" },
  { fieldName: "group_id", fieldSchema: "keyword" },
  { fieldName: "user_id", fieldSchema: "keyword" },
  { fieldName: "sequence", fieldSchema: "integer" },
];

async function loadConfig(configPath: string): Promise<AppConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}.`);
  }

  const raw = await readFile(configPath, "utf-8");
  return (YAML.parse(raw) as AppConfig | null) ?? {};
}

async function resolveQdrantConfig(configPath: string): Promise<ResolvedQdrantConfig> {
  const config = await loadConfig(configPath);
  const section = config.qdrant;
  if (!section) {
    throw new Error(`Missing 'qdrant' section in ${configPath}.`);
  }

  const enabled = section.enabled ?? true;
  const url = section.url?.trim();
  if (!url) {
    throw new Error(`Missing 'qdrant.url' in ${configPath}.`);
  }

  const collectionName = section.collection?.trim() || DEFAULT_COLLECTION_NAME;
  const timeoutMs = section.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid 'qdrant.timeout_ms' in ${configPath}.`);
  }

  return {
    enabled,
    url,
    apiKey: section.api_key?.trim() || undefined,
    collectionName,
    timeoutMs,
    onDiskPayload: section.on_disk_payload ?? true,
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStoredMemoryRecord(payload: Record<string, unknown>): StoredMemoryRecord {
  const memoryUrls = Array.isArray(payload.memory_urls)
    ? payload.memory_urls.filter((item): item is string => typeof item === "string")
    : [];
  return {
    sessionId: asOptionalString(payload.session_id),
    sessionStartedAt: asOptionalString(payload.session_started_at),
    source: asOptionalString(payload.source),
    sequence: asOptionalNumber(payload.sequence),
    receivedAt: asOptionalString(payload.received_at),
    displayText: asOptionalString(payload.display_text),
    messageType: asOptionalString(payload.message_type),
    groupId: asOptionalString(payload.group_id),
    groupName: asOptionalString(payload.group_name),
    userId: asOptionalString(payload.user_id),
    senderName: asOptionalString(payload.sender_name),
    rawMessage: asOptionalString(payload.raw_message),
    memoryTopic: asOptionalString(payload.memory_topic),
    memoryReason: asOptionalString(payload.memory_reason),
    memoryQuery: asOptionalString(payload.memory_query),
    memoryUrls,
  };
}

async function ensurePayloadIndexes(client: QdrantClient, collectionName: string): Promise<void> {
  for (const index of PAYLOAD_INDEXES) {
    try {
      await client.createPayloadIndex(collectionName, {
        field_name: index.fieldName,
        field_schema: index.fieldSchema,
        wait: true,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
}

async function ensureCollection(
  client: QdrantClient,
  config: ResolvedQdrantConfig,
): Promise<void> {
  const exists = await client.collectionExists(config.collectionName);
  if (!exists.exists) {
    await client.createCollection(config.collectionName, {
      vectors: {
        size: 1,
        distance: "Dot",
        on_disk: true,
      },
      on_disk_payload: config.onDiskPayload,
    });
  }

  await ensurePayloadIndexes(client, config.collectionName);
}

// A stale undici keep-alive socket against Qdrant surfaces as
// `TypeError: fetch failed` with cause `UND_ERR_SOCKET` / "other side closed":
// the pooled connection was closed by the server (or the local proxy's
// connection tracker) but undici reused it before noticing. One retry runs on a
// fresh connection. Mirrors the existing "retry Codex fetch failures once".
function isTransientConnectionError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === "string" && (e.code === "UND_ERR_SOCKET" || e.code === "ECONNRESET" || e.code === "EPIPE")) {
    return true;
  }
  if (typeof e.message === "string" && /other side closed|socket hang up|ECONNRESET/i.test(e.message)) {
    return true;
  }
  return isTransientConnectionError(e.cause, depth + 1);
}

// A slow Qdrant write can exceed the client timeout even against a local
// instance: a background flush briefly holding a lock, a disk/mmap hiccup, or
// the process stalling for a moment. The per-request AbortController then fires
// and the client throws `QdrantClientTimeoutError` ("This operation was
// aborted"). That stall window is short, so one retry ~150ms later usually
// lands after it has passed. Unlike the connection-reset case this error
// carries no `code`/`cause` (see @qdrant/js-client-rest errors.js CustomError),
// so match it by name; the raw AbortError name is covered too as a safety net.
function isTransientTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "QdrantClientTimeoutError" || name === "AbortError";
}

async function withQdrantRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientConnectionError(error) && !isTransientTimeoutError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return operation();
  }
}

export async function createIncomingMessageStore(
  configPath: string,
  options: {
    sessionId?: string;
    sessionStartedAt?: string;
    wsTargetUrl?: string;
  } = {},
): Promise<IncomingMessageStore | null> {
  const config = await resolveQdrantConfig(configPath);
  if (!config.enabled) {
    return null;
  }

  const client = new QdrantClient({
    url: config.url,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    checkCompatibility: false,
    // Shrink the keep-alive pool: fewer idle sockets to go stale between the
    // bursty incoming messages. This client doesn't expose undici's
    // keepAliveTimeout/pipelining, so withQdrantRetry is the real guard.
    maxConnections: 1,
  });

  try {
    await ensureCollection(client, config);
  } catch (error) {
    throw new Error(
      `Unable to initialize Qdrant store at ${config.url}: ${describeError(error)}. Ensure Qdrant is running and reachable.`,
    );
  }

  const sessionId = options.sessionId?.trim() || randomUUID();
  const sessionStartedAt = options.sessionStartedAt?.trim() || new Date().toISOString();
  const description = `${config.collectionName} @ ${config.url} (session ${sessionId})`;

  return {
    sessionId,
    sessionStartedAt,
    collectionName: config.collectionName,
    description,
    async saveMessage(record): Promise<void> {
      // Generate the point id once, OUTSIDE the retry closure: if withQdrantRetry
      // fires because the first attempt's response was lost after Qdrant already
      // applied the write, reusing the same id makes the retry an idempotent
      // overwrite instead of inserting a duplicate point under a fresh id.
      const pointId = randomUUID();
      await withQdrantRetry(() => client.upsert(config.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: STORAGE_VECTOR,
            payload: {
              schema_version: 1,
              session_id: sessionId,
              session_started_at: sessionStartedAt,
              ws_target_url: options.wsTargetUrl ?? null,
              source: "upstream_ws",
              sequence: record.sequence,
              received_at: record.receivedAt,
              is_binary: record.isBinary,
              raw_encoding: record.rawEncoding,
              raw_content: record.rawContent,
              binary_size: record.binarySize,
              display_text: record.displayText,
              message_type: record.messageType,
              group_id: record.groupId,
              group_name: record.groupName,
              user_id: record.userId,
              sender_name: record.senderName,
              raw_message: record.rawMessage,
            },
          },
        ],
      }));
    },
    async saveInternalMemory(record): Promise<void> {
      // Same idempotency guard as saveMessage: fix the id before the retry closure
      // so a retried write overwrites rather than duplicating.
      const pointId = randomUUID();
      await withQdrantRetry(() => client.upsert(config.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: STORAGE_VECTOR,
            payload: {
              schema_version: 1,
              session_id: sessionId,
              session_started_at: sessionStartedAt,
              ws_target_url: options.wsTargetUrl ?? null,
              source: "holly_internal",
              sequence: null,
              received_at: record.receivedAt,
              is_binary: false,
              raw_encoding: "utf8",
              raw_content: record.content,
              binary_size: null,
              display_text: record.content,
              message_type: "internal_memory",
              group_id: null,
              group_name: null,
              user_id: "holly",
              sender_name: "Holly",
              raw_message: record.content,
              memory_topic: record.topic ?? null,
              memory_reason: record.reason ?? null,
              memory_urls: record.urls ?? [],
            },
          },
        ],
      }));
    },
    async saveWorldObservation(record): Promise<void> {
      const pointId = randomUUID();
      await withQdrantRetry(() => client.upsert(config.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: STORAGE_VECTOR,
            payload: {
              schema_version: 1,
              session_id: sessionId,
              session_started_at: sessionStartedAt,
              ws_target_url: options.wsTargetUrl ?? null,
              source: "holly_world_observation",
              sequence: null,
              received_at: record.observedAt,
              is_binary: false,
              raw_encoding: "utf8",
              raw_content: record.summary,
              binary_size: null,
              display_text: record.summary,
              message_type: "world_observation",
              group_id: null,
              group_name: null,
              user_id: "holly",
              sender_name: "Holly",
              raw_message: record.summary,
              memory_topic: record.topic,
              memory_reason: record.reason ?? null,
              memory_query: record.query,
              memory_urls: record.urls ?? [],
              world_observation_cached: record.cached ?? false,
            },
          },
        ],
      }));
    },
    async listRecentMemories(input): Promise<StoredMemoryRecord[]> {
      const conditions: Array<Record<string, unknown>> = [];
      const groupId = input.groupId?.trim() || null;
      const userId = input.userId?.trim() || null;
      const messageType = input.messageType?.trim() || null;

      if (groupId) {
        conditions.push({
          key: "group_id",
          match: { value: groupId },
        });
      }

      if (userId) {
        conditions.push({
          key: "user_id",
          match: { value: userId },
        });
      }

      if (messageType) {
        conditions.push({
          key: "message_type",
          match: { value: messageType },
        });
      }

      const result = await withQdrantRetry(() => client.scroll(config.collectionName, {
        limit: input.limit,
        with_payload: true,
        with_vector: false,
        order_by: {
          key: "received_at",
          direction: "desc",
        },
        filter: conditions.length > 0 ? { must: conditions } : undefined,
      }));

      return result.points
        .map((point) => {
          const payload = point.payload;
          if (!payload || Array.isArray(payload)) {
            return null;
          }

          return parseStoredMemoryRecord(payload as Record<string, unknown>);
        })
        .filter((record): record is StoredMemoryRecord => record !== null);
    },
  };
}
