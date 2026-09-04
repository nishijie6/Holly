// Persistent self-state for proactive Holly (slice 1).
//
// State machine (per group):
//
//   每个 tick:
//     rollDaily()                      // 跨天重置 dailyCount / globalDailyCount
//     settle pendingObservation        // 观察窗到点 → 成功(退避恢复)或被无视(backoff++)
//     gate(...) 通过 → 记一次主动 + 开新 pendingObservation
//
// 持久化:原子写(temp + rename),损坏 JSON → 默认值不崩(codex 硬化项)。
// 所有写都串行在 saveQueue 上,避免 tick 与异步模型完成交错写。

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { QqRuntimeMode } from "./holly-bootstrap.js";

export type PendingObservation = {
  sentAt: number; // ms epoch
  threadKey: string;
};

export type HollyAutonomyState = {
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

export type HollyLifecycleState = {
  bootCount: number;
  lastBootStartedAt: number;
  lastBootCompletedAt: number;
  lastBootThoughtAt: number;
  lastBootThought: string;
  qqMode: QqRuntimeMode;
  qqModeReason: string;
  qqModeDecidedAt: number;
  qqModeReconsiderAt: number;
  // The conversation Holly is currently looking at, or "" for none. One value,
  // not one per group: this is where attention is, and attention is singular.
  //
  // Persisted so focus survives a restart (kagami keeps currentConversationId
  // across blur for the same reason). The matching "is the app in the
  // foreground" flag is deliberately NOT persisted — it gates whether a send
  // target is exposed at all, and a stale true after a crash would let a reply
  // go somewhere nobody asked for.
  currentConversationId: string;
  currentConversationOpenedAt: number;
};

export type HollyGroupState = {
  lastProactiveAt: number; // ms epoch, 0 = never
  backoffLevel: number; // 0..n,温和退避:有效阈值 ×(multiplier ^ level)
  dailyDate: string; // 本地日期键 YYYY-MM-DD
  dailyCount: number;
  // threadKey -> engagedAt(ms)。带 TTL,过期后同主题可重新触发(codex:别永久压制)。
  engagedThreads: Record<string, number>;
  pendingObservation: PendingObservation | null;
};

export type HollyStatePersisted = {
  version: 1;
  globalDailyDate: string;
  globalDailyCount: number;
  autonomy: HollyAutonomyState;
  lifecycle: HollyLifecycleState;
  groups: Record<string, HollyGroupState>;
};

export function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function freshGroupState(dateKey: string): HollyGroupState {
  return {
    lastProactiveAt: 0,
    backoffLevel: 0,
    dailyDate: dateKey,
    dailyCount: 0,
    engagedThreads: {},
    pendingObservation: null,
  };
}

function freshAutonomyState(dateKey: string): HollyAutonomyState {
  return {
    lastWorldObservationAt: 0,
    lastWorldObservationAttemptAt: 0,
    worldObservationDailyDate: dateKey,
    worldObservationDailyCount: 0,
    nextWorldTopicIndex: 0,
    lastMemoryReflectionAt: 0,
    lastMemoryReflectionAttemptAt: 0,
    memoryReflectionDailyDate: dateKey,
    memoryReflectionDailyCount: 0,
    lastArchiveWritingAt: 0,
    lastArchiveWritingAttemptAt: 0,
    archiveWritingDailyDate: dateKey,
    archiveWritingDailyCount: 0,
  };
}

function freshLifecycleState(): HollyLifecycleState {
  return {
    bootCount: 0,
    lastBootStartedAt: 0,
    lastBootCompletedAt: 0,
    lastBootThoughtAt: 0,
    lastBootThought: "",
    qqMode: "offline",
    qqModeReason: "",
    qqModeDecidedAt: 0,
    qqModeReconsiderAt: 0,
    currentConversationId: "",
    currentConversationOpenedAt: 0,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceAutonomyState(value: unknown, dateKey: string): HollyAutonomyState {
  const base = freshAutonomyState(dateKey);
  if (!value || typeof value !== "object") {
    return base;
  }
  const v = value as Record<string, unknown>;
  return {
    lastWorldObservationAt: isFiniteNumber(v.lastWorldObservationAt) ? v.lastWorldObservationAt : 0,
    lastWorldObservationAttemptAt: isFiniteNumber(v.lastWorldObservationAttemptAt)
      ? v.lastWorldObservationAttemptAt
      : 0,
    worldObservationDailyDate:
      typeof v.worldObservationDailyDate === "string" ? v.worldObservationDailyDate : dateKey,
    worldObservationDailyCount: isFiniteNumber(v.worldObservationDailyCount)
      ? Math.max(0, Math.floor(v.worldObservationDailyCount))
      : 0,
    nextWorldTopicIndex: isFiniteNumber(v.nextWorldTopicIndex)
      ? Math.max(0, Math.floor(v.nextWorldTopicIndex))
      : 0,
    lastMemoryReflectionAt: isFiniteNumber(v.lastMemoryReflectionAt) ? v.lastMemoryReflectionAt : 0,
    lastMemoryReflectionAttemptAt: isFiniteNumber(v.lastMemoryReflectionAttemptAt)
      ? v.lastMemoryReflectionAttemptAt
      : 0,
    memoryReflectionDailyDate:
      typeof v.memoryReflectionDailyDate === "string" ? v.memoryReflectionDailyDate : dateKey,
    memoryReflectionDailyCount: isFiniteNumber(v.memoryReflectionDailyCount)
      ? Math.max(0, Math.floor(v.memoryReflectionDailyCount))
      : 0,
    lastArchiveWritingAt: isFiniteNumber(v.lastArchiveWritingAt) ? v.lastArchiveWritingAt : 0,
    lastArchiveWritingAttemptAt: isFiniteNumber(v.lastArchiveWritingAttemptAt)
      ? v.lastArchiveWritingAttemptAt
      : 0,
    archiveWritingDailyDate:
      typeof v.archiveWritingDailyDate === "string" ? v.archiveWritingDailyDate : dateKey,
    archiveWritingDailyCount: isFiniteNumber(v.archiveWritingDailyCount)
      ? Math.max(0, Math.floor(v.archiveWritingDailyCount))
      : 0,
  };
}

function coerceQqMode(value: unknown): QqRuntimeMode {
  return value === "offline" || value === "observe" || value === "active" ? value : "offline";
}

function coerceLifecycleState(value: unknown): HollyLifecycleState {
  if (!value || typeof value !== "object") {
    return freshLifecycleState();
  }
  const v = value as Record<string, unknown>;
  return {
    bootCount: isFiniteNumber(v.bootCount) ? Math.max(0, Math.floor(v.bootCount)) : 0,
    lastBootStartedAt: isFiniteNumber(v.lastBootStartedAt) ? v.lastBootStartedAt : 0,
    lastBootCompletedAt: isFiniteNumber(v.lastBootCompletedAt) ? v.lastBootCompletedAt : 0,
    lastBootThoughtAt: isFiniteNumber(v.lastBootThoughtAt) ? v.lastBootThoughtAt : 0,
    lastBootThought: typeof v.lastBootThought === "string" ? v.lastBootThought : "",
    qqMode: coerceQqMode(v.qqMode),
    qqModeReason: typeof v.qqModeReason === "string" ? v.qqModeReason : "",
    qqModeDecidedAt: isFiniteNumber(v.qqModeDecidedAt) ? v.qqModeDecidedAt : 0,
    qqModeReconsiderAt: isFiniteNumber(v.qqModeReconsiderAt) ? v.qqModeReconsiderAt : 0,
    currentConversationId: typeof v.currentConversationId === "string" ? v.currentConversationId : "",
    currentConversationOpenedAt: isFiniteNumber(v.currentConversationOpenedAt) ? v.currentConversationOpenedAt : 0,
  };
}

// Defensive parse: anything malformed degrades to a default, never throws.
function coerceGroupState(value: unknown, dateKey: string): HollyGroupState {
  const base = freshGroupState(dateKey);
  if (!value || typeof value !== "object") {
    return base;
  }
  const v = value as Record<string, unknown>;
  const engaged: Record<string, number> = {};
  if (v.engagedThreads && typeof v.engagedThreads === "object") {
    for (const [k, t] of Object.entries(v.engagedThreads as Record<string, unknown>)) {
      if (isFiniteNumber(t)) engaged[k] = t;
    }
  }
  let pending: PendingObservation | null = null;
  if (v.pendingObservation && typeof v.pendingObservation === "object") {
    const p = v.pendingObservation as Record<string, unknown>;
    if (isFiniteNumber(p.sentAt) && typeof p.threadKey === "string") {
      pending = { sentAt: p.sentAt, threadKey: p.threadKey };
    }
  }
  return {
    lastProactiveAt: isFiniteNumber(v.lastProactiveAt) ? v.lastProactiveAt : 0,
    backoffLevel: isFiniteNumber(v.backoffLevel) ? Math.max(0, Math.floor(v.backoffLevel)) : 0,
    dailyDate: typeof v.dailyDate === "string" ? v.dailyDate : dateKey,
    dailyCount: isFiniteNumber(v.dailyCount) ? Math.max(0, Math.floor(v.dailyCount)) : 0,
    engagedThreads: engaged,
    pendingObservation: pending,
  };
}

function coercePersisted(raw: unknown, dateKey: string): HollyStatePersisted {
  const empty: HollyStatePersisted = {
    version: 1,
    globalDailyDate: dateKey,
    globalDailyCount: 0,
    autonomy: freshAutonomyState(dateKey),
    lifecycle: freshLifecycleState(),
    groups: {},
  };
  if (!raw || typeof raw !== "object") return empty;
  const r = raw as Record<string, unknown>;
  const groups: Record<string, HollyGroupState> = {};
  if (r.groups && typeof r.groups === "object") {
    for (const [k, gv] of Object.entries(r.groups as Record<string, unknown>)) {
      groups[k] = coerceGroupState(gv, dateKey);
    }
  }
  return {
    version: 1,
    globalDailyDate: typeof r.globalDailyDate === "string" ? r.globalDailyDate : dateKey,
    globalDailyCount: isFiniteNumber(r.globalDailyCount) ? Math.max(0, Math.floor(r.globalDailyCount)) : 0,
    autonomy: coerceAutonomyState(r.autonomy, dateKey),
    lifecycle: coerceLifecycleState(r.lifecycle),
    groups,
  };
}

export class HollyStateStore {
  private data: HollyStatePersisted;
  private readonly path: string;
  private saveQueue: Promise<void> = Promise.resolve();
  private engagedTtlMs: number;

  private constructor(path: string, data: HollyStatePersisted, engagedTtlMs: number) {
    this.path = path;
    this.data = data;
    this.engagedTtlMs = engagedTtlMs;
  }

  static async load(path: string, engagedTtlMs: number): Promise<HollyStateStore> {
    const dateKey = localDateKey();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await readFile(path, "utf-8"));
    } catch {
      // Missing or corrupt file → start from defaults. Never crash the bot.
    }
    return new HollyStateStore(path, coercePersisted(parsed, dateKey), engagedTtlMs);
  }

  setEngagedTtl(ms: number): void {
    this.engagedTtlMs = ms;
  }

  // Reset per-day counters when the local date rolls over (codex: date/tz key).
  rollDaily(now = Date.now()): void {
    const today = localDateKey(new Date(now));
    if (this.data.globalDailyDate !== today) {
      this.data.globalDailyDate = today;
      this.data.globalDailyCount = 0;
    }
    if (this.data.autonomy.worldObservationDailyDate !== today) {
      this.data.autonomy.worldObservationDailyDate = today;
      this.data.autonomy.worldObservationDailyCount = 0;
    }
    if (this.data.autonomy.memoryReflectionDailyDate !== today) {
      this.data.autonomy.memoryReflectionDailyDate = today;
      this.data.autonomy.memoryReflectionDailyCount = 0;
    }
    if (this.data.autonomy.archiveWritingDailyDate !== today) {
      this.data.autonomy.archiveWritingDailyDate = today;
      this.data.autonomy.archiveWritingDailyCount = 0;
    }
    for (const g of Object.values(this.data.groups)) {
      if (g.dailyDate !== today) {
        g.dailyDate = today;
        g.dailyCount = 0;
      }
    }
  }

  getGroup(groupKey: string): HollyGroupState {
    let g = this.data.groups[groupKey];
    if (!g) {
      g = freshGroupState(localDateKey());
      this.data.groups[groupKey] = g;
    }
    return g;
  }

  globalDailyCount(): number {
    return this.data.globalDailyCount;
  }

  getAutonomyState(): HollyAutonomyState {
    return this.data.autonomy;
  }

  getLifecycleState(): HollyLifecycleState {
    return this.data.lifecycle;
  }

  isThreadEngaged(groupKey: string, threadKey: string, now = Date.now()): boolean {
    const g = this.getGroup(groupKey);
    const at = g.engagedThreads[threadKey];
    if (at === undefined) return false;
    if (now - at > this.engagedTtlMs) {
      delete g.engagedThreads[threadKey]; // TTL 过期,允许重来
      return false;
    }
    return true;
  }

  // Record a proactive action (would-be in shadow, real in live): bump counts,
  // mark the thread engaged, open the observation window.
  recordProactive(groupKey: string, threadKey: string, now = Date.now()): void {
    this.rollDaily(now);
    const g = this.getGroup(groupKey);
    g.lastProactiveAt = now;
    g.dailyCount += 1;
    this.data.globalDailyCount += 1;
    g.engagedThreads[threadKey] = now;
    g.pendingObservation = { sentAt: now, threadKey };
    this.pruneEngaged(g, now);
  }

  private pruneEngaged(g: HollyGroupState, now: number): void {
    for (const [k, at] of Object.entries(g.engagedThreads)) {
      if (now - at > this.engagedTtlMs) delete g.engagedThreads[k];
    }
  }

  // Settlement (2A, tick-driven). Returns the outcome for logging, or null if
  // nothing to settle yet. `engaged` = a user spoke within the success window
  // after the proactive send (caller computes from history).
  settleObservation(
    groupKey: string,
    opts: { now: number; observationWindowMs: number; backoffMultiplier: number; engaged: boolean },
  ): "success" | "ignored" | null {
    const g = this.getGroup(groupKey);
    const pending = g.pendingObservation;
    if (!pending) return null;
    if (opts.engaged) {
      g.pendingObservation = null;
      g.backoffLevel = 0; // 一次成功清零(温和档)
      return "success";
    }
    if (opts.now - pending.sentAt < opts.observationWindowMs) {
      return null; // 还在观察窗内,等下一个 tick
    }
    g.pendingObservation = null;
    g.backoffLevel += 1; // 被无视 → 退避升级
    return "ignored";
  }

  snapshotForLog(groupKey: string): Record<string, unknown> {
    const g = this.getGroup(groupKey);
    return {
      lastProactiveAt: g.lastProactiveAt,
      backoffLevel: g.backoffLevel,
      dailyCount: g.dailyCount,
      globalDailyCount: this.data.globalDailyCount,
      pending: g.pendingObservation,
    };
  }

  // Atomic, serialized persistence. temp + rename so a crash mid-write can never
  // leave a half-file (which corrupt-safe load would then discard anyway).
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.saveQueue = this.saveQueue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, snapshot, "utf-8");
        await rename(tmp, this.path);
      })
      .catch((error) => {
        console.error("Failed to persist Holly state:", error);
      });
    return this.saveQueue;
  }
}
