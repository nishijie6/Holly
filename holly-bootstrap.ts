export type QqRuntimeMode = "offline" | "observe" | "active";
export type QqModePolicy = "auto" | QqRuntimeMode;

export type HollyBootstrapConfig = {
  enabled: boolean;
  reflectionEnabled: boolean;
  qqModePolicy: QqModePolicy;
  fallbackQqMode: QqRuntimeMode;
  defaultReconsiderMs: number;
  minReconsiderMs: number;
  maxReconsiderMs: number;
};

export type BootOrientation = {
  thought: string;
  shouldWriteMemory: boolean;
  memoryTopic: string;
  memory: string;
  reason: string;
};

export type QqModeDecision = {
  mode: QqRuntimeMode;
  reason: string;
  reconsiderAfterMs: number;
  source: "model" | "policy" | "fallback";
};

export const DEFAULT_HOLLY_BOOTSTRAP_CONFIG: HollyBootstrapConfig = {
  enabled: true,
  reflectionEnabled: true,
  qqModePolicy: "auto",
  fallbackQqMode: "observe",
  defaultReconsiderMs: 60 * 60 * 1000,
  minReconsiderMs: 15 * 60 * 1000,
  maxReconsiderMs: 6 * 60 * 60 * 1000,
};

export const BOOT_ORIENTATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["inner_thought", "should_write_memory", "memory_topic", "memory", "reason"],
  properties: {
    inner_thought: { type: "string" },
    should_write_memory: { type: "boolean" },
    memory_topic: { type: "string" },
    memory: { type: "string" },
    reason: { type: "string" },
  },
};

export const QQ_MODE_DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["qq_mode", "reason", "reconsider_after_minutes"],
  properties: {
    qq_mode: { type: "string", enum: ["offline", "observe", "active"] },
    reason: { type: "string" },
    reconsider_after_minutes: { type: "number" },
  },
};

export const BOOT_ORIENTATION_SYSTEM_PROMPT =
  "You are Holly's private startup orientation loop. Think privately and return structured JSON, never a public chat reply.";

export const QQ_MODE_DECISION_SYSTEM_PROMPT =
  "You decide how Holly should relate to QQ after privately orienting herself at startup. Return structured JSON only.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveMinutes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value * 60 * 1000;
}

function asQqRuntimeMode(value: unknown): QqRuntimeMode | null {
  return value === "offline" || value === "observe" || value === "active" ? value : null;
}

function asQqModePolicy(value: unknown): QqModePolicy | null {
  return value === "auto" ? value : asQqRuntimeMode(value);
}

function unwrapJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function compact(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function parseHollyBootstrapConfig(value: unknown): HollyBootstrapConfig {
  const base = DEFAULT_HOLLY_BOOTSTRAP_CONFIG;
  if (!isRecord(value)) return { ...base };

  const minReconsiderMs = asPositiveMinutes(value.min_reconsider_minutes, base.minReconsiderMs);
  const maxReconsiderMs = Math.max(
    minReconsiderMs,
    asPositiveMinutes(value.max_reconsider_minutes, base.maxReconsiderMs),
  );
  const defaultReconsiderMs = Math.min(
    maxReconsiderMs,
    Math.max(
      minReconsiderMs,
      asPositiveMinutes(value.reconsider_minutes, base.defaultReconsiderMs),
    ),
  );

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : base.enabled,
    reflectionEnabled:
      typeof value.reflection_enabled === "boolean" ? value.reflection_enabled : base.reflectionEnabled,
    qqModePolicy: asQqModePolicy(value.qq_mode) ?? base.qqModePolicy,
    fallbackQqMode: asQqRuntimeMode(value.fallback_qq_mode) ?? base.fallbackQqMode,
    defaultReconsiderMs,
    minReconsiderMs,
    maxReconsiderMs,
  };
}

export function buildBootOrientationPrompt(input: {
  nowIso: string;
  previousBootAtIso: string | null;
  restoredGroups: number;
  restoredTurns: number;
  restoredMemories: number;
  restoredWorldObservations: number;
  material: readonly string[];
}): string {
  return [
    "Holly has just started, before QQ is connected.",
    "Privately orient yourself using the restored memories and recent life material below.",
    "Write one short inner_thought about what feels salient or unfinished right now.",
    "Optionally extract one durable memory only when it is genuinely useful and not a duplicate.",
    "Do not address a user and do not decide the QQ mode in this step.",
    "Return JSON only:",
    '{"inner_thought":"short private thought","should_write_memory":false,"memory_topic":"","memory":"","reason":"short reason"}',
    "",
    `now=${input.nowIso}`,
    `previous_boot_at=${input.previousBootAtIso ?? "unknown"}`,
    `restored_groups=${input.restoredGroups}`,
    `restored_turns=${input.restoredTurns}`,
    `restored_memories=${input.restoredMemories}`,
    `restored_world_observations=${input.restoredWorldObservations}`,
    "",
    input.material.length > 0 ? input.material.join("\n\n") : "(No prior material was restored.)",
  ].join("\n");
}

export function parseBootOrientation(raw: string): BootOrientation | null {
  let value: unknown;
  try {
    value = JSON.parse(unwrapJsonBlock(raw));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const thought = typeof value.inner_thought === "string" ? compact(value.inner_thought, 1200) : "";
  if (!thought) return null;
  const shouldWriteMemory = value.should_write_memory === true;
  const memoryTopic = typeof value.memory_topic === "string" ? compact(value.memory_topic, 120) : "";
  const memory = typeof value.memory === "string" ? compact(value.memory, 1600) : "";
  const reason = typeof value.reason === "string" ? compact(value.reason, 240) : "startup orientation";

  return {
    thought,
    shouldWriteMemory: shouldWriteMemory && Boolean(memoryTopic) && Boolean(memory),
    memoryTopic,
    memory,
    reason,
  };
}

export function buildQqModeDecisionPrompt(input: {
  nowIso: string;
  bootThought: string;
  readOnly: boolean;
  fallbackMode: QqRuntimeMode;
  defaultReconsiderMinutes: number;
  material: readonly string[];
}): string {
  return [
    "Choose Holly's QQ mode for the next part of her life:",
    '- offline: do not connect to QQ and receive no QQ events.',
    '- observe: connect, restore/ingest/persist messages, but never judge, reply, broadcast, or proactively speak.',
    '- active: connect and allow normal replies and proactive participation.',
    "Prefer observe when unsure. Choose offline only when receiving QQ input itself is unwanted.",
    input.readOnly
      ? "Hard constraint: read_only=true, so active is unavailable; choose offline or observe."
      : "read_only=false, so all three modes are available.",
    "Return JSON only:",
    '{"qq_mode":"observe","reason":"short private reason","reconsider_after_minutes":60}',
    "",
    `now=${input.nowIso}`,
    `fallback_mode=${input.fallbackMode}`,
    `default_reconsider_after_minutes=${input.defaultReconsiderMinutes}`,
    `boot_inner_thought=${input.bootThought || "(none)"}`,
    "",
    input.material.length > 0 ? input.material.join("\n\n") : "(No additional material.)",
  ].join("\n");
}

export function forcedQqModeDecision(config: HollyBootstrapConfig): QqModeDecision | null {
  if (!config.enabled) {
    return {
      mode: "active",
      reason: "Holly bootstrap is disabled; preserving the legacy active QQ startup.",
      reconsiderAfterMs: 0,
      source: "policy",
    };
  }
  if (config.qqModePolicy === "auto") return null;
  return {
    mode: config.qqModePolicy,
    reason: `QQ mode is fixed by configuration: ${config.qqModePolicy}.`,
    reconsiderAfterMs: 0,
    source: "policy",
  };
}

export function fallbackQqModeDecision(
  config: HollyBootstrapConfig,
  reason = "QQ mode decision was unavailable; using the configured safe fallback.",
): QqModeDecision {
  return {
    mode: config.fallbackQqMode,
    reason,
    reconsiderAfterMs: config.defaultReconsiderMs,
    source: "fallback",
  };
}

export function parseQqModeDecision(
  raw: string,
  config: HollyBootstrapConfig,
  input: { readOnly: boolean },
): QqModeDecision | null {
  let value: unknown;
  try {
    value = JSON.parse(unwrapJsonBlock(raw));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  let mode = asQqRuntimeMode(value.qq_mode);
  if (!mode) return null;
  const reason = typeof value.reason === "string" ? compact(value.reason, 500) : "";
  if (!reason) return null;
  if (input.readOnly && mode === "active") mode = "observe";

  const requestedMs = asPositiveMinutes(value.reconsider_after_minutes, config.defaultReconsiderMs);
  return {
    mode,
    reason,
    reconsiderAfterMs: Math.min(config.maxReconsiderMs, Math.max(config.minReconsiderMs, requestedMs)),
    source: "model",
  };
}
