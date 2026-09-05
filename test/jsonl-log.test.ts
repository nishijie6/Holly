import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { JsonlLog } from "../jsonl-log.js";

// The properties the five hand-rolled copies were each trying to have, pinned
// once. Callers are fire-and-forget, so anything this class gets wrong is
// invisible at the call site and shows up as a corrupt file much later.

const tmpPath = () => join(tmpdir(), `jsonl-log-${randomUUID()}`, "log.jsonl");

test("records land one per line, in order", async () => {
  const path = tmpPath();
  const log = new JsonlLog(path, "test log");
  log.append({ n: 1 });
  log.append({ n: 2 });
  log.append({ n: 3 });
  await log.flush();

  const lines = (await readFile(path, "utf-8")).trim().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l).n), [1, 2, 3]);
  await rm(join(path, ".."), { recursive: true, force: true });
});

test("the directory is created on demand", async () => {
  const path = tmpPath();
  const log = new JsonlLog(path, "test log");
  log.append({ ok: true });
  await log.flush();
  assert.match(await readFile(path, "utf-8"), /"ok":true/);
  await rm(join(path, ".."), { recursive: true, force: true });
});

test("many concurrent appends never interleave inside a line", async () => {
  const path = tmpPath();
  const log = new JsonlLog(path, "test log");
  for (let i = 0; i < 200; i += 1) log.append({ i, pad: "x".repeat(200) });
  await log.flush();

  const lines = (await readFile(path, "utf-8")).trim().split("\n");
  assert.equal(lines.length, 200);
  // Every line parses, which is what interleaving would break.
  assert.deepEqual(lines.map((l) => JSON.parse(l).i), Array.from({ length: 200 }, (_, i) => i));
  await rm(join(path, ".."), { recursive: true, force: true });
});

test("a failed write does not stop later records", async () => {
  const dir = join(tmpdir(), `jsonl-log-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  // A directory where the log file should be: the first write cannot succeed.
  const path = join(dir, "log.jsonl");
  await mkdir(path, { recursive: true });

  const errors: string[] = [];
  const log = new JsonlLog(path, "wedged log", (message) => errors.push(message));
  log.append({ n: 1 });
  await log.flush();
  assert.equal(errors.length, 1, "the failure was reported");

  // Now make the path writable and confirm the queue still works.
  await rm(path, { recursive: true, force: true });
  log.append({ n: 2 });
  await log.flush();
  assert.match(await readFile(path, "utf-8"), /"n":2/);
  await rm(dir, { recursive: true, force: true });
});

test("failures name the log, because the caller never sees the rejection", async () => {
  const dir = join(tmpdir(), `jsonl-log-${randomUUID()}`);
  const path = join(dir, "log.jsonl");
  await mkdir(path, { recursive: true });

  const messages: string[] = [];
  const log = new JsonlLog(path, "ai-tone shadow log", (message) => messages.push(message));
  log.append({ n: 1 });
  await log.flush();
  assert.match(messages[0], /ai-tone shadow log/);
  await rm(dir, { recursive: true, force: true });
});

test("append never throws at the call site", async () => {
  const log = new JsonlLog("/proc/definitely/not/writable/log.jsonl", "unwritable", () => {});
  // A log write must not be the reason the thing being logged fails.
  assert.doesNotThrow(() => log.append({ n: 1 }));
  await log.flush();
});

test("two logs do not share a queue", async () => {
  // The bug this class replaces: three appenders chained onto a fourth's queue,
  // so unrelated files serialized behind one another.
  const dirA = join(tmpdir(), `jsonl-log-${randomUUID()}`);
  const wedged = join(dirA, "log.jsonl");
  await mkdir(wedged, { recursive: true });
  const stuck = new JsonlLog(wedged, "wedged", () => {});

  const healthyPath = tmpPath();
  const healthy = new JsonlLog(healthyPath, "healthy");

  stuck.append({ n: 1 });
  healthy.append({ n: 2 });
  await Promise.all([stuck.flush(), healthy.flush()]);

  assert.match(await readFile(healthyPath, "utf-8"), /"n":2/);
  await rm(dirA, { recursive: true, force: true });
  await rm(join(healthyPath, ".."), { recursive: true, force: true });
});

test("flush on an idle log resolves immediately", async () => {
  const log = new JsonlLog(tmpPath(), "idle");
  await log.flush();
});

test("appending to an existing file adds to it rather than replacing it", async () => {
  const path = tmpPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify({ n: 0 })}\n`, "utf-8");

  const log = new JsonlLog(path, "test log");
  log.append({ n: 1 });
  await log.flush();

  const lines = (await readFile(path, "utf-8")).trim().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l).n), [0, 1]);
  await rm(join(path, ".."), { recursive: true, force: true });
});
