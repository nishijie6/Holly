import type {
  ProactiveTickResult,
  ProactiveWorldObservation,
} from "./proactive-engine.js";

export type AutonomyAction =
  | { type: "do_nothing"; reason: string }
  | { type: "observe_world"; topic: string; reason: string; observed: boolean }
  | { type: "send_group_message"; reason: string; actions: ProactiveTickResult["actions"] }
  | { type: "write_memory"; reason: string; content: string };

export type AutonomyConfig = {
  enabled: boolean;
  worldObservationEnabled: boolean;
  worldObservationIntervalMs: number;
  worldObservationRetryMs: number;
  maxWorldObservationsPerDay: number;
  worldTopics: string[];
};

export type AutonomyLoopState = {
  lastWorldObservationAt: number;
  lastWorldObservationAttemptAt: number;
  worldObservationDailyDate: string;
  worldObservationDailyCount: number;
  nextWorldTopicIndex: number;
};

export type AutonomyWorldObservationRequest = {
  topic: string;
  reason: string;
};

export type AutonomyDeps = {
  now: () => number;
  config: AutonomyConfig;
  getState: () => AutonomyLoopState;
  saveState: () => Promise<void>;
  observeWorld: (request: AutonomyWorldObservationRequest) => Promise<ProactiveWorldObservation | null>;
  runGroupProactiveAction: () => Promise<ProactiveTickResult>;
  log: (kind: "status" | "error", title: string, body: string) => void;
  recordWorldObservation: (record: Record<string, unknown>) => void;
};

export type AutonomyLoopResult = {
  action: AutonomyAction;
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
  if (state.worldObservationDailyCount >= cfg.maxWorldObservationsPerDay) return false;
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

export async function runAutonomyLoop(deps: AutonomyDeps): Promise<AutonomyLoopResult> {
  const cfg = deps.config;
  if (!cfg.enabled) {
    return { action: { type: "do_nothing", reason: "autonomy disabled" } };
  }

  const now = deps.now();
  const state = deps.getState();
  rollAutonomyDaily(state, now);

  if (worldObservationDue(cfg, state, now)) {
    const topic = pickWorldTopic(state, cfg.worldTopics);
    if (topic) {
      const reason = "scheduled world observation";
      state.lastWorldObservationAttemptAt = now;
      state.worldObservationDailyCount += 1;
      let observation: ProactiveWorldObservation | null = null;
      try {
        observation = await deps.observeWorld({ topic, reason });
      } catch (error) {
        deps.log("error", "Autonomy observe_world failed", error instanceof Error ? error.message : String(error));
      }
      if (observation) {
        state.lastWorldObservationAt = now;
      }
      await deps.saveState();

      deps.recordWorldObservation({
        ts: new Date(now).toISOString(),
        action: "observe_world",
        topic,
        ok: observation !== null,
        query: observation?.query ?? "",
        urls: observation?.urls ?? [],
        summary: observation?.summary ?? "",
      });
      deps.log(
        "status",
        observation ? "Autonomy observe_world" : "Autonomy observe_world empty",
        `topic=${topic}\nquery=${observation?.query ?? ""}\nsources=${observation?.urls.length ?? 0}`,
      );
      return {
        action: {
          type: "observe_world",
          topic,
          reason,
          observed: observation !== null,
        },
      };
    }
  }

  const groupResult = await deps.runGroupProactiveAction();
  if (groupResult.actions.length > 0) {
    return {
      action: {
        type: "send_group_message",
        reason: "group proactive policy produced an action",
        actions: groupResult.actions,
      },
    };
  }

  return { action: { type: "do_nothing", reason: "no due autonomy action" } };
}
