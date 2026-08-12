import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DurableOutbox } from "../qdrant-outbox.js";

function tmpPath(): string {
  return join(tmpdir(), `holly-qdrant-outbox-${randomUUID()}`);
}

test("durable outbox: persists entries and drains them in order", async () => {
  const path = tmpPath();
  const first = new DurableOutbox<{ id: string }>(path);
  await first.enqueue({ id: "one" }, "00000000-0000-4000-8000-000000000001");
  await first.enqueue({ id: "two" }, "00000000-0000-4000-8000-000000000002");

  const restored = new DurableOutbox<{ id: string }>(path);
  assert.deepEqual((await restored.list()).map((entry) => entry.value.id), ["one", "two"]);
  const batches: string[][] = [];
  const delivered = await restored.drain(async (values) => {
    batches.push(values.map((value) => value.id));
  }, 1);

  assert.equal(delivered, 2);
  assert.deepEqual(batches, [["one"], ["two"]]);
  assert.equal(await restored.pendingCount(), 0);
  await rm(path, { recursive: true, force: true });
});

test("durable outbox: retains an entry when delivery fails, then replays it", async () => {
  const path = tmpPath();
  const outbox = new DurableOutbox<{ id: string }>(path);
  await outbox.enqueue({ id: "retry-me" }, "00000000-0000-4000-8000-000000000003");

  await assert.rejects(outbox.drain(async () => {
    throw new Error("network down");
  }), /network down/);
  assert.equal(await outbox.pendingCount(), 1);

  const replayed: string[] = [];
  await new DurableOutbox<{ id: string }>(path).drain(async (values) => {
    replayed.push(...values.map((value) => value.id));
  });
  assert.deepEqual(replayed, ["retry-me"]);
  assert.equal(await outbox.pendingCount(), 0);
  await rm(path, { recursive: true, force: true });
});

test("durable outbox: surfaces corrupt entries without deleting them", async () => {
  const path = tmpPath();
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "00000000-0000-4000-8000-000000000004.json"), "not-json\n", "utf-8");
  const outbox = new DurableOutbox(path);

  await assert.rejects(outbox.drain(async () => undefined), /Corrupt outbox entry/);
  assert.equal(await outbox.pendingCount(), 1);
  await rm(path, { recursive: true, force: true });
});

test("durable outbox: rejects ids that could escape its directory", async () => {
  const path = tmpPath();
  const outbox = new DurableOutbox(path);
  await assert.rejects(outbox.enqueue({ ok: true }, "../outside"), /Invalid outbox id/);
  assert.equal(await outbox.pendingCount(), 0);
  await rm(path, { recursive: true, force: true });
});
