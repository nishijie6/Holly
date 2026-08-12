import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createSqliteIncomingMessageStore, openSqlitePayloadRepository } from "../sqlite-store.js";

async function withConfig<T>(
  contents: string,
  run: (configPath: string, directory: string) => Promise<T>,
): Promise<T> {
  const directory = join(tmpdir(), `holly-sqlite-${randomUUID()}`);
  const configPath = join(directory, "config.yaml");
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, contents, "utf8");
  try {
    return await run(configPath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite store persists and filters normalized memory records", async () => {
  await withConfig('database:\n  url: "file::memory:"\n', async (configPath) => {
    const store = await createSqliteIncomingMessageStore(configPath, {
      sessionId: "session-1",
      sessionStartedAt: "2026-08-12T00:00:00.000Z",
    });

    await store.saveInternalMemory({
      receivedAt: "2026-08-12T01:00:00.000Z",
      content: "first internal memory",
      topic: "one",
    });
    await store.saveWorldObservation({
      observedAt: "2026-08-12T02:00:00.000Z",
      topic: "astronomy",
      query: "latest discovery",
      summary: "new observation",
      urls: ["https://example.com/discovery"],
    });

    const all = await store.listRecentMemories({ limit: 10 });
    assert.deepEqual(all.map((record) => record.messageType), [
      "world_observation",
      "internal_memory",
    ]);
    assert.equal(all[0]?.displayText, "new observation");
    assert.deepEqual(all[0]?.memoryUrls, ["https://example.com/discovery"]);

    const internal = await store.listRecentMemories({
      userId: "holly",
      messageType: "internal_memory",
      limit: 10,
    });
    assert.equal(internal.length, 1);
    assert.equal(internal[0]?.memoryTopic, "one");
  });
});

test("SQLite store ignores NapCat heartbeat records", async () => {
  await withConfig('database:\n  url: "file::memory:"\n', async (configPath) => {
    const store = await createSqliteIncomingMessageStore(configPath);
    await store.saveMessage({
      sequence: 1,
      receivedAt: "2026-08-12T00:00:00.000Z",
      isBinary: false,
      rawEncoding: "utf8",
      rawContent: JSON.stringify({
        post_type: "meta_event",
        meta_event_type: "heartbeat",
      }),
      binarySize: null,
      displayText: null,
      messageType: null,
      groupId: null,
      groupName: null,
      userId: null,
      senderName: null,
      rawMessage: null,
    });

    assert.deepEqual(await store.listRecentMemories({ limit: 10 }), []);
  });
});

test("SQLite migration repository is idempotent by source point id", async () => {
  await withConfig("database:\n  url: file:./data/holly.db\n", async (configPath, directory) => {
    const repository = await openSqlitePayloadRepository(configPath);
    try {
      const payload = {
        received_at: "2026-08-12T00:00:00.000Z",
        message_type: "internal_memory",
        content: "migrated",
      };
      assert.equal(repository.insertPayload("qdrant-id-1", payload), true);
      assert.equal(repository.insertPayload("qdrant-id-1", payload), false);
      assert.equal(repository.count(), 1);
      assert.equal(repository.databasePath, join(directory, "data", "holly.db"));
    } finally {
      repository.close();
    }
  });
});
