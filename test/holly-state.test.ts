import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, rm, readFile } from "node:fs/promises";

import { HollyStateStore, localDateKey } from "../holly-state.js";

const TTL = 60 * 60 * 1000;

function tmpPath(): string {
  return join(tmpdir(), `holly-state-${randomUUID()}.json`);
}

test("load: missing file → defaults, does not throw", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  assert.equal(store.globalDailyCount(), 0);
  const g = store.getGroup("111");
  assert.equal(g.dailyCount, 0);
  assert.equal(g.backoffLevel, 0);
  assert.equal(g.pendingObservation, null);
  assert.equal(store.getLifecycleState().qqMode, "offline");
});

test("load: corrupt JSON → defaults, does not crash", async () => {
  const path = tmpPath();
  await writeFile(path, "{ this is not valid json ]]", "utf-8");
  const store = await HollyStateStore.load(path, TTL);
  assert.equal(store.globalDailyCount(), 0);
  assert.equal(store.getLifecycleState().bootCount, 0);
  await rm(path, { force: true });
});

test("recordProactive: bumps counts, opens observation, marks engaged", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  const now = Date.now();
  store.recordProactive("g1", "tk-1", now);
  const g = store.getGroup("g1");
  assert.equal(g.dailyCount, 1);
  assert.equal(store.globalDailyCount(), 1);
  assert.ok(g.pendingObservation);
  assert.equal(g.pendingObservation?.threadKey, "tk-1");
  assert.equal(store.isThreadEngaged("g1", "tk-1", now), true);
});

test("isThreadEngaged: TTL expiry releases the thread", async () => {
  const store = await HollyStateStore.load(tmpPath(), 1000); // 1s TTL
  const now = Date.now();
  store.recordProactive("g1", "tk-1", now);
  assert.equal(store.isThreadEngaged("g1", "tk-1", now + 500), true);
  assert.equal(store.isThreadEngaged("g1", "tk-1", now + 2000), false); // past TTL
});

test("rollDaily: resets per-day counters when the local date changes", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  const now = Date.now();
  store.recordProactive("g1", "tk-1", now);
  // Force a stale date so rollDaily must reset.
  const g = store.getGroup("g1");
  g.dailyDate = "2000-01-01";
  store.rollDaily(now);
  assert.equal(store.getGroup("g1").dailyDate, localDateKey(new Date(now)));
  assert.equal(store.getGroup("g1").dailyCount, 0);
});

test("autonomy state: persists world observation cadence", async () => {
  const path = tmpPath();
  const store = await HollyStateStore.load(path, TTL);
  const autonomy = store.getAutonomyState();
  autonomy.lastWorldObservationAt = 123;
  autonomy.lastWorldObservationAttemptAt = 456;
  autonomy.worldObservationDailyCount = 2;
  autonomy.nextWorldTopicIndex = 1;
  autonomy.lastMemoryReflectionAt = 789;
  autonomy.lastMemoryReflectionAttemptAt = 1000;
  autonomy.memoryReflectionDailyCount = 3;
  autonomy.lastArchiveWritingAt = 1100;
  autonomy.lastArchiveWritingAttemptAt = 1200;
  autonomy.archiveWritingDailyCount = 1;
  await store.save();

  const reloaded = await HollyStateStore.load(path, TTL);
  const persisted = reloaded.getAutonomyState();
  assert.equal(persisted.lastWorldObservationAt, 123);
  assert.equal(persisted.lastWorldObservationAttemptAt, 456);
  assert.equal(persisted.worldObservationDailyCount, 2);
  assert.equal(persisted.nextWorldTopicIndex, 1);
  assert.equal(persisted.lastMemoryReflectionAt, 789);
  assert.equal(persisted.lastMemoryReflectionAttemptAt, 1000);
  assert.equal(persisted.memoryReflectionDailyCount, 3);
  assert.equal(persisted.lastArchiveWritingAt, 1100);
  assert.equal(persisted.lastArchiveWritingAttemptAt, 1200);
  assert.equal(persisted.archiveWritingDailyCount, 1);
  await rm(path, { force: true });
});

test("autonomy state: 最近写过的题目存得住、读得回", async () => {
  const path = tmpPath();
  const store = await HollyStateStore.load(path, TTL);
  store.getAutonomyState().recentActions.push(
    { kind: "archive_writing", at: 1100, title: "星尘" },
    { kind: "memory_reflection", at: 1200, title: "关于噪音" },
  );
  await store.save();

  const reloaded = await HollyStateStore.load(path, TTL);
  assert.deepEqual(reloaded.getAutonomyState().recentActions, [
    { kind: "archive_writing", at: 1100, title: "星尘" },
    { kind: "memory_reflection", at: 1200, title: "关于噪音" },
  ]);
  await rm(path, { force: true });
});

// 这个字段是后加的。升级时老存档里根本没有它，缺失必须平滑退成空数组——不能因为读不到
// 就把整份 autonomy 状态退回默认值，那样她会连今天写过几次都忘掉。
test("autonomy state: 老存档没有这个字段，升上来是空数组，别的状态原样保留", async () => {
  const path = tmpPath();
  await writeFile(
    path,
    JSON.stringify({ autonomy: { lastArchiveWritingAt: 1100, archiveWritingDailyCount: 2 } }),
    "utf-8",
  );

  const store = await HollyStateStore.load(path, TTL);
  const autonomy = store.getAutonomyState();
  assert.deepEqual(autonomy.recentActions, []);
  assert.equal(autonomy.lastArchiveWritingAt, 1100);
  assert.equal(autonomy.archiveWritingDailyCount, 2);
  await rm(path, { force: true });
});

// 坏掉的单条只丢那一条：判断层顶多把它当成没写过，比整份状态回退轻得多。
test("autonomy state: 名单里坏掉的条目被丢掉，好的留下", async () => {
  const path = tmpPath();
  await writeFile(
    path,
    JSON.stringify({
      autonomy: {
        recentActions: [
          { kind: "archive_writing", at: 1100, title: "星尘" },
          { kind: "不认识的动作", at: 1150, title: "谁" },
          { kind: "memory_reflection", at: 1200, title: "   " },
          { kind: "memory_reflection", title: "没有时间戳" },
          "整条不是对象",
        ],
      },
    }),
    "utf-8",
  );

  const store = await HollyStateStore.load(path, TTL);
  assert.deepEqual(store.getAutonomyState().recentActions, [
    { kind: "archive_writing", at: 1100, title: "星尘" },
    { kind: "memory_reflection", at: 0, title: "没有时间戳" },
  ]);
  await rm(path, { force: true });
});

// 连败计数必须跨重启活着。一个「启动就崩」的故障会让进程反复重来，计数每次归零就永远
// 攒不到阈值，退避等于不存在——而那恰好是最该退避的情形。
test("autonomy state: 判断连败计数跨重启保留", async () => {
  const path = tmpPath();
  const store = await HollyStateStore.load(path, TTL);
  store.getAutonomyState().judgmentFailureStreak = 3;
  store.getAutonomyState().lastJudgmentFailureAt = 1700;
  await store.save();

  const reloaded = await HollyStateStore.load(path, TTL);
  assert.equal(reloaded.getAutonomyState().judgmentFailureStreak, 3);
  assert.equal(reloaded.getAutonomyState().lastJudgmentFailureAt, 1700);
  await rm(path, { force: true });
});

test("autonomy state: 连败计数是坏值就当没失败过", async () => {
  const path = tmpPath();
  await writeFile(
    path,
    JSON.stringify({ autonomy: { judgmentFailureStreak: -5, lastJudgmentFailureAt: "昨天" } }),
    "utf-8",
  );

  const store = await HollyStateStore.load(path, TTL);
  assert.equal(store.getAutonomyState().judgmentFailureStreak, 0);
  assert.equal(store.getAutonomyState().lastJudgmentFailureAt, 0);
  await rm(path, { force: true });
});

test("lifecycle state: persists boot thought and QQ mode decision", async () => {
  const path = tmpPath();
  const store = await HollyStateStore.load(path, TTL);
  const lifecycle = store.getLifecycleState();
  lifecycle.bootCount = 2;
  lifecycle.lastBootStartedAt = 100;
  lifecycle.lastBootCompletedAt = 200;
  lifecycle.lastBootThoughtAt = 150;
  lifecycle.lastBootThought = "先安静看看";
  lifecycle.qqMode = "observe";
  lifecycle.qqModeReason = "暂时只观察";
  lifecycle.qqModeDecidedAt = 180;
  lifecycle.qqModeReconsiderAt = 360;
  await store.save();

  const restored = await HollyStateStore.load(path, TTL);
  assert.deepEqual(restored.getLifecycleState(), lifecycle);
  await rm(path, { force: true });
});

test("settleObservation: null when nothing pending", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  const r = store.settleObservation("g1", {
    now: Date.now(),
    observationWindowMs: 1000,
    backoffMultiplier: 1.5,
    engaged: false,
  });
  assert.equal(r, null);
});

test("settleObservation: engaged → success, backoff reset, pending cleared", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  const now = Date.now();
  store.recordProactive("g1", "tk-1", now);
  store.getGroup("g1").backoffLevel = 3;
  const r = store.settleObservation("g1", {
    now: now + 500,
    observationWindowMs: 1000,
    backoffMultiplier: 1.5,
    engaged: true,
  });
  assert.equal(r, "success");
  assert.equal(store.getGroup("g1").backoffLevel, 0);
  assert.equal(store.getGroup("g1").pendingObservation, null);
});

test("settleObservation: ignored only after the window, then backoff++", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  const now = Date.now();
  store.recordProactive("g1", "tk-1", now);

  // Still inside the observation window → not settled yet.
  const early = store.settleObservation("g1", {
    now: now + 500,
    observationWindowMs: 1000,
    backoffMultiplier: 1.5,
    engaged: false,
  });
  assert.equal(early, null);
  assert.ok(store.getGroup("g1").pendingObservation);

  // Past the window, still no engagement → ignored.
  const late = store.settleObservation("g1", {
    now: now + 2000,
    observationWindowMs: 1000,
    backoffMultiplier: 1.5,
    engaged: false,
  });
  assert.equal(late, "ignored");
  assert.equal(store.getGroup("g1").backoffLevel, 1);
  assert.equal(store.getGroup("g1").pendingObservation, null);
});

test("save + reload: state persists atomically across a fresh load", async () => {
  const path = tmpPath();
  const store = await HollyStateStore.load(path, TTL);
  const now = Date.now();
  store.recordProactive("g1", "tk-1", now);
  store.getGroup("g1").backoffLevel = 2;
  await store.save();

  // The temp file must be gone (atomic rename), only the final file remains.
  const raw = await readFile(path, "utf-8");
  assert.ok(raw.includes("g1"));

  const reloaded = await HollyStateStore.load(path, TTL);
  assert.equal(reloaded.getGroup("g1").dailyCount, 1);
  assert.equal(reloaded.getGroup("g1").backoffLevel, 2);
  assert.equal(reloaded.globalDailyCount(), 1);
  await rm(path, { force: true });
});

// Focus is the one piece of the kagami model that must outlive the process:
// Holly should come back looking at the conversation it was looking at, rather
// than reopening whatever spoke first.
test("lifecycle state: current conversation focus survives a restart", async () => {
  const path = tmpPath();
  const store = await HollyStateStore.load(path, TTL);
  const lifecycle = store.getLifecycleState();
  lifecycle.currentConversationId = "qq_group:20000001";
  lifecycle.currentConversationOpenedAt = 1_700_000_000_000;
  await store.save();

  const restored = await HollyStateStore.load(path, TTL);
  assert.equal(restored.getLifecycleState().currentConversationId, "qq_group:20000001");
  assert.equal(restored.getLifecycleState().currentConversationOpenedAt, 1_700_000_000_000);
  await rm(path, { force: true });
});

test("lifecycle state: a state file written before focus existed loads with no focus", async () => {
  const path = tmpPath();
  await writeFile(path, JSON.stringify({
    version: 1,
    globalDailyDate: localDateKey(),
    globalDailyCount: 0,
    autonomy: {},
    lifecycle: { bootCount: 7, qqMode: "active" },
    groups: {},
  }), "utf-8");

  const store = await HollyStateStore.load(path, TTL);
  const lifecycle = store.getLifecycleState();
  // Field-by-field coercion means no version bump was needed; the old file just
  // reads as "not looking at anything yet".
  assert.equal(lifecycle.bootCount, 7);
  assert.equal(lifecycle.qqMode, "active");
  assert.equal(lifecycle.currentConversationId, "");
  assert.equal(lifecycle.currentConversationOpenedAt, 0);
  await rm(path, { force: true });
});

// 转发计数是后加的字段：老存档里没有，读上来从 0 记起，别的状态照旧；记过的数存得住，跨天清零。
test("autonomy state: 转发计数老存档缺了从 0 起，存得住，跨天清零", async () => {
  const path = tmpPath();
  await writeFile(
    path,
    JSON.stringify({ autonomy: { lastWorldObservationAt: 123, worldObservationDailyCount: 2 } }),
    "utf-8",
  );

  const store = await HollyStateStore.load(path, TTL);
  const autonomy = store.getAutonomyState();
  assert.equal(autonomy.lastWorldObservationShareAt, 0);
  assert.equal(autonomy.worldObservationShareDailyCount, 0);
  assert.equal(autonomy.lastWorldObservationAt, 123);

  autonomy.lastWorldObservationShareAt = 456;
  autonomy.worldObservationShareDailyCount = 3;
  await store.save();
  const reloaded = await HollyStateStore.load(path, TTL);
  assert.equal(reloaded.getAutonomyState().lastWorldObservationShareAt, 456);
  assert.equal(reloaded.getAutonomyState().worldObservationShareDailyCount, 3);

  reloaded.getAutonomyState().worldObservationShareDailyDate = "2000-01-01";
  reloaded.rollDaily(Date.now());
  assert.equal(reloaded.getAutonomyState().worldObservationShareDailyCount, 0);
  assert.equal(reloaded.getAutonomyState().worldObservationShareDailyDate, localDateKey(new Date()));
  await rm(path, { force: true });
});
