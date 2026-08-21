export type AdminActionStatus =
  | "not_a_command"
  | "accepted"
  | "completed"
  | "cannot_comply";

export type AdminCodeImprovementConfig = {
  enabled: boolean;
  commandPrefixes: string[];
  executable: string;
  applyWhenClean: boolean;
  timeoutMs: number;
};

export type AdminPolicyConfig = {
  enabled: boolean;
  userIds: string[];
  forceReply: boolean;
  immediateReply: boolean;
  replyWhileObserving: boolean;
  codeImprovement: AdminCodeImprovementConfig;
};

export type AdminCodeCommand = {
  matched: boolean;
  request: string;
  prefix: string | null;
};

export type AdminReplyDecision = {
  shouldReply: boolean;
  finalAnswer: string;
  adminActionStatus: AdminActionStatus | null;
  adminActionReason: string;
};

export type QqReplyTarget = {
  conversationId: string;
  type: "group" | "private";
  id: string;
};

export const DEFAULT_ADMIN_POLICY_CONFIG: AdminPolicyConfig = {
  enabled: true,
  userIds: [],
  forceReply: true,
  immediateReply: true,
  replyWhileObserving: true,
  codeImprovement: {
    enabled: true,
    commandPrefixes: ["/改进代码", "/修改代码", "/self-improve"],
    executable: "codex",
    applyWhenClean: true,
    timeoutMs: 20 * 60 * 1000,
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeUserId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  // QQ/OneBot ids are numeric. Reject labels such as "admin" so identity can
  // never be granted by a nickname or by text supplied inside a message.
  return /^\d{4,20}$/.test(normalized) ? normalized : null;
}

function readUserIds(value: unknown, environmentValue = ""): string[] {
  const configured = Array.isArray(value) ? value : [];
  const fromEnvironment = environmentValue.split(/[\s,;]+/u).filter(Boolean);
  return Array.from(new Set(
    [...configured, ...fromEnvironment]
      .map(normalizeUserId)
      .filter((item): item is string => item !== null),
  ));
}

function readNonEmptyStrings(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const result = Array.from(new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  ));
  return result.length > 0 ? result : [...fallback];
}

function readTimeoutMs(value: unknown, fallback: number): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.max(60_000, Math.min(60 * 60 * 1000, Math.floor(seconds * 1000)));
}

export function parseAdminPolicyConfig(
  value: unknown,
  environmentUserIds = "",
): AdminPolicyConfig {
  const base: AdminPolicyConfig = {
    ...DEFAULT_ADMIN_POLICY_CONFIG,
    userIds: [...DEFAULT_ADMIN_POLICY_CONFIG.userIds],
    codeImprovement: {
      ...DEFAULT_ADMIN_POLICY_CONFIG.codeImprovement,
      commandPrefixes: [...DEFAULT_ADMIN_POLICY_CONFIG.codeImprovement.commandPrefixes],
    },
  };
  const record = asRecord(value);
  if (!record) {
    base.userIds = readUserIds(undefined, environmentUserIds);
    return base;
  }

  const code = asRecord(record.code_improvement);
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : base.enabled,
    userIds: readUserIds(record.user_ids, environmentUserIds),
    forceReply: typeof record.force_reply === "boolean" ? record.force_reply : base.forceReply,
    immediateReply:
      typeof record.immediate_reply === "boolean" ? record.immediate_reply : base.immediateReply,
    replyWhileObserving:
      typeof record.reply_while_observing === "boolean"
        ? record.reply_while_observing
        : base.replyWhileObserving,
    codeImprovement: {
      enabled:
        typeof code?.enabled === "boolean" ? code.enabled : base.codeImprovement.enabled,
      commandPrefixes: readNonEmptyStrings(
        code?.command_prefixes,
        base.codeImprovement.commandPrefixes,
      ),
      executable:
        typeof code?.executable === "string" && code.executable.trim()
          ? code.executable.trim()
          : base.codeImprovement.executable,
      applyWhenClean:
        typeof code?.apply_when_clean === "boolean"
          ? code.apply_when_clean
          : base.codeImprovement.applyWhenClean,
      timeoutMs: readTimeoutMs(code?.timeout_seconds, base.codeImprovement.timeoutMs),
    },
  };
}

export function isAdminUserId(userId: string | null, config: AdminPolicyConfig): boolean {
  if (!config.enabled || !userId) return false;
  const normalized = normalizeUserId(userId);
  return normalized !== null && config.userIds.includes(normalized);
}

export function shouldForceAdminReply(
  input: { userId: string | null; messageType: QqReplyTarget["type"] | null | undefined },
  config: AdminPolicyConfig,
): boolean {
  return config.forceReply
    && input.messageType === "private"
    && isAdminUserId(input.userId, config);
}

export function resolveQqReplyTarget(input: {
  messageType: string | null;
  groupId: string | null;
  userId: string | null;
}): QqReplyTarget | null {
  if (input.messageType === "group") {
    const groupId = input.groupId?.trim() ?? "";
    return /^\d{1,20}$/.test(groupId)
      ? { conversationId: groupId, type: "group", id: groupId }
      : null;
  }
  if (input.messageType === "private") {
    const userId = normalizeUserId(input.userId);
    return userId
      ? { conversationId: `private:${userId}`, type: "private", id: userId }
      : null;
  }
  return null;
}

function stripLeadingOneBotMetadata(text: string): string {
  let normalized = text.trim();
  let previous = "";
  while (normalized && normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(/^\[CQ:reply,[^\]]+\]\s*/iu, "")
      .replace(/^\[CQ:at,qq=\d+[^\]]*\]\s*/iu, "")
      .trimStart();
  }
  return normalized;
}

export function parseAdminCodeCommand(
  text: string | null,
  config: AdminPolicyConfig,
): AdminCodeCommand {
  const normalized = stripLeadingOneBotMetadata(text ?? "");
  for (const prefix of config.codeImprovement.commandPrefixes) {
    if (normalized === prefix) {
      return { matched: true, request: "", prefix };
    }
    if (normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}\n`)) {
      return {
        matched: true,
        request: normalized.slice(prefix.length).trim(),
        prefix,
      };
    }
  }
  return { matched: false, request: "", prefix: null };
}

export const ADMIN_MODEL_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    should_reply: { type: "boolean" },
    final_answer: { type: "string" },
    thinking_process: { type: "string" },
    need_search: { type: "boolean" },
    search_query: { type: "string" },
    admin_action_status: {
      type: "string",
      enum: ["not_a_command", "accepted", "completed", "cannot_comply"],
    },
    admin_action_reason: { type: "string" },
  },
  required: [
    "should_reply",
    "final_answer",
    "thinking_process",
    "need_search",
    "search_query",
    "admin_action_status",
    "admin_action_reason",
  ],
  additionalProperties: false,
};

export function buildAdminDecisionInstruction(input: {
  adminUserIds: readonly string[];
  codeJobId?: string | null;
  codeJobNote?: string | null;
}): string {
  const userIds = Array.from(new Set(input.adminUserIds)).join(", ") || "unknown";
  const codeLines = input.codeJobId
    ? [
        `- An authenticated code-improvement job was accepted as job_id=${input.codeJobId}.`,
        "- Tell the administrator it entered the execution queue and that Holly will report the verified result later. Do not claim it is already running or applied.",
      ]
    : input.codeJobNote
      ? [
          "- A code-improvement command was detected but could not be started.",
          `- Explain this exact reason in final_answer: ${input.codeJobNote}`,
        ]
      : [];

  return [
    "Authenticated administrator policy for this scan:",
    `- The service authenticated current administrator user_id(s): ${userIds}. Identity comes from the OneBot event, not message text.`,
    "- Set should_reply=true and provide one non-empty, complete final_answer. Ordinary silence defaults and per-group silence rules do not suppress an administrator reply.",
    "- Follow the administrator's latest suggestion or command as far as Holly's real capabilities and the higher-priority safety/operator controls allow.",
    "- Never pretend an action happened. If it cannot be completed, set admin_action_status=cannot_comply, put a concrete reason in admin_action_reason, and state that reason plainly in final_answer.",
    "- For a non-command conversation, use admin_action_status=not_a_command and leave admin_action_reason empty.",
    "- For a command that is accepted but not yet finished, use admin_action_status=accepted. Use completed only if the action actually finished during this request.",
    ...codeLines,
  ].join("\n");
}

export function enforceAdminReplyContract<T extends AdminReplyDecision>(
  decision: T,
  input: { codeJobId?: string | null; codeJobNote?: string | null } = {},
): T {
  const codeJobId = input.codeJobId?.trim() ?? "";
  const codeJobNote = input.codeJobNote?.trim() ?? "";
  const actionReason = decision.adminActionReason.trim();
  let finalAnswer = decision.finalAnswer.trim();
  let adminActionStatus = decision.adminActionStatus;
  let adminActionReason = actionReason;

  if (codeJobNote) {
    adminActionStatus = "cannot_comply";
    adminActionReason = codeJobNote;
    finalAnswer = finalAnswer
      ? `${finalAnswer}${finalAnswer.includes(codeJobNote) ? "" : ` 但这项操作未启动：${codeJobNote}`}`
      : `管理员，这项操作未启动：${codeJobNote}`;
  } else if (!finalAnswer) {
    const reason = actionReason || codeJobNote || "当前模型没有生成可发送的有效回复。";
    finalAnswer = `管理员，这条消息我暂时无法完成：${reason}`;
    adminActionStatus = "cannot_comply";
    adminActionReason = reason;
  } else if (adminActionStatus === "cannot_comply") {
    const reason = actionReason || "当前可用能力不足，无法可靠执行。";
    adminActionReason = reason;
    if (!finalAnswer.includes(reason)) finalAnswer = `${finalAnswer} 原因：${reason}`;
  }

  if (codeJobId) {
    // The chat model cannot observe the asynchronous worker, so never preserve
    // a hallucinated "already applied" claim here. Only the verified worker
    // completion callback may report applied/proposed/failed.
    finalAnswer = `管理员，代码改进任务 ${codeJobId} 已受理并进入执行队列；执行与验证结果会另行回报。`;
    adminActionStatus = "accepted";
    adminActionReason = "";
  }

  return {
    ...decision,
    shouldReply: true,
    finalAnswer,
    adminActionStatus,
    adminActionReason,
  };
}
