import assert from "node:assert/strict";
import test from "node:test";

import {
  CachePrefixTracker,
  buildCachePrefixDigest,
  describeCachePrefixDrift,
} from "../cache-prefix.js";
import { buildCodexRequestBody, digestCodexCachedPrefix } from "../llm-client.js";

const SYSTEM = "You are Holly. Persona and decision protocol only.";

function replyRequest(turns: readonly string[], volatileTail: string): Record<string, unknown> {
  return buildCodexRequestBody(
    "gpt-6.1-sol",
    SYSTEM,
    [
      ...turns.map((content, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content,
      })),
      { role: "user" as const, content: volatileTail },
    ],
    { volatileTailMessages: 1 },
  );
}

test("a new volatile tail on the same history keeps the prefix identical", () => {
  const tracker = new CachePrefixTracker();
  const turns = ["群友A: 在吗", "在", "群友A: 帮我查个东西"];

  const first = tracker.inspect("reply:123", digestCodexCachedPrefix(replyRequest(turns, "现在 14:05")));
  assert.equal(first.status, "fresh");

  // Only the tail changed: the timestamp and the current scan live after the
  // tracked stable prefix, which is the point of the volatile-tail split.
  const second = tracker.inspect("reply:123", digestCodexCachedPrefix(replyRequest(turns, "现在 14:37")));
  assert.equal(second.status, "unchanged");
});

test("appending a turn extends the prefix instead of breaking it", () => {
  const tracker = new CachePrefixTracker();
  const turns = ["群友A: 在吗", "在"];
  tracker.inspect("reply:123", digestCodexCachedPrefix(replyRequest(turns, "tail")));

  const grown = tracker.inspect(
    "reply:123",
    digestCodexCachedPrefix(replyRequest([...turns, "群友A: 那算了"], "tail")),
  );
  assert.equal(grown.status, "extended");
  assert.ok(grown.currentBlocks > grown.previousBlocks);
});

test("a volatile value that reaches the stable history is reported with the block that moved", () => {
  const tracker = new CachePrefixTracker();
  tracker.inspect(
    "reply:123",
    digestCodexCachedPrefix(replyRequest(["群友A: 在吗", "在", "群友A: 好"], "tail")),
  );

  // The regression this guards against: a per-request timestamp rendered into
  // a history turn instead of the tail.
  const drifted = tracker.inspect(
    "reply:123",
    digestCodexCachedPrefix(replyRequest(["群友A: 在吗 (14:37)", "在", "群友A: 好"], "tail")),
  );
  assert.equal(drifted.status, "rebuilt");
  assert.equal(drifted.systemChanged, false);
  assert.equal(drifted.divergedAt, 0);
  assert.match(describeCachePrefixDrift(drifted), /block #0/);
});

test("editing the system prompt is reported as a system prefix change", () => {
  const tracker = new CachePrefixTracker();
  const turns = ["群友A: 在吗", "在"];
  tracker.inspect("reply:123", digestCodexCachedPrefix(replyRequest(turns, "tail")));

  const body = buildCodexRequestBody(
    "gpt-6.1-sol",
    `${SYSTEM}\n新增一条规则。`,
    [...turns.map((content, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content,
    })), { role: "user" as const, content: "tail" }],
    { volatileTailMessages: 1 },
  );

  const drifted = tracker.inspect("reply:123", digestCodexCachedPrefix(body));
  assert.equal(drifted.status, "rebuilt");
  assert.equal(drifted.systemChanged, true);
  assert.match(describeCachePrefixDrift(drifted), /system prefix changed/);
});

test("compression that drops old turns reads as a rebuild, not as an append", () => {
  const tracker = new CachePrefixTracker();
  tracker.inspect(
    "reply:123",
    digestCodexCachedPrefix(replyRequest(["一", "二", "三", "四"], "tail")),
  );

  const compacted = tracker.inspect(
    "reply:123",
    digestCodexCachedPrefix(replyRequest(["三", "四"], "tail")),
  );
  assert.equal(compacted.status, "rebuilt");
});

test("routes are independent: two groups do not report each other as drift", () => {
  const tracker = new CachePrefixTracker();
  tracker.inspect("reply:123", digestCodexCachedPrefix(replyRequest(["群 123 的历史"], "tail")));
  const other = tracker.inspect(
    "reply:456",
    digestCodexCachedPrefix(replyRequest(["群 456 的历史"], "tail")),
  );
  assert.equal(other.status, "fresh");

  const back = tracker.inspect("reply:123", digestCodexCachedPrefix(replyRequest(["群 123 的历史"], "tail")));
  assert.equal(back.status, "unchanged");
});

test("the oldest route is evicted rather than growing without bound", () => {
  const tracker = new CachePrefixTracker(2);
  const digest = buildCachePrefixDigest(["system"], ["a"]);
  tracker.inspect("one", digest);
  tracker.inspect("two", digest);
  tracker.inspect("three", digest);

  // "one" was pushed out, so it is unknown again — reported as fresh, never as
  // a false drift.
  assert.equal(tracker.inspect("one", digest).status, "fresh");
  assert.equal(tracker.inspect("three", digest).status, "unchanged");
});

test("the digest covers exactly the stable request history", () => {
  // Two requests whose only difference is in the volatile tail must hash
  // identically, or the guard would cry drift on every single request.
  const a = digestCodexCachedPrefix(replyRequest(["历史一", "历史二"], "当前消息 A"));
  const b = digestCodexCachedPrefix(replyRequest(["历史一", "历史二"], "当前消息 B"));
  assert.deepEqual(a, b);
});

test("volatile history stays in the Codex request while being excluded from the digest", () => {
  const body = replyRequest(["稳定的历史"], "现在 14:37，处理新消息");
  const input = body.input as Array<Record<string, unknown>>;

  assert.equal(input.length, 2);
  assert.equal(input[1].content, "现在 14:37，处理新消息");
  assert.equal(digestCodexCachedPrefix(body).blockDigests.length, 1);
});

test("a volatile tool turn excludes all of its wire items from the digest", () => {
  const request = (id: string, now: string) => buildCodexRequestBody(
    "gpt-6.1-sol",
    SYSTEM,
    [
      { role: "user", content: "稳定的历史" },
      {
        role: "assistant",
        content: `查看当前会话 ${now}`,
        blocks: [{ type: "tool_use", id, name: "open_conversation", input: { id: now } }],
      },
    ],
    { volatileTailMessages: 1 },
  );
  const first = request("call_a", "14:05");
  const second = request("call_b", "14:37");

  assert.equal((first.input as unknown[]).length, 3, "prose and the tool call remain separate wire items");
  assert.equal(digestCodexCachedPrefix(first).blockDigests.length, 1);
  assert.deepEqual(digestCodexCachedPrefix(first), digestCodexCachedPrefix(second));
});

test("editing a tool definition changes the system prefix digest", () => {
  const tracker = new CachePrefixTracker();
  const request = (description: string) => buildCodexRequestBody(
    "gpt-6.1-sol",
    SYSTEM,
    [{ role: "user", content: "历史" }],
    { tools: [{ name: "open_conversation", description, inputSchema: { type: "object", properties: {} } }] },
  );
  tracker.inspect("focus", digestCodexCachedPrefix(request("打开一个会话")));

  const changed = tracker.inspect("focus", digestCodexCachedPrefix(request("打开一个会话并显示历史")));
  assert.equal(changed.status, "rebuilt");
  assert.equal(changed.systemChanged, true);
});

test("StablePrefixLedger tells a deliberate prefix change from a surprise", async () => {
  const { StablePrefixLedger } = await import("../cache-prefix.js");
  const ledger = new StablePrefixLedger();

  // First call on a route has no history — the inspection reports "fresh", not
  // "rebuilt", so there is nothing to excuse.
  assert.equal(ledger.changed("memory-reflection", ["指令", "观察 A"]), false);
  // Same rolling window on the next tick: a rebuild here would be real drift.
  assert.equal(ledger.changed("memory-reflection", ["指令", "观察 A"]), false);
  // 窗口起点移动，前面的块变了——这次重建是我们自己造成的。
  assert.equal(ledger.changed("memory-reflection", ["指令", "观察 B"]), true);
  assert.equal(ledger.changed("memory-reflection", ["指令", "观察 B"]), false);
});

// 窗口里多了一条观察，只是在后面多一块，不该记成重建。
test("StablePrefixLedger does not call an appended block a change, but a shorter list is one", async () => {
  const { StablePrefixLedger } = await import("../cache-prefix.js");
  const ledger = new StablePrefixLedger();

  ledger.changed("archive-composition", ["指令", "观察 A"]);
  assert.equal(ledger.changed("archive-composition", ["指令", "观察 A", "观察 B"]), false);
  // 变短同样是重建：原来的稳定前缀包含更多块。
  assert.equal(ledger.changed("archive-composition", ["指令", "观察 A"]), true);
});

test("StablePrefixLedger keeps routes apart", async () => {
  const { StablePrefixLedger } = await import("../cache-prefix.js");
  const ledger = new StablePrefixLedger();

  assert.equal(ledger.changed("memory-reflection", ["window A"]), false);
  assert.equal(ledger.changed("archive-composition", ["window A"]), false);
  assert.equal(ledger.changed("memory-reflection", ["window B"]), true);
  // The other route never saw window B, so its own history is untouched.
  assert.equal(ledger.changed("archive-composition", ["window A"]), false);
});

test("StablePrefixLedger is bounded and forgets the oldest route first", async () => {
  const { StablePrefixLedger } = await import("../cache-prefix.js");
  const ledger = new StablePrefixLedger(2);

  ledger.changed("a", ["x"]);
  ledger.changed("b", ["x"]);
  ledger.changed("c", ["x"]);   // evicts "a"
  // "a" was dropped, so it reads as a first call again rather than a change.
  assert.equal(ledger.changed("a", ["y"]), false);
});

// 稳定段按块发，前缀诊断才会是「延长」而不是「重建」。这一条守的是 CachePrefixTracker
// 的判定本身，跟哪条管线在用它无关——记忆反思那个调用者已经退役（写记忆成了她手边的子工具），
// 但结论对任何「稳定段会往后追加」的路径都一样成立，所以换成普通数据留下来。
test("a growing stable half extends the prefix when sent as blocks, and rebuilds when joined", () => {
  const blocks = ["第一块", "第二块"];
  const grown = [...blocks, "第三块"];
  const request = (stableBlocks: string[], asOneMessage: boolean) => {
    const stable = asOneMessage ? [stableBlocks.join("\n\n")] : stableBlocks;
    return buildCodexRequestBody(
      "gpt-6.1-sol",
      "系统提示",
      [
        ...stable.map((content) => ({ role: "user" as const, content })),
        { role: "user" as const, content: "这一条是易变尾部" },
      ],
      { volatileTailMessages: 1 },
    );
  };

  // 按块发：多一块就是往后追加，稳定前缀逐块不变。
  const split = new CachePrefixTracker();
  split.inspect("probe", digestCodexCachedPrefix(request(blocks, false)));
  assert.equal(split.inspect("probe", digestCodexCachedPrefix(request(grown, false))).status, "extended");

  // 拼成一条：同样的变化落在同一块里，那一块的摘要变了，诊断报告前缀重建。
  const joined = new CachePrefixTracker();
  joined.inspect("probe", digestCodexCachedPrefix(request(blocks, true)));
  assert.equal(joined.inspect("probe", digestCodexCachedPrefix(request(grown, true))).status, "rebuilt");
});
