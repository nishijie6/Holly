import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import YAML from "yaml";

import {
  isNapCatHeartbeat,
  parseStoredMemoryRecord,
  type IncomingMessageStore,
  type StoredMemoryRecord,
} from "./memory-store-types.js";

type SqliteConfig = {
  url?: string;
  timeout_ms?: number;
};

type AppConfig = {
  database?: SqliteConfig;
};

type ResolvedSqliteConfig = {
  databasePath: string;
  displayUrl: string;
  timeoutMs: number;
};

export type SqlitePayloadRepository = {
  databasePath: string;
  insertPayload(id: string, payload: Record<string, unknown>): boolean;
  count(): number;
  close(): void;
};

const DEFAULT_DATABASE_URL = "file:./data/sqlite/holly.db";
const DEFAULT_TIMEOUT_MS = 5000;

async function resolveSqliteConfig(configPath: string): Promise<ResolvedSqliteConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}.`);
  }

  const config = ((YAML.parse(await readFile(configPath, "utf8")) as AppConfig | null) ?? {});
  const section = config.database ?? {};
  const displayUrl = section.url?.trim() || DEFAULT_DATABASE_URL;
  const timeoutMs = section.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid 'database.timeout_ms' in ${configPath}.`);
  }

  if (displayUrl === ":memory:" || displayUrl === "file::memory:") {
    return { databasePath: ":memory:", displayUrl, timeoutMs };
  }

  const rawPath = displayUrl.startsWith("file:") ? displayUrl.slice("file:".length) : displayUrl;
  if (!rawPath.trim()) {
    throw new Error(`Missing 'database.url' path in ${configPath}.`);
  }
  const databasePath = isAbsolute(rawPath)
    ? rawPath
    : resolve(dirname(configPath), rawPath);
  return { databasePath, displayUrl, timeoutMs };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function initializeSchema(database: DatabaseSync, timeoutMs: number): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${Math.floor(timeoutMs)};
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      message_type TEXT,
      group_id TEXT,
      user_id TEXT,
      payload_json TEXT NOT NULL,
      inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS memory_records_received_at_idx
      ON memory_records(received_at DESC);
    CREATE INDEX IF NOT EXISTS memory_records_group_received_idx
      ON memory_records(group_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS memory_records_user_received_idx
      ON memory_records(user_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS memory_records_type_received_idx
      ON memory_records(message_type, received_at DESC);
  `);
}

export async function openSqlitePayloadRepository(
  configPath: string,
): Promise<SqlitePayloadRepository> {
  const config = await resolveSqliteConfig(configPath);
  if (config.databasePath !== ":memory:") {
    await mkdir(dirname(config.databasePath), { recursive: true });
  }

  const database = new DatabaseSync(config.databasePath);
  initializeSchema(database, config.timeoutMs);
  const insertStatement = database.prepare(`
    INSERT OR IGNORE INTO memory_records (
      id, received_at, message_type, group_id, user_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const countStatement = database.prepare("SELECT COUNT(*) AS count FROM memory_records");

  return {
    databasePath: config.databasePath,
    insertPayload(id, payload): boolean {
      const receivedAt = stringOrNull(payload.received_at) ?? new Date().toISOString();
      const result = insertStatement.run(
        id,
        receivedAt,
        stringOrNull(payload.message_type),
        stringOrNull(payload.group_id),
        stringOrNull(payload.user_id),
        JSON.stringify(payload),
      );
      return Number(result.changes) > 0;
    },
    count(): number {
      const row = countStatement.get() as { count: number };
      return Number(row.count);
    },
    close(): void {
      database.close();
    },
  };
}

export async function createSqliteIncomingMessageStore(
  configPath: string,
  options: {
    sessionId?: string;
    sessionStartedAt?: string;
    wsTargetUrl?: string;
  } = {},
): Promise<IncomingMessageStore> {
  const config = await resolveSqliteConfig(configPath);
  if (config.databasePath !== ":memory:") {
    await mkdir(dirname(config.databasePath), { recursive: true });
  }

  const database = new DatabaseSync(config.databasePath);
  initializeSchema(database, config.timeoutMs);
  const insertStatement = database.prepare(`
    INSERT INTO memory_records (
      id, received_at, message_type, group_id, user_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const sessionId = options.sessionId?.trim() || randomUUID();
  const sessionStartedAt = options.sessionStartedAt?.trim() || new Date().toISOString();

  const savePayload = (payload: Record<string, unknown>): void => {
    const receivedAt = stringOrNull(payload.received_at) ?? new Date().toISOString();
    insertStatement.run(
      randomUUID(),
      receivedAt,
      stringOrNull(payload.message_type),
      stringOrNull(payload.group_id),
      stringOrNull(payload.user_id),
      JSON.stringify(payload),
    );
  };

  return {
    sessionId,
    sessionStartedAt,
    collectionName: "memory_records",
    description: `memory_records @ ${config.displayUrl} (session ${sessionId})`,
    async saveMessage(record): Promise<void> {
      if (isNapCatHeartbeat(record)) return;
      savePayload({
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
      });
    },
    async saveInternalMemory(record): Promise<void> {
      savePayload({
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
      });
    },
    async saveWorldObservation(record): Promise<void> {
      savePayload({
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
      });
    },
    async listRecentMemories(input): Promise<StoredMemoryRecord[]> {
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      const filters = [
        ["group_id", input.groupId],
        ["user_id", input.userId],
        ["message_type", input.messageType],
      ] as const;
      for (const [column, rawValue] of filters) {
        const value = rawValue?.trim();
        if (!value) continue;
        conditions.push(`${column} = ?`);
        parameters.push(value);
      }
      const limit = Math.max(0, Math.floor(input.limit));
      if (limit === 0) return [];
      parameters.push(limit);
      const statement = database.prepare(`
        SELECT payload_json
        FROM memory_records
        ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY received_at DESC, rowid DESC
        LIMIT ?
      `);
      const rows = statement.all(...parameters) as Array<{ payload_json: string }>;
      return rows.map((row) => {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        return parseStoredMemoryRecord(payload);
      });
    },
  };
}
