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
  pageErrors?: string[];
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
  worldObservationPageErrors: string[];
};

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseStoredMemoryRecord(payload: Record<string, unknown>): StoredMemoryRecord {
  const memoryUrls = Array.isArray(payload.memory_urls)
    ? payload.memory_urls.filter((item): item is string => typeof item === "string")
    : [];
  const worldObservationPageErrors = Array.isArray(payload.world_observation_page_errors)
    ? payload.world_observation_page_errors.filter((item): item is string => typeof item === "string")
    : [];
  const canonicalContent = asOptionalString(payload.content);
  return {
    sessionId: asOptionalString(payload.session_id),
    sessionStartedAt: asOptionalString(payload.session_started_at),
    source: asOptionalString(payload.source),
    sequence: asOptionalNumber(payload.sequence),
    receivedAt: asOptionalString(payload.received_at),
    displayText: asOptionalString(payload.display_text) ?? canonicalContent,
    messageType: asOptionalString(payload.message_type),
    groupId: asOptionalString(payload.group_id),
    groupName: asOptionalString(payload.group_name),
    userId: asOptionalString(payload.user_id),
    senderName: asOptionalString(payload.sender_name),
    rawMessage: asOptionalString(payload.raw_message) ?? canonicalContent,
    memoryTopic: asOptionalString(payload.memory_topic),
    memoryReason: asOptionalString(payload.memory_reason),
    memoryQuery: asOptionalString(payload.memory_query),
    memoryUrls,
    worldObservationPageErrors,
  };
}

export function isNapCatHeartbeat(
  record: Pick<IncomingMessageRecord, "isBinary" | "rawEncoding" | "rawContent">,
): boolean {
  if (record.isBinary || record.rawEncoding !== "utf8") return false;
  try {
    const parsed = JSON.parse(record.rawContent) as Record<string, unknown> | null;
    return parsed?.post_type === "meta_event" && parsed.meta_event_type === "heartbeat";
  } catch {
    return false;
  }
}
