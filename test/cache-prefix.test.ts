import assert from "node:assert/strict";
import test from "node:test";

import {
  CachePrefixTracker,
  buildCachePrefixDigest,
  describeCachePrefixDrift,
} from "../cache-prefix.js";
import { buildClaudeRequestBody, digestClaudeCachedPrefix } from "../llm-client.js";

const SYSTEM = "You are Holly. Persona and decision protocol only.";

function replyRequest(turns: readonly string[], volatileTail: string): Record<string, unknown> {
  return buildClaudeRequestBody(
    "claude-sonnet-4-6",
    SYSTEM,
    [
      ...turns.map((content, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content,
      })),
      { role: "user" as const, content: volatileTail },
    ],
    { cacheStablePrefix: true, volatileTailMessages: 1 },
  );
}

test("a new volatile tail on the same history keeps the prefix identical", () => {
  const tracker = new CachePrefixTracker();
  const turns = ["群友A: 在吗", "在", "群友A: 帮我查个东西"];

  const first = tracker.inspect("reply:123", digestClaudeCachedPrefix(replyRequest(turns, "现在 14:05")));
  assert.equal(first.status, "fresh");

  // Only the tail changed: the timestamp and the current scan live after the
  // breakpoint, which is the whole point of the volatile-tail split.
  const second = tracker.inspect("reply:123", digestClaudeCachedPrefix(replyRequest(turns, "现在 14:37")));
  assert.equal(second.status, "unchanged");
});

test("appending a turn extends the prefix instead of breaking it", () => {
  const tracker = new CachePrefixTracker();
  const turns = ["群友A: 在吗", "在"];
  tracker.inspect("reply:123", digestClaudeCachedPrefix(replyRequest(turns, "tail")));

  const grown = tracker.inspect(
    "reply:123",
    digestClaudeCachedPrefix(replyRequest([...turns, "群友A: 那算了"], "tail")),
  );
  assert.equal(grown.status, "extended");
  assert.ok(grown.currentBlocks > grown.previousBlocks);
});

test("a volatile value that reaches the cached history is reported with the block that moved", () => {
  const tracker = new CachePrefixTracker();
  tracker.inspect(
    "reply:123",
    digestClaudeCachedPrefix(replyRequest(["群友A: 在吗", "在", "群友A: 好"], "tail")),
  );

  // The regression this guards against: a per-request timestamp rendered into
  // a history turn instead of the tail.
  const drifted = tracker.inspect(
    "reply:123",
    digestClaudeCachedPrefix(replyRequest(["群友A: 在吗 (14:37)", "在", "群友A: 好"], "tail")),
  );
  assert.equal(drifted.status, "rebuilt");
  assert.equal(drifted.systemChanged, false);
  assert.equal(drifted.divergedAt, 0);
  assert.match(describeCachePrefixDrift(drifted), /block #0/);
});

test("editing the system prompt invalidates every route, and says so", () => {
  const tracker = new CachePrefixTracker();
  const turns = ["群友A: 在吗", "在"];
  tracker.inspect("reply:123", digestClaudeCachedPrefix(replyRequest(turns, "tail")));

  const body = buildClaudeRequestBody(
    "claude-sonnet-4-6",
    `${SYSTEM}\n新增一条规则。`,
    [...turns.map((content, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content,
    })), { role: "user" as const, content: "tail" }],
    { cacheStablePrefix: true, volatileTailMessages: 1 },
  );

  const drifted = tracker.inspect("reply:123", digestClaudeCachedPrefix(body));
  assert.equal(drifted.status, "rebuilt");
  assert.equal(drifted.systemChanged, true);
  assert.match(describeCachePrefixDrift(drifted), /system prefix changed/);
});

test("compression that drops old turns reads as a rebuild, not as an append", () => {
  const tracker = new CachePrefixTracker();
  tracker.inspect(
    "reply:123",
    digestClaudeCachedPrefix(replyRequest(["一", "二", "三", "四"], "tail")),
  );

  const compacted = tracker.inspect(
    "reply:123",
    digestClaudeCachedPrefix(replyRequest(["三", "四"], "tail")),
  );
  assert.equal(compacted.status, "rebuilt");
});

test("routes are independent: two groups do not report each other as drift", () => {
  const tracker = new CachePrefixTracker();
  tracker.inspect("reply:123", digestClaudeCachedPrefix(replyRequest(["群 123 的历史"], "tail")));
  const other = tracker.inspect(
    "reply:456",
    digestClaudeCachedPrefix(replyRequest(["群 456 的历史"], "tail")),
  );
  assert.equal(other.status, "fresh");

  const back = tracker.inspect("reply:123", digestClaudeCachedPrefix(replyRequest(["群 123 的历史"], "tail")));
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

test("the digest covers exactly the blocks inside the breakpoint", () => {
  // Two requests whose only difference is after the cache breakpoint must hash
  // identically, or the guard would cry drift on every single request.
  const a = digestClaudeCachedPrefix(replyRequest(["历史一", "历史二"], "当前消息 A"));
  const b = digestClaudeCachedPrefix(replyRequest(["历史一", "历史二"], "当前消息 B"));
  assert.deepEqual(a, b);
});
