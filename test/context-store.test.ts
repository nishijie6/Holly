import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";

import {
  ConversationContextStore,
  MAX_PERSISTED_TURNS_PER_GROUP,
  type PersistedConversationTurn,
} from "../context-store.js";

function tmpPath(): string {
  return join(tmpdir(), `conversation-context-${randomUUID()}.json`);
}

function makeTurn(overrides: Partial<PersistedConversationTurn> = {}): PersistedConversationTurn {
  return {
    groupId: "111",
    role: "user",
    senderName: "Alice",
    userId: "10001",
    content: "hello",
    timestamp: "2026-07-08T10:00:00.000Z",
    messageId: null,
    ...overrides,
  };
}

test("load: missing file → empty context, does not throw", async () => {
  const store = new ConversationContextStore(tmpPath());
  const restored = await store.load();
  assert.equal(restored.size, 0);
});

test("load: corrupt JSON → empty context, does not crash", async () => {
  const path = tmpPath();
  await writeFile(path, "{ this is not valid json ]]", "utf-8");
  const store = new ConversationContextStore(path);
  const restored = await store.load();
  assert.equal(restored.size, 0);
  await rm(path, { force: true });
});

test("save + reload: turns round-trip per group in order", async () => {
  const path = tmpPath();
  const store = new ConversationContextStore(path);
  const history = new Map<string, PersistedConversationTurn[]>([
    ["111", [
      makeTurn({ content: "first", messageId: "m1" }),
      makeTurn({ role: "assistant", senderName: "Holly", userId: null, content: "second", timestamp: "2026-07-08T10:01:00.000Z" }),
    ]],
    ["222", [makeTurn({ groupId: "222", content: "other group" })]],
  ]);
  await store.save(history);

  const restored = await new ConversationContextStore(path).load();
  assert.equal(restored.size, 2);
  const turns = restored.get("111") ?? [];
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.content, "first");
  assert.equal(turns[0]?.messageId, "m1");
  assert.equal(turns[1]?.role, "assistant");
  assert.equal(restored.get("222")?.[0]?.content, "other group");
  await rm(path, { force: true });
});

test("load: invalid turns are skipped, valid ones kept", async () => {
  const path = tmpPath();
  await writeFile(path, JSON.stringify({
    version: 1,
    groups: {
      "111": [
        makeTurn({ content: "kept" }),
        { role: "system", content: "bad role", timestamp: "2026-07-08T10:00:00.000Z" },
        { role: "user", content: "", timestamp: "2026-07-08T10:00:00.000Z" },
        { role: "user", content: "bad timestamp", timestamp: "not-a-date" },
        "not an object",
      ],
      "222": "not an array",
    },
  }), "utf-8");

  const restored = await new ConversationContextStore(path).load();
  assert.equal(restored.size, 1);
  assert.equal(restored.get("111")?.length, 1);
  assert.equal(restored.get("111")?.[0]?.content, "kept");
  await rm(path, { force: true });
});

test("save: caps persisted turns per group to the most recent ones", async () => {
  const path = tmpPath();
  const store = new ConversationContextStore(path);
  const turns = Array.from({ length: MAX_PERSISTED_TURNS_PER_GROUP + 50 }, (_, i) =>
    makeTurn({ content: `msg ${i}`, timestamp: new Date(Date.UTC(2026, 6, 8, 0, 0, i % 60, i)).toISOString() }));
  await store.save(new Map([["111", turns]]));

  const restored = await new ConversationContextStore(path).load();
  const kept = restored.get("111") ?? [];
  assert.equal(kept.length, MAX_PERSISTED_TURNS_PER_GROUP);
  assert.equal(kept[0]?.content, "msg 50");
  assert.equal(kept.at(-1)?.content, `msg ${MAX_PERSISTED_TURNS_PER_GROUP + 49}`);
  await rm(path, { force: true });
});
