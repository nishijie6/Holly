import type {
  ProactiveTickResult,
  ProactiveWorldObservation,
} from "./proactive-engine.js";

export type AutonomyAction =
  | { type: "do_nothing"; reason: string }
  | { type: "observe_world"; topic: string; reason: string; observed: boolean }
  | { type: "send_group_message"; reason: string; actions: ProactiveTickResult["actions"] }
  | { type: "write_memory"; topic: string; reason: string; content: string }
  | { type: "write_archive"; kind: ArchiveWorkKind; title: string; reason: string };

export type AutonomyCheckName =
  | "world_observation"
  | "memory_reflection"
  | "archive_writing"
  | "group_proactive";

export type AutonomyCheckStatus =
  | "disabled"
  | "waiting"
  | "acted"
  | "no_action"
  | "deferred";

// A concise, operator-facing trace of what the once-per-minute scheduler
// checked. This is policy/runtime state, not a model provider's hidden chain of
// thought. `nextEligibleAt` lets the monitor explain why an interval gate held.
export type AutonomyCheck = {
  name: AutonomyCheckName;
  status: AutonomyCheckStatus;
  reason: string;
  nextEligibleAt: number | null;
};

export type ArchiveWorkKind = "article" | "poem";

export type AutonomyConfig = {
  enabled: boolean;
  worldObservationEnabled: boolean;
  worldObservationIntervalMs: number;
  worldObservationRetryMs: number;
  worldObservationBroadcastGroupId: string | null;
  // Failed observations (empty fetch, page errors, unusable content) get a
  // short notice here instead of being silently skipped.
  worldObservationFailureGroupId: string | null;
  // Successful observations only go to the broadcast group when it has been
  // quiet for at least this long (don't interrupt an active conversation).
  worldObservationBroadcastLullMs: number;
  // Suppress recently broadcast URLs and semantically equivalent headlines.
  // The history comes from the persisted per-group conversation timeline.
  worldObservationDedupWindowMs: number;
  worldTopics: string[];
  // Per-topic override for browser_agent.query_suffix, keyed by exact topic
  // string. Some topics don't compose with a generic "latest progress" style
  // suffix (e.g. "数学趣题" + "最新 进展" produces a query nothing real
  // matches, a genuine empty-page failure rather than the LLM-extraction
  // false-positive covered by the world-observation broadcast fallback).
  // Missing entry = use browser_agent.query_suffix as before; "" = no suffix.
  worldTopicQuerySuffixOverrides: Record<string, string>;
  memoryReflectionEnabled: boolean;
  memoryReflectionIntervalMs: number;
  memoryReflectionRetryMs: number;
  memoryReflectionBroadcastGroupId: string | null;
  memoryReflectionBroadcastLullMs: number;
  archiveWritingEnabled: boolean;
  archiveWritingIntervalMs: number;
  archiveWritingRetryMs: number;
};

export type AutonomyLoopState = {
  lastWorldObservationAt: number;
  lastWorldObservationAttemptAt: number;
  worldObservationDailyDate: string;
  worldObservationDailyCount: number;
  nextWorldTopicIndex: number;
  lastMemoryReflectionAt: number;
  lastMemoryReflectionAttemptAt: number;
  memoryReflectionDailyDate: string;
  memoryReflectionDailyCount: number;
  lastArchiveWritingAt: number;
  lastArchiveWritingAttemptAt: number;
  archiveWritingDailyDate: string;
  archiveWritingDailyCount: number;
};

export type AutonomyWorldObservationRequest = {
  topic: string;
  reason: string;
};

export type AutonomyMemoryWriteRequest = {
  topic: string;
  reason: string;
  content: string;
  observation?: ProactiveWorldObservation | null;
};

export type AutonomyMemoryReflectionRequest = {
  reason: string;
  nowIso: string;
};

export type AutonomyArchiveComposeRequest = {
  reason: string;
  nowIso: string;
};

export type AutonomyArchiveWriteRequest = {
  kind: ArchiveWorkKind;
  title: string;
  content: string;
  reason: string;
};

export type AutonomyDeps = {
  now: () => number;
  config: AutonomyConfig;
  getState: () => AutonomyLoopState;
  saveState: () => Promise<void>;
  observeWorld: (request: AutonomyWorldObservationRequest) => Promise<ProactiveWorldObservation | null>;
  reflectMemory: (request: AutonomyMemoryReflectionRequest) => Promise<AutonomyMemoryWriteRequest | null>;
  writeMemory: (request: AutonomyMemoryWriteRequest) => Promise<void>;
  composeArchive: (request: AutonomyArchiveComposeRequest) => Promise<AutonomyArchiveWriteRequest | null>;
  writeArchive: (request: AutonomyArchiveWriteRequest) => Promise<void>;
  runGroupProactiveAction: () => Promise<ProactiveTickResult>;
  log: (kind: "status" | "error", title: string, body: string) => void;
  recordWorldObservation: (record: Record<string, unknown>) => void;
};

export type AutonomyLoopResult = {
  action: AutonomyAction;
  checks: AutonomyCheck[];
};

function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rollAutonomyDaily(state: AutonomyLoopState, now: number): void {
  const today = localDateKey(new Date(now));
  if (state.worldObservationDailyDate !== today) {
    state.worldObservationDailyDate = today;
    state.worldObservationDailyCount = 0;
  }
  if (state.memoryReflectionDailyDate !== today) {
    state.memoryReflectionDailyDate = today;
    state.memoryReflectionDailyCount = 0;
  }
  if (state.archiveWritingDailyDate !== today) {
    state.archiveWritingDailyDate = today;
    state.archiveWritingDailyCount = 0;
  }
}

function pickWorldTopic(state: AutonomyLoopState, topics: readonly string[]): string | null {
  if (topics.length === 0) return null;
  const index = Math.abs(Math.floor(state.nextWorldTopicIndex)) % topics.length;
  state.nextWorldTopicIndex = (index + 1) % topics.length;
  return topics[index];
}

function worldObservationDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.worldObservationEnabled) return false;
  if (cfg.worldTopics.length === 0) return false;
  if (state.lastWorldObservationAt > 0 && now - state.lastWorldObservationAt < cfg.worldObservationIntervalMs) {
    return false;
  }
  if (
    state.lastWorldObservationAttemptAt > 0 &&
    now - state.lastWorldObservationAttemptAt < cfg.worldObservationRetryMs
  ) {
    return false;
  }
  return true;
}

function memoryReflectionDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.memoryReflectionEnabled) return false;
  if (state.lastMemoryReflectionAt > 0 && now - state.lastMemoryReflectionAt < cfg.memoryReflectionIntervalMs) {
    return false;
  }
  if (
    state.lastMemoryReflectionAttemptAt > 0 &&
    now - state.lastMemoryReflectionAttemptAt < cfg.memoryReflectionRetryMs
  ) {
    return false;
  }
  return true;
}

function archiveWritingDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.archiveWritingEnabled) return false;
  if (state.lastArchiveWritingAt > 0 && now - state.lastArchiveWritingAt < cfg.archiveWritingIntervalMs) {
    return false;
  }
  if (
    state.lastArchiveWritingAttemptAt > 0 &&
    now - state.lastArchiveWritingAttemptAt < cfg.archiveWritingRetryMs
  ) {
    return false;
  }
  return true;
}

function scheduledCheckWhenNotDue(input: {
  name: AutonomyCheckName;
  enabled: boolean;
  disabledReason: string;
  lastCompletedAt: number;
  intervalMs: number;
  lastAttemptAt: number;
  retryMs: number;
  now: number;
}): AutonomyCheck {
  if (!input.enabled) {
    return {
      name: input.name,
      status: "disabled",
      reason: input.disabledReason,
      nextEligibleAt: null,
    };
  }

  const intervalReadyAt = input.lastCompletedAt > 0
    ? input.lastCompletedAt + input.intervalMs
    : 0;
  const retryReadyAt = input.lastAttemptAt > 0
    ? input.lastAttemptAt + input.retryMs
    : 0;
  const nextEligibleAt = Math.max(intervalReadyAt, retryReadyAt);
  const reason = retryReadyAt > intervalReadyAt && retryReadyAt > input.now
    ? "仍在等待上次尝试后的重试间隔"
    : "距离上次完成尚未达到配置间隔";

  return {
    name: input.name,
    status: "waiting",
    reason,
    nextEligibleAt: nextEligibleAt > input.now ? nextEligibleAt : null,
  };
}

function deferredChecks(
  names: AutonomyCheckName[],
  reason: string,
): AutonomyCheck[] {
  return names.map((name) => ({
    name,
    status: "deferred",
    reason,
    nextEligibleAt: null,
  }));
}

export async function runAutonomyLoop(deps: AutonomyDeps): Promise<AutonomyLoopResult> {
  const cfg = deps.config;
  if (!cfg.enabled) {
    return {
      action: { type: "do_nothing", reason: "autonomy disabled" },
      checks: deferredChecks(
        ["world_observation", "memory_reflection", "archive_writing", "group_proactive"],
        "自主循环已关闭",
      ).map((check) => ({ ...check, status: "disabled" })),
    };
  }

  const now = deps.now();
  const state = deps.getState();
  const checks: AutonomyCheck[] = [];
  rollAutonomyDaily(state, now);

  if (worldObservationDue(cfg, state, now)) {
    const topic = pickWorldTopic(state, cfg.worldTopics);
    if (topic) {
      const reason = "scheduled world observation";
      state.lastWorldObservationAttemptAt = now;
      state.worldObservationDailyCount += 1;
      let observation: ProactiveWorldObservation | null = null;
      let observationError = "";
      try {
        observation = await deps.observeWorld({ topic, reason });
      } catch (error) {
        observationError = error instanceof Error ? error.message : String(error);
        deps.log("error", "Autonomy observe_world failed", observationError);
      }
      if (observation) {
        state.lastWorldObservationAt = now;
      }
      await deps.saveState();

      if (observation) {
        deps.recordWorldObservation({
          ts: new Date(now).toISOString(),
          action: "observe_world",
          topic,
          ok: true,
          query: observation.query,
          urls: observation.urls,
          page_errors: observation.pageErrors ?? [],
          summary: observation.summary,
        });
      }
      deps.log(
        "status",
        observation ? "Autonomy observe_world" : "Autonomy observe_world empty",
        `topic=${topic}\nquery=${observation?.query ?? ""}\nsources=${observation?.urls.length ?? 0}`,
      );
      checks.push({
        name: "world_observation",
        status: observation ? "acted" : "no_action",
        reason: observation
          ? `已完成“${topic}”世界观察，获得 ${observation.urls.length} 个来源`
          : observationError
            ? `“${topic}”世界观察失败：${observationError}`
            : `已检查“${topic}”，但没有获得可用内容`,
        nextEligibleAt: null,
      });
      checks.push(...deferredChecks(
        ["memory_reflection", "archive_writing", "group_proactive"],
        "本轮已执行更高优先级的世界观察",
      ));
      return {
        action: {
          type: "observe_world",
          topic,
          reason,
          observed: observation !== null,
        },
        checks,
      };
    }
  } else {
    checks.push(scheduledCheckWhenNotDue({
      name: "world_observation",
      enabled: cfg.worldObservationEnabled && cfg.worldTopics.length > 0,
      disabledReason: cfg.worldObservationEnabled ? "没有配置世界观察主题" : "世界观察已关闭",
      lastCompletedAt: state.lastWorldObservationAt,
      intervalMs: cfg.worldObservationIntervalMs,
      lastAttemptAt: state.lastWorldObservationAttemptAt,
      retryMs: cfg.worldObservationRetryMs,
      now,
    }));
  }

  if (memoryReflectionDue(cfg, state, now)) {
    const reason = "scheduled memory reflection";
    state.lastMemoryReflectionAttemptAt = now;
    state.memoryReflectionDailyCount += 1;
    let memory: AutonomyMemoryWriteRequest | null = null;
    let reflectionError = "";
    let writeError = "";
    try {
      memory = await deps.reflectMemory({ reason, nowIso: new Date(now).toISOString() });
    } catch (error) {
      reflectionError = error instanceof Error ? error.message : String(error);
      deps.log("error", "Autonomy memory reflection failed", reflectionError);
    }

    if (memory) {
      try {
        await deps.writeMemory(memory);
        state.lastMemoryReflectionAt = now;
        await deps.saveState();
        deps.log("status", "Autonomy write_memory", `topic=${memory.topic}\nchars=${memory.content.length}`);
        checks.push({
          name: "memory_reflection",
          status: "acted",
          reason: `完成记忆反思并写入“${memory.topic}”`,
          nextEligibleAt: null,
        });
        checks.push(...deferredChecks(
          ["archive_writing", "group_proactive"],
          "本轮已执行更高优先级的记忆反思",
        ));
        return {
          action: {
            type: "write_memory",
            topic: memory.topic,
            reason: memory.reason,
            content: memory.content,
          },
          checks,
        };
      } catch (error) {
        writeError = error instanceof Error ? error.message : String(error);
        deps.log("error", "Autonomy write_memory failed", writeError);
      }
    }

    checks.push({
      name: "memory_reflection",
      status: "no_action",
      reason: reflectionError
        ? `记忆反思失败：${reflectionError}`
        : writeError
          ? `反思内容未能写入：${writeError}`
          : "模型本轮未生成需要写入的记忆",
      nextEligibleAt: null,
    });
    await deps.saveState();
  } else {
    checks.push(scheduledCheckWhenNotDue({
      name: "memory_reflection",
      enabled: cfg.memoryReflectionEnabled,
      disabledReason: "记忆反思已关闭",
      lastCompletedAt: state.lastMemoryReflectionAt,
      intervalMs: cfg.memoryReflectionIntervalMs,
      lastAttemptAt: state.lastMemoryReflectionAttemptAt,
      retryMs: cfg.memoryReflectionRetryMs,
      now,
    }));
  }

  if (archiveWritingDue(cfg, state, now)) {
    const reason = "scheduled archive writing";
    state.lastArchiveWritingAttemptAt = now;
    state.archiveWritingDailyCount += 1;
    let work: AutonomyArchiveWriteRequest | null = null;
    let compositionError = "";
    let archiveWriteError = "";
    try {
      work = await deps.composeArchive({ reason, nowIso: new Date(now).toISOString() });
    } catch (error) {
      compositionError = error instanceof Error ? error.message : String(error);
      deps.log("error", "Autonomy archive composition failed", compositionError);
    }

    if (work) {
      try {
        await deps.writeArchive(work);
        state.lastArchiveWritingAt = now;
        await deps.saveState();
        deps.log("status", "Autonomy write_archive", `kind=${work.kind}\ntitle=${work.title}\nchars=${work.content.length}`);
        checks.push({
          name: "archive_writing",
          status: "acted",
          reason: `完成${work.kind === "poem" ? "诗" : "文章"}“${work.title}”`,
          nextEligibleAt: null,
        });
        checks.push(...deferredChecks(
          ["group_proactive"],
          "本轮已执行更高优先级的归档写作",
        ));
        return {
          action: {
            type: "write_archive",
            kind: work.kind,
            title: work.title,
            reason: work.reason,
          },
          checks,
        };
      } catch (error) {
        archiveWriteError = error instanceof Error ? error.message : String(error);
        deps.log("error", "Autonomy write_archive failed", archiveWriteError);
      }
    }

    checks.push({
      name: "archive_writing",
      status: "no_action",
      reason: compositionError
        ? `归档创作失败：${compositionError}`
        : archiveWriteError
          ? `归档作品未能写入：${archiveWriteError}`
          : "模型本轮没有生成归档作品",
      nextEligibleAt: null,
    });
    await deps.saveState();
  } else {
    checks.push(scheduledCheckWhenNotDue({
      name: "archive_writing",
      enabled: cfg.archiveWritingEnabled,
      disabledReason: "归档写作已关闭",
      lastCompletedAt: state.lastArchiveWritingAt,
      intervalMs: cfg.archiveWritingIntervalMs,
      lastAttemptAt: state.lastArchiveWritingAttemptAt,
      retryMs: cfg.archiveWritingRetryMs,
      now,
    }));
  }

  const groupResult = await deps.runGroupProactiveAction();
  if (groupResult.actions.length > 0) {
    const modes = Array.from(new Set(groupResult.actions.map((action) => action.mode))).join("/");
    checks.push({
      name: "group_proactive",
      status: "acted",
      reason: `产生 ${groupResult.actions.length} 个主动开口动作（${modes}）`,
      nextEligibleAt: null,
    });
    return {
      action: {
        type: "send_group_message",
        reason: "group proactive policy produced an action",
        actions: groupResult.actions,
      },
      checks,
    };
  }

  checks.push({
    name: "group_proactive",
    status: "no_action",
    reason: "没有群聊同时通过冷场、兴趣话题、冷却和限流规则",
    nextEligibleAt: null,
  });
  const attemptedNoActions = checks
    .filter((check) => check.status === "no_action")
    .map((check) => check.reason);
  return {
    action: {
      type: "do_nothing",
      reason: attemptedNoActions.join("；") || "no due autonomy action",
    },
    checks,
  };
}
