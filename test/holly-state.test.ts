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
});

test("load: corrupt JSON → defaults, does not crash", async () => {
  const path = tmpPath();
  await writeFile(path, "{ this is not valid json ]]", "utf-8");
  const store = await HollyStateStore.load(path, TTL);
  assert.equal(store.globalDailyCount(), 0);
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
