import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ThoughtHistoryStore } from "../thought-history.js";

function tmpPath(): string {
  return join(tmpdir(), `holly-thoughts-${randomUUID()}`, "thought-history.jsonl");
}

test("thought history: appends and restores entries", async () => {
  const path = tmpPath();
  const store = await ThoughtHistoryStore.load(path, 10);
  const saved = await store.append({
    timestamp: "2026-08-12T12:00:00.000Z",
    kind: "reactive",
    title: "群消息判断",
    summary: "有人直接问 Holly，所以应该回复。",
    groupId: "123",
    outcome: "reply",
    finalAnswer: "在。",
    model: "test-model",
    durationMs: 1250,
  });

  const restored = await ThoughtHistoryStore.load(path, 10);
  assert.deepEqual(restored.list(), [saved]);
  await rm(join(path, ".."), { recursive: true, force: true });
});

test("thought history: skips corrupt lines and keeps the newest configured slice", async () => {
  const path = tmpPath();
  const rows = [
    JSON.stringify({ id: "old", timestamp: "2026-08-12T10:00:00Z", kind: "bootstrap", title: "boot", summary: "old", groupId: null, outcome: "", finalAnswer: "", model: "", durationMs: null }),
    "not-json",
    JSON.stringify({ id: "new", timestamp: "2026-08-12T11:00:00Z", kind: "qq_mode", title: "mode", summary: "new", groupId: null, outcome: "observe", finalAnswer: "", model: "", durationMs: null }),
  ];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.join("\n")}\n`, "utf-8");

  const restored = await ThoughtHistoryStore.load(path, 1);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0]?.id, "new");
  assert.equal(restored.list()[0]?.durationMs, null);
  await rm(join(path, ".."), { recursive: true, force: true });
});
