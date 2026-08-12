import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { QdrantClient } from "@qdrant/js-client-rest";
import YAML from "yaml";

import {
  isNapCatHeartbeat,
  parseStoredMemoryRecord,
  type IncomingMessageRecord,
  type IncomingMessageStore,
  type InternalMemoryRecord,
  type StoredMemoryRecord,
  type WorldObservationMemoryRecord,
} from "./memory-store-types.js";
import { DurableOutbox } from "./qdrant-outbox.js";

export {
  isNapCatHeartbeat,
  parseStoredMemoryRecord,
  type IncomingMessageRecord,
  type IncomingMessageStore,
  type InternalMemoryRecord,
  type StoredMemoryRecord,
  type WorldObservationMemoryRecord,
} from "./memory-store-types.js";

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

type ResolvedQdrantConfig = {
  enabled: boolean;
  url: string;
  apiKey?: string;
  collectionName: string;
  timeoutMs: number;
  onDiskPayload: boolean;
};

type PersistedQdrantPoint = {
  id: string;
  vector: Record<string, never>;
  payload: Record<string, unknown>;
};

const DEFAULT_COLLECTION_NAME = "ws_incoming_messages";
const DEFAULT_TIMEOUT_MS = 10000;
const OUTBOX_REPLAY_INTERVAL_MS = 60_000;
// This collection is currently used as an ordered/filterable document store,
// not for nearest-neighbour search. Qdrant accepts points with no vectors; the
// empty vector map avoids allocating a meaningless `[0]` dense vector per row
// while keeping the existing collection compatible with future real vectors.
const NO_STORAGE_VECTOR: Record<string, never> = {};
const PAYLOAD_INDEXES: Array<{
  fieldName: string;
  fieldSchema: "keyword" | "integer" | "datetime";
}> = [
  { fieldName: "received_at", fieldSchema: "datetime" },
  { fieldName: "message_type", fieldSchema: "keyword" },
  { fieldName: "group_id", fieldSchema: "keyword" },
  { fieldName: "user_id", fieldSchema: "keyword" },
];

const STORED_MEMORY_PAYLOAD_FIELDS = [
  "content",
  "session_id",
  "session_started_at",
  "source",
  "sequence",
  "received_at",
  "display_text",
  "message_type",
  "group_id",
  "group_name",
  "user_id",
  "sender_name",
  "raw_message",
  "memory_topic",
  "memory_reason",
  "memory_query",
  "memory_urls",
  "world_observation_page_errors",
] as const;

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
    // config.yaml is committed, so the cluster key must NOT live there. Prefer
    // QDRANT_API_KEY from the environment (like SERPER_API_KEY); fall back to the
    // config value only for a purely local, keyless instance.
    apiKey: process.env.QDRANT_API_KEY?.trim() || section.api_key?.trim() || undefined,
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

async function ensurePayloadIndexes(client: QdrantClient, collectionName: string): Promise<void> {
  const info = await client.getCollection(collectionName);
  const existingIndexes = new Set(Object.keys(info.payload_schema ?? {}));
  for (const index of PAYLOAD_INDEXES) {
    if (existingIndexes.has(index.fieldName)) continue;
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
// connection tracker) but undici reused it before noticing. The same fetch
// failure can also show up as a hung connect/headers/body phase instead of an
// outright reset — confirmed on this network, where the proxy path to the
// Cloud cluster intermittently stalls for seconds rather than closing —
// which undici reports as UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT /
// UND_ERR_BODY_TIMEOUT. Retries run on a fresh connection each time.
function isTransientConnectionError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const e = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const transientCodes = new Set([
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "ETIMEDOUT",
  ]);
  if (typeof e.code === "string" && transientCodes.has(e.code)) return true;
  if (
    typeof e.name === "string" &&
    (e.name === "ConnectTimeoutError" || e.name === "HeadersTimeoutError" || e.name === "BodyTimeoutError")
  ) {
    return true;
  }
  if (typeof e.message === "string" && /other side closed|socket hang up|ECONNRESET|connect timeout/i.test(e.message)) {
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

// Direct (non-proxied) connections to a Cloud cluster are intermittently RST
// mid-handshake on this network — a single request can succeed or fail on any
// given try, seemingly at random, and the bad stretches can run a few seconds
// (not just one dropped socket). `ensureCollection` alone is ~7 sequential
// requests, so even a low per-request failure rate makes a short retry budget
// land on a bad connection often. Retry with backoff long enough to ride out
// a multi-second blip.
const QDRANT_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 4000];

async function withQdrantRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= QDRANT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error) && !isTransientTimeoutError(error)) throw error;
      if (attempt === QDRANT_RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, QDRANT_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

export async function copyQdrantPayloads(
  configPath: string,
  writeBatch: (
    records: ReadonlyArray<{ id: string; payload: Record<string, unknown> }>,
  ) => Promise<void> | void,
): Promise<number> {
  const config = await resolveQdrantConfig(configPath);
  const client = new QdrantClient({
    url: config.url,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    checkCompatibility: false,
    maxConnections: 1,
  });
  let offset: string | number | Record<string, unknown> | undefined;
  let copied = 0;

  do {
    const result = await withQdrantRetry(() => client.scroll(config.collectionName, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: false,
    }));
    const records = result.points.flatMap((point) => {
      if (!point.payload || Array.isArray(point.payload)) return [];
      return [{
        id: String(point.id),
        payload: point.payload as Record<string, unknown>,
      }];
    });
    await writeBatch(records);
    copied += records.length;
    offset = result.next_page_offset ?? undefined;
  } while (offset !== undefined && offset !== null);

  return copied;
}

// Pull an HTTP status off the error (or its nested response/cause) so a rejected
// key (401/403) can be told apart from a network failure.
function statusFromError(error: unknown, depth = 0): number | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const e = error as { status?: unknown; statusCode?: unknown; response?: unknown; cause?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  const resp = e.response as { status?: unknown } | undefined;
  if (resp && typeof resp.status === "number") return resp.status;
  return statusFromError(e.cause, depth + 1);
}

// Flatten the error's code + message across the cause chain into one string so a
// single regex can classify the failure. Also exported for monitor logging: the
// top-level `error.message` on a `TypeError: fetch failed` is just that literal
// string, and the actual reason (ECONNRESET, a timeout code, ...) lives in
// `error.cause`, which this walks.
export function describeErrorChain(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 5) {
    return error === undefined || error === null ? "" : String(error);
  }
  const e = error as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof e.code === "string") parts.push(e.code);
  if (typeof e.name === "string") parts.push(e.name);
  if (typeof e.message === "string") parts.push(e.message);
  const causeText = describeErrorChain(e.cause, depth + 1);
  if (causeText) parts.push(causeText);
  return parts.join(" | ");
}

// Turn a startup connection failure into an actionable message that names the
// likely config culprit — auth (key) vs network/proxy vs address — instead of
// the old generic "Ensure Qdrant is running", which is useless once the store is
// a remote cloud cluster reached through a proxy.
function diagnoseQdrantStartupError(error: unknown, config: ResolvedQdrantConfig): string {
  const base = `Unable to initialize Qdrant store at ${config.url}: ${describeError(error)}.`;
  const status = statusFromError(error);
  const chain = describeErrorChain(error);
  if (status === 401 || status === 403 || /\b(401|403)\b|unauthorized|forbidden|invalid api|api[- ]?key/i.test(chain)) {
    return `${base} Authentication rejected — check the QDRANT_API_KEY env var (or qdrant.api_key) and that the key has access to this cluster.`;
  }
  if (
    isTransientTimeoutError(error) ||
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR|other side closed|socket hang up|fetch failed|aborted|timeout/i.test(chain)
  ) {
    return `${base} Cannot reach the cluster — check fetch.proxy_url is reachable, NODE_USE_ENV_PROXY is set, and the URL/port are right (Qdrant Cloud REST is usually :6333; the proxy must allow CONNECT to that port).`;
  }
  return `${base} Check qdrant.url points at the cluster's REST endpoint.`;
}

export async function createQdrantIncomingMessageStore(
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

  const outbox = new DurableOutbox<PersistedQdrantPoint>(
    join(dirname(configPath), "logs", "qdrant-outbox"),
  );

  const flushOutbox = (): Promise<number> => outbox.drain(async (points) => {
    await withQdrantRetry(() => client.upsert(config.collectionName, {
      wait: true,
      points: [...points],
    }));
  });

  try {
    // A remote cloud cluster reached through a proxy is more prone to a
    // transient socket drop on the first call, so use the runtime retry budget.
    await withQdrantRetry(() => ensureCollection(client, config));
    await flushOutbox();
  } catch (error) {
    if (isTransientConnectionError(error) || isTransientTimeoutError(error)) {
      // Local logs remain the source of truth while Qdrant is unavailable.
      // Writes below are journaled before delivery and the replay loop retries,
      // so a temporary cloud outage must not prevent Holly from starting.
      console.error(`Qdrant unavailable at startup; continuing with durable outbox: ${describeErrorChain(error)}`);
    } else {
      throw new Error(diagnoseQdrantStartupError(error, config));
    }
  }

  const sessionId = options.sessionId?.trim() || randomUUID();
  const sessionStartedAt = options.sessionStartedAt?.trim() || new Date().toISOString();
  const description = `${config.collectionName} @ ${config.url} (session ${sessionId})`;

  const persistPoint = async (point: PersistedQdrantPoint): Promise<void> => {
    await outbox.enqueue(point, point.id);
    await flushOutbox();
  };

  const scheduleOutboxReplay = (): void => {
    const timer = setTimeout(() => {
      void outbox.pendingCount()
        .then(async (pending) => {
          if (pending === 0) return 0;
          // Startup may have happened while the cluster was unreachable. Ensure
          // collection/schema readiness before attempting the retained batch.
          await withQdrantRetry(() => ensureCollection(client, config));
          return flushOutbox();
        })
        .then((delivered) => {
          if (delivered > 0) {
            console.log(`Replayed ${delivered} pending Qdrant outbox record(s).`);
          }
        })
        .catch((error) => {
          // Keep the records on disk and try again on the next interval. This is
          // deliberately non-fatal: a cloud outage must not take down Holly.
          console.error(`Qdrant outbox replay failed; records remain pending: ${describeErrorChain(error)}`);
        })
        .finally(scheduleOutboxReplay);
    }, OUTBOX_REPLAY_INTERVAL_MS);
    timer.unref();
  };
  scheduleOutboxReplay();

  return {
    sessionId,
    sessionStartedAt,
    collectionName: config.collectionName,
    description,
    async saveMessage(record): Promise<void> {
      // NapCat emits a heartbeat roughly every 30 seconds. It has no message
      // content and is never read back by Holly, so do not turn transport
      // liveness noise into the overwhelming majority of database rows.
      if (isNapCatHeartbeat(record)) return;

      // Generate the point id once, OUTSIDE the retry closure: if withQdrantRetry
      // fires because the first attempt's response was lost after Qdrant already
      // applied the write, reusing the same id makes the retry an idempotent
      // overwrite instead of inserting a duplicate point under a fresh id.
      const pointId = randomUUID();
      await persistPoint({
        id: pointId,
        vector: NO_STORAGE_VECTOR,
        payload: {
          schema_version: 2,
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
      });
    },
    async saveInternalMemory(record): Promise<void> {
      // Same idempotency guard as saveMessage: fix the id before the retry closure
      // so a retried write overwrites rather than duplicating.
      const pointId = randomUUID();
      await persistPoint({
        id: pointId,
        vector: NO_STORAGE_VECTOR,
        payload: {
          schema_version: 2,
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          source: "holly_internal",
          received_at: record.receivedAt,
          content: record.content,
          message_type: "internal_memory",
          user_id: "holly",
          sender_name: "Holly",
          memory_topic: record.topic ?? null,
          memory_reason: record.reason ?? null,
          memory_urls: record.urls ?? [],
        },
      });
    },
    async saveWorldObservation(record): Promise<void> {
      const pointId = randomUUID();
      await persistPoint({
        id: pointId,
        vector: NO_STORAGE_VECTOR,
        payload: {
          schema_version: 2,
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          source: "holly_world_observation",
          received_at: record.observedAt,
          content: record.summary,
          message_type: "world_observation",
          user_id: "holly",
          sender_name: "Holly",
          memory_topic: record.topic,
          memory_reason: record.reason ?? null,
          memory_query: record.query,
          memory_urls: record.urls ?? [],
          world_observation_page_errors: record.pageErrors ?? [],
          world_observation_cached: record.cached ?? false,
        },
      });
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
        with_payload: { include: [...STORED_MEMORY_PAYLOAD_FIELDS] },
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
