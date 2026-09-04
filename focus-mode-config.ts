// The switch that decides which reply pipeline runs.
//
// Two pipelines exist during the migration to the focus model: the original
// per-group one (rebuild the request from that group's timeline, one decision
// per batch) and the focus one (one append-only ledger, the model moves its own
// attention with tools). They are not compatible halfway — the cache lineage,
// the request shape and the responsiveness semantics all differ — so the choice
// is made once, here, rather than being spread across the call sites.
//
// Default off. Turning it on is a config edit and so is rolling it back, which
// is the property that makes it safe to land before it is trusted.

export type FocusModeConfig = {
  enabled: boolean;
  // Ceiling on tool rounds per incoming batch. Each round re-sends the whole
  // ledger, so a runaway costs far more than a runaway single-shot call.
  maxRounds: number;
  // How many recent turns open_conversation renders for a conversation.
  recentTurnsPerConversation: number;
};

export const DEFAULT_FOCUS_MODE_CONFIG: FocusModeConfig = {
  enabled: false,
  maxRounds: 8,
  recentTurnsPerConversation: 30,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function parseFocusModeConfig(value: unknown): FocusModeConfig {
  const record = asRecord(value);
  return {
    enabled: typeof record?.enabled === "boolean" ? record.enabled : DEFAULT_FOCUS_MODE_CONFIG.enabled,
    maxRounds: boundedInteger(record?.max_rounds, DEFAULT_FOCUS_MODE_CONFIG.maxRounds, 1, 30),
    recentTurnsPerConversation: boundedInteger(
      record?.recent_turns_per_conversation,
      DEFAULT_FOCUS_MODE_CONFIG.recentTurnsPerConversation,
      5,
      200,
    ),
  };
}
