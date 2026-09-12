import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

import { DEFAULT_LEDGER_STORE_OPTIONS, LedgerStore } from "../ledger-store.js";
import { ConversationLedger } from "../conversation-ledger.js";
import type { LlmMessage } from "../llm-client.js";

// Durability for the ledger. The risk this guards is specific: a restore that
// half-works is worse than one that does not run, because a transcript missing
// a tool_use id, or silently truncated at the front, produces a 400 or a
// rebuilt cache prefix far from the code that caused it.

const OPTS = DEFAULT_LEDGER_STORE_OPTIONS;
const tmpPath = () => join(tmpdir(), `holly-ledger-${randomUUID()}.jsonl`);

const toolTurn: LlmMessage = {
  role: "assistant",
  content: "checking",
  blocks: [{ type: "tool_use", id: "tu_1", name: "open_conversation", input: { id: "20000001" } }],
};
const resultTurn: LlmMessage = {
  role: "user",
  content: "",
  blocks: [{ type: "tool_result", toolUseId: "tu_1", content: "recent messages" }],
};

test("a missing file restores an empty ledger, not an error", async () => {
  const { outcome } = await LedgerStore.load(tmpPath(), OPTS);
  assert.deepEqual(outcome, { messages: [], rejected: null, recordCount: 0 });
});

test("turns round trip in order", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await store.append({ role: "user", content: "第一条" });
  await store.append({ role: "assistant", content: "第二条" });

  const { outcome } = await LedgerStore.load(path, OPTS);
  assert.equal(outcome.rejected, null);
  assert.deepEqual(outcome.messages.map((m) => `${m.role}:${m.content}`), [
    "user:第一条",
    "assistant:第二条",
  ]);
  await rm(path, { force: true });
});

test("tool blocks round trip with their ids intact", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await store.append({ role: "user", content: "看一下" });
  await store.append(toolTurn);
  await store.append(resultTurn);

  const { outcome } = await LedgerStore.load(path, OPTS);
  // The ids are the only thing pairing the two halves; a restore that loses
  // them 400s the next request.
  assert.deepEqual(outcome.messages[1].blocks, toolTurn.blocks);
  assert.deepEqual(outcome.messages[2].blocks, resultTurn.blocks);

  // And the restored transcript is one the ledger accepts as settled.
  const ledger = new ConversationLedger();
  ledger.restore(outcome.messages);
  assert.equal(ledger.size, 3);
  assert.deepEqual([...ledger.pendingToolUses], []);
  await rm(path, { force: true });
});

test("a torn final line costs only that line", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await store.append({ role: "user", content: "完整的一条" });
  // Simulate a crash mid-write.
  await writeFile(path, `${await readFile(path, "utf-8")}{"at":"2026-09-04T00:00:00Z","mess`, "utf-8");

  const { outcome } = await LedgerStore.load(path, OPTS);
  assert.equal(outcome.messages.length, 1);
  assert.equal(outcome.messages[0].content, "完整的一条");
  await rm(path, { force: true });
});

test("a tool turn that lost blocks is dropped rather than replayed as prose", async () => {
  const path = tmpPath();
  // blocks present but one is unparseable (missing id): replaying the prose
  // alone would silently change what the model was answering.
  await writeFile(path, `${JSON.stringify({
    at: new Date().toISOString(),
    message: { role: "assistant", content: "checking", blocks: [{ type: "tool_use", name: "no_id" }] },
  })}\n`, "utf-8");

  const { outcome } = await LedgerStore.load(path, OPTS);
  assert.deepEqual(outcome.messages, []);
  await rm(path, { force: true });
});

// --- the two bounds --------------------------------------------------------

test("a stale transcript is archived and handed back for summarizing, not restored", async () => {
  const path = tmpPath();
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await writeFile(path, `${JSON.stringify({ at: old, message: { role: "user", content: "昨天的话" } })}\n`, "utf-8");

  const { store, outcome } = await LedgerStore.load(path, OPTS);
  assert.equal(outcome.rejected, "stale");
  // 过期的上下文不能原样恢复，只交还给调用方去整理成摘要。
  assert.deepEqual(outcome.messages, []);
  assert.equal(outcome.recordCount, 1);
  assert.deepEqual(outcome.staleTranscript?.messages.map((m) => m.content), ["昨天的话"]);

  // 旧文件改名存档，原路径空出来：下次启动不会再读到它、再判一次过期。
  const archivedTo = outcome.staleTranscript?.archivedTo ?? "";
  assert.notEqual(archivedTo, path);
  assert.match(await readFile(archivedTo, "utf-8"), /昨天的话/u);
  await assert.rejects(readFile(path, "utf-8"));
  assert.deepEqual((await LedgerStore.load(path, OPTS)).outcome, { messages: [], rejected: null, recordCount: 0 });

  // 新账本就从原路径接着追加。
  await store.append({ role: "user", content: "今天的话" });
  assert.deepEqual((await LedgerStore.load(path, OPTS)).outcome.messages.map((m) => m.content), ["今天的话"]);
  await rm(path, { force: true });
  await rm(archivedTo, { force: true });
});

test("an oversized transcript is rejected whole, never truncated at the front", async () => {
  const path = tmpPath();
  const now = new Date().toISOString();
  const lines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ at: now, message: { role: "user", content: `第${i}条` } })).join("\n");
  await writeFile(path, `${lines}\n`, "utf-8");

  const { outcome } = await LedgerStore.load(path, { maxAgeMs: OPTS.maxAgeMs, maxMessages: 3 });
  // Keeping the newest 3 would be compaction: it breaks the prefix, and doing
  // it silently inside a restore is the invisible rewrite the ledger forbids.
  assert.equal(outcome.rejected, "too-large");
  assert.deepEqual(outcome.messages, []);
  assert.equal(outcome.recordCount, 5);
  await rm(path, { force: true });
});

test("a transcript inside both bounds is restored", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await store.append({ role: "user", content: "刚刚的话" });

  const { outcome } = await LedgerStore.load(path, OPTS);
  assert.equal(outcome.rejected, null);
  assert.equal(outcome.messages.length, 1);
  await rm(path, { force: true });
});

test("reset clears the transcript and appends start over", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await store.append({ role: "user", content: "旧的" });
  await store.reset();
  await store.append({ role: "user", content: "新的" });

  const { outcome } = await LedgerStore.load(path, OPTS);
  assert.deepEqual(outcome.messages.map((m) => m.content), ["新的"]);
  await rm(path, { force: true });
});

test("concurrent appends do not interleave inside a line", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.append({ role: "user", content: `第${i}条` })),
  );

  const { outcome } = await LedgerStore.load(path, OPTS);
  assert.equal(outcome.messages.length, 20, "every line parsed, so none were torn by interleaving");
  await rm(path, { force: true });
});

// --- realigning disk with memory -------------------------------------------

test("rewrite realigns the log after restore dropped an unanswered tool turn", async () => {
  const path = tmpPath();
  const { store } = await LedgerStore.load(path, OPTS);
  await store.append({ role: "user", content: "看一下" });
  await store.append(toolTurn); // trailing, unanswered — a crash mid tool call

  const first = await LedgerStore.load(path, OPTS);
  const ledger = new ConversationLedger();
  ledger.restore(first.outcome.messages);
  assert.equal(first.outcome.messages.length, 2);
  assert.equal(ledger.size, 1, "the unanswered tool turn is dropped from memory");

  await first.store.rewrite(ledger.snapshot());
  await first.store.append({ role: "user", content: "新的一批消息" });

  // Without the rewrite, the orphaned tool_use would now sit in the middle of
  // the transcript — no longer trailing, so no longer dropped — and replay into
  // a 400 on the next request.
  const second = await LedgerStore.load(path, OPTS);
  const reloaded = new ConversationLedger();
  reloaded.restore(second.outcome.messages);
  assert.deepEqual(second.outcome.messages.map((m) => m.content), ["看一下", "新的一批消息"]);
  assert.equal(reloaded.snapshot().some((m) => (m.blocks ?? []).some((b) => b.type === "tool_use")), false);
  await rm(path, { force: true });
});

test("the ledger's append sink sees every turn exactly once", async () => {
  const seen: string[] = [];
  const ledger = new ConversationLedger({ onAppend: (m) => seen.push(`${m.role}:${m.content}`) });
  ledger.appendUserText("一");
  ledger.appendAssistantTurn("二");
  ledger.appendUserText("三");
  assert.deepEqual(seen, ["user:一", "assistant:二", "user:三"]);
});

test("restore does not re-notify the sink, so the log does not double each boot", async () => {
  const seen: string[] = [];
  const ledger = new ConversationLedger({ onAppend: (m) => seen.push(m.content) });
  ledger.restore([{ role: "user", content: "从磁盘来的" }]);
  assert.deepEqual(seen, [], "restored turns are already on disk");
  ledger.appendUserText("新的");
  assert.deepEqual(seen, ["新的"]);
});
