import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createIncomingMessageStore } from "../memory-store.js";

async function withConfig<T>(contents: string, run: (configPath: string) => Promise<T>): Promise<T> {
  const directory = join(tmpdir(), `holly-memory-store-${randomUUID()}`);
  const configPath = join(directory, "config.yaml");
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, contents, "utf8");
  try {
    return await run(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("memory store selects local SQLite from database.provider", async () => {
  await withConfig(
    'database:\n  enabled: true\n  provider: sqlite\n  url: "file::memory:"\n',
    async (configPath) => {
      const store = await createIncomingMessageStore(configPath, { sessionId: "local-session" });
      assert.ok(store);
      assert.equal(store.collectionName, "memory_records");
      assert.match(store.description, /file::memory:/);
    },
  );
});

test("memory store can be disabled independently of backend settings", async () => {
  await withConfig(
    "database:\n  enabled: false\n  provider: sqlite\n",
    async (configPath) => {
      assert.equal(await createIncomingMessageStore(configPath), null);
    },
  );
});

test("memory store rejects unknown providers", async () => {
  await withConfig(
    "database:\n  provider: postgres\n",
    async (configPath) => {
      await assert.rejects(
        createIncomingMessageStore(configPath),
        /Invalid 'database\.provider'/,
      );
    },
  );
});
