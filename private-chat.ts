export type PrivateChatConfig = {
  enabled: boolean;
  friendsOnly: boolean;
  historyMessageCount: number;
  friendRefreshIntervalMs: number;
  botUserId: string | null;
};

export const DEFAULT_PRIVATE_CHAT_CONFIG: PrivateChatConfig = {
  enabled: true,
  friendsOnly: true,
  historyMessageCount: 40,
  friendRefreshIntervalMs: 5 * 60 * 1000,
  botUserId: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeOneBotUserId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  const normalized = String(value).trim();
  return /^\d{4,20}$/.test(normalized) ? normalized : null;
}

function readBoundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

export function parsePrivateChatConfig(
  value: unknown,
  environmentBotUserId = "",
): PrivateChatConfig {
  const record = asRecord(value);
  const refreshMinutes = readBoundedPositiveInteger(
    record?.friend_refresh_minutes,
    DEFAULT_PRIVATE_CHAT_CONFIG.friendRefreshIntervalMs / 60_000,
    24 * 60,
  );
  return {
    enabled:
      typeof record?.enabled === "boolean"
        ? record.enabled
        : DEFAULT_PRIVATE_CHAT_CONFIG.enabled,
    friendsOnly:
      typeof record?.friends_only === "boolean"
        ? record.friends_only
        : DEFAULT_PRIVATE_CHAT_CONFIG.friendsOnly,
    historyMessageCount: readBoundedPositiveInteger(
      record?.history_message_count,
      DEFAULT_PRIVATE_CHAT_CONFIG.historyMessageCount,
      200,
    ),
    friendRefreshIntervalMs: refreshMinutes * 60_000,
    botUserId:
      normalizeOneBotUserId(record?.bot_user_id)
      ?? normalizeOneBotUserId(environmentBotUserId),
  };
}

/**
 * NapCat 的 get_friend_list 通常把好友数组直接放在 data；兼容少数包装成
 * data.friends 的实现。只提取数值 QQ 号，其他字段留给调用方按需处理。
 */
export function extractFriendUserIds(response: Record<string, unknown>): Set<string> {
  const data = response.data;
  const wrapped = asRecord(data);
  const candidates = Array.isArray(data)
    ? data
    : Array.isArray(wrapped?.friends)
      ? wrapped.friends
      : [];
  const result = new Set<string>();
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    const userId = normalizeOneBotUserId(record?.user_id ?? record?.userId ?? record?.uin);
    if (userId) result.add(userId);
  }
  return result;
}

export function isPrivateConversationKey(value: string | null | undefined): boolean {
  return typeof value === "string" && /^private:\d{4,20}$/.test(value);
}

export function formatConversationKey(value: string): string {
  return isPrivateConversationKey(value)
    ? `私聊${value.slice("private:".length)}`
    : `群${value}`;
}
