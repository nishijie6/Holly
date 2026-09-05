import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_LOG_PRUNE,
  JSONL_RETENTION_RULES,
  planSessionLogPrune,
  trimJsonlContent,
} from "../log-retention.js";
import type { SessionLogFile } from "../log-retention.js";

// Retention deletes things, so the tests are mostly about what it must NOT
// delete. Getting this wrong costs history nobody can get back.

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const file = (name: string, ageDays: number): SessionLogFile => ({
  name,
  modifiedAtMs: NOW - ageDays * DAY,
});
const opts = (over: Partial<Parameters<typeof planSessionLogPrune>[1]> = {}) => ({
  ...DEFAULT_SESSION_LOG_PRUNE,
  activeFile: null,
  now: NOW,
  ...over,
});

// --- session transcripts ---------------------------------------------------

test("nothing is pruned when everything is recent", () => {
  const files = Array.from({ length: 100 }, (_, i) => file(`s${i}.log`, 1));
  assert.deepEqual(planSessionLogPrune(files, opts()), []);
});

test("nothing is pruned when everything fits the keep window", () => {
  const files = Array.from({ length: 10 }, (_, i) => file(`s${i}.log`, 400));
  assert.deepEqual(planSessionLogPrune(files, opts({ keepNewest: 40 })), []);
});

test("both bounds must agree before a file goes", () => {
  // 50 files, all old: only the ones outside the keep-newest window go.
  const files = Array.from({ length: 50 }, (_, i) => file(`s${i}.log`, 100 + i));
  const pruned = planSessionLogPrune(files, opts({ keepNewest: 40 }));
  assert.equal(pruned.length, 10);
  // The 40 newest survive; the oldest are the ones removed.
  assert.ok(pruned.includes("s49.log"));
  assert.ok(!pruned.includes("s0.log"));
});

test("the active transcript is never a candidate", () => {
  // Old and far outside the keep window — deletable on every count but one.
  const files = Array.from({ length: 60 }, (_, i) => file(`s${i}.log`, 200));
  const pruned = planSessionLogPrune(files, opts({ keepNewest: 1, activeFile: "s59.log" }));
  assert.ok(!pruned.includes("s59.log"), "deleting the file being written loses this session");
  assert.ok(pruned.length > 0, "and the rest still prune");
});

test("a burst of restarts does not get deleted just for being numerous", () => {
  // ~140 tiny transcripts from restarts, all from today. This is the actual
  // shape on disk, and age is what protects them.
  const files = Array.from({ length: 140 }, (_, i) => file(`s${i}.log`, 0));
  assert.deepEqual(planSessionLogPrune(files, opts()), []);
});

test("a long-idle install does not lose its history on first run", () => {
  // Everything is ancient, but there are fewer files than the keep window.
  const files = Array.from({ length: 5 }, (_, i) => file(`s${i}.log`, 900));
  assert.deepEqual(planSessionLogPrune(files, opts()), []);
});

test("the age boundary is exclusive on the safe side", () => {
  const files = Array.from({ length: 3 }, (_, i) => file(`s${i}.log`, 30));
  // Exactly at maxAgeMs is not yet "older than", so it stays.
  assert.deepEqual(planSessionLogPrune(files, opts({ keepNewest: 0, maxAgeMs: 30 * DAY })), []);
  assert.equal(planSessionLogPrune(files, opts({ keepNewest: 0, maxAgeMs: 30 * DAY - 1 })).length, 3);
});

test("an empty directory is not an error", () => {
  assert.deepEqual(planSessionLogPrune([], opts()), []);
});

// --- jsonl trimming --------------------------------------------------------

test("a file within bound is left completely alone", () => {
  assert.equal(trimJsonlContent("a\nb\nc\n", 5), null);
  assert.equal(trimJsonlContent("a\nb\nc\n", 3), null);
});

test("trimming keeps the newest lines and stays newline-terminated", () => {
  const trimmed = trimJsonlContent("1\n2\n3\n4\n5\n", 2);
  assert.equal(trimmed, "4\n5\n");
});

test("a missing trailing newline does not count as a record", () => {
  // Otherwise a torn last line would shift the count and drop a real record.
  assert.equal(trimJsonlContent("1\n2\n3", 3), null);
  assert.equal(trimJsonlContent("1\n2\n3", 2), "2\n3\n");
});

test("an empty file is left alone", () => {
  assert.equal(trimJsonlContent("", 10), null);
});

// --- the rules themselves --------------------------------------------------

test("every retention bound stays far above what the code restores", () => {
  // The bounds only stay safe while they exceed the in-memory caps; this test
  // is the reminder to re-check if a cap ever grows.
  for (const rule of JSONL_RETENTION_RULES) {
    assert.ok(rule.keepLines >= 1_000, `${rule.file} keeps too few lines`);
    assert.ok(rule.readBy.length > 0, `${rule.file} must document who reads it`);
  }
});

test("the rules name distinct files", () => {
  const names = JSONL_RETENTION_RULES.map((rule) => rule.file);
  assert.equal(new Set(names).size, names.length);
});

test("supervisor-owned logs are deliberately absent", () => {
  // launchd/pm2 hold live append-mode descriptors on these; rewriting one under
  // the writer races. Rotating them is the supervisor's job, not Holly's.
  const names = JSONL_RETENTION_RULES.map((rule) => rule.file);
  for (const forbidden of ["launchd.err.log", "launchd.out.log", "pm2-error.log", "pm2-out.log"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be managed here`);
  }
});
