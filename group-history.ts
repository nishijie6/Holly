import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

type WsActionResponse = {
  status?: string;
  retcode?: number;
  data?: unknown;
  message?: string;
  wording?: string;
};

type GroupHistoryMessage = Record<string, unknown>;

const DEFAULT_WS_URL = "ws://127.0.0.1:8082";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 80;
const ACTION_TIMEOUT_MS = 10_000;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLocalDayRange(date = new Date()): { startSeconds: number; endSeconds: number } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    startSeconds: Math.floor(start.getTime() / 1000),
    endSeconds: Math.floor(end.getTime() / 1000),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getMessageTimestamp(message: GroupHistoryMessage): number | null {
  const candidates = [
    message.time,
    message.message_time,
    message.msgTime,
    message.timestamp,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate > 10_000_000_000 ? Math.floor(candidate / 1000) : candidate;
    }
    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
      }
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return Math.floor(parsed / 1000);
      }
    }
  }

  return null;
}

function getMessageSequence(message: GroupHistoryMessage): string | null {
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

function extractMessages(response: WsActionResponse): GroupHistoryMessage[] {
  const data = asObject(response.data);
  const messages = data?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map(asObject)
    .filter((message): message is GroupHistoryMessage => message !== null);
}

function formatSender(message: GroupHistoryMessage): string {
  const sender = asObject(message.sender);
  const nickname = sender?.nickname ?? sender?.card ?? message.nickname ?? message.senderName;
  const userId = sender?.user_id ?? sender?.uin ?? message.user_id;

  const nameText = typeof nickname === "string" && nickname.trim() ? nickname.trim() : "unknown";
  const idText = typeof userId === "string" || typeof userId === "number" ? String(userId) : "unknown";
  return `${nameText}(${idText})`;
}

function extractTextFromSegments(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((segment) => {
      const item = asObject(segment);
      const data = asObject(item?.data);
      if (item?.type === "text" && typeof data?.text === "string") {
        return data.text;
      }
      if (typeof item?.type === "string") {
        return `[${item.type}]`;
      }
      return "";
    })
    .join("")
    .trim();
}

function formatMessageContent(message: GroupHistoryMessage): string {
  const rawMessage = message.raw_message ?? message.message ?? message.content;
  if (typeof rawMessage === "string") {
    return rawMessage.trim();
  }

  const segmentText = extractTextFromSegments(rawMessage);
  if (segmentText) {
    return segmentText;
  }

  return JSON.stringify(rawMessage ?? message);
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-CN", {
    hour12: false,
  });
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out connecting to ${url}.`));
    }, ACTION_TIMEOUT_MS);

    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sendWsAction(
  ws: WebSocket,
  action: string,
  params: Record<string, unknown>,
): Promise<WsActionResponse> {
  const echo = `${action}:${randomUUID()}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${action} response.`));
    }, ACTION_TIMEOUT_MS);

    const onMessage = (data: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf-8") : String(data));
      } catch {
        return;
      }

      const payload = asObject(parsed);
      if (!payload || payload.echo !== echo) {
        return;
      }

      clearTimeout(timer);
      ws.off("message", onMessage);

      const response = payload as WsActionResponse;
      if (response.status === "ok" && response.retcode === 0) {
        resolve(response);
        return;
      }

      reject(new Error(`${action} failed: ${JSON.stringify(response)}`));
    };

    ws.on("message", onMessage);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

async function listGroupMessagesForToday(
  ws: WebSocket,
  groupId: string,
  limit: number,
): Promise<GroupHistoryMessage[]> {
  const { startSeconds, endSeconds } = getLocalDayRange();
  const seenKeys = new Set<string>();
  const matches: GroupHistoryMessage[] = [];
  let messageSeq = "0";
  let reachedOlderMessages = false;

  for (let page = 0; page < DEFAULT_MAX_PAGES && !reachedOlderMessages; page += 1) {
    const response = await sendWsAction(ws, "get_group_msg_history", {
      group_id: groupId,
      message_seq: messageSeq,
      count: DEFAULT_PAGE_SIZE,
      reverse_order: true,
      reverseOrder: true,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: false,
    });

    const messages = extractMessages(response);
    if (messages.length === 0) {
      break;
    }

    let oldestTimestamp: number | null = null;
    let oldestSequence: string | null = null;
    for (const message of messages) {
      const timestamp = getMessageTimestamp(message);
      const sequence = getMessageSequence(message);
      if (timestamp !== null && (oldestTimestamp === null || timestamp < oldestTimestamp)) {
        oldestTimestamp = timestamp;
        oldestSequence = sequence;
      }

      const dedupeKey = sequence ?? JSON.stringify(message);
      if (seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);

      if (timestamp !== null && timestamp >= startSeconds && timestamp < endSeconds) {
        matches.push(message);
      }
    }

    if (oldestTimestamp !== null && oldestTimestamp < startSeconds) {
      reachedOlderMessages = true;
    }

    if (!oldestSequence || oldestSequence === messageSeq) {
      break;
    }
    messageSeq = oldestSequence;

    matches.sort((left, right) => (getMessageTimestamp(left) ?? 0) - (getMessageTimestamp(right) ?? 0));
    if (matches.length >= limit && oldestTimestamp !== null && oldestTimestamp < startSeconds) {
      break;
    }
  }

  return matches
    .sort((left, right) => (getMessageTimestamp(left) ?? 0) - (getMessageTimestamp(right) ?? 0))
    .slice(0, limit);
}

async function main(): Promise<void> {
  const groupId = process.argv[2]?.trim();
  if (!groupId) {
    throw new Error("Usage: tsx group-history.ts <group_id> [limit] [ws_url]");
  }

  const limit = parsePositiveInteger(process.argv[3], 5);
  const wsUrl = process.argv[4]?.trim() || process.env.NAPCAT_WS_URL?.trim() || DEFAULT_WS_URL;
  const ws = await connectWebSocket(wsUrl);

  try {
    const messages = await listGroupMessagesForToday(ws, groupId, limit);
    console.log(`${groupId} 群今天最早的 ${messages.length} 条消息:`);
    for (const [index, message] of messages.entries()) {
      const timestamp = getMessageTimestamp(message);
      const sequence = getMessageSequence(message) ?? "unknown_seq";
      const timeText = timestamp === null ? "unknown_time" : formatTime(timestamp);
      console.log(`${index + 1}. [${timeText}] seq=${sequence} ${formatSender(message)}: ${formatMessageContent(message)}`);
    }
  } finally {
    ws.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
