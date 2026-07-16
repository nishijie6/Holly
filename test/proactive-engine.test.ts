import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { HollyStateStore, localDateKey } from "../holly-state.js";
import {
  runProactiveTick,
  validateProactiveLine,
  findDroppedInterestThread,
  type ProactiveConfig,
  type ProactiveDecision,
  type ProactiveDeps,
  type ProactiveRevivalRequest,
  type ProactiveWorldObservation,
  type ProactiveTurn,
} from "../proactive-engine.js";

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const TTL = 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function tmpPath(): string {
  return join(tmpdir(), `holly-state-${randomUUID()}.json`);
}
function userTurn(content: string, ms: number, name = "A"): ProactiveTurn {
  return { role: "user", content, timestamp: iso(ms), senderName: name, userId: "1" };
}
function botTurn(content: string, ms: number): ProactiveTurn {
  return { role: "assistant", content, timestamp: iso(ms), senderName: null, userId: null };
}

function baseConfig(overrides: Partial<ProactiveConfig> = {}): ProactiveConfig {
  return {
    enabled: true,
    mode: "shadow",
    liveGroupAllowlist: [],
    lullMinMs: 10 * MIN,
    lullDeadzoneMs: 180 * MIN,
    interestWindowMs: 45 * MIN,
    perGroupDailyCap: 6,
    globalDailyCap: 20,
    cooldownMs: 30 * MIN,
    observationWindowMs: 15 * MIN,
    successWindowMs: 10 * MIN,
    backoffMultiplier: 1.5,
    engagedTtlMs: 60 * MIN,
    maxReplyChars: 80,
    interestKeywords: ["黑洞", "ai", "数学"],
    echoOnlyGroups: ["20000003"],
    ...overrides,
  };
}

const DEFAULT_DECISION: ProactiveDecision = {
  shouldReply: true,
  finalAnswer: "黑洞那段我也想接一句",
  thinkingProcess: "匹配兴趣(c)",
};

type Harness = {
  deps: ProactiveDeps;
  store: HollyStateStore;
  sends: Array<{ groupId: number; text: string }>;
  shadows: Record<string, unknown>[];
  appended: Array<{ groupKey: string; text: string }>;
  evalCalls: { n: number };
  evalRequests: ProactiveRevivalRequest[];
  observeCalls: { n: number };
};

async function makeHarness(opts: {
  groups: string[];
  getHistory: (groupKey: string, callIdx: number) => ProactiveTurn[];
  config?: Partial<ProactiveConfig>;
  decision?: ProactiveDecision | null;
  observation?: ProactiveWorldObservation | null;
  store?: HollyStateStore;
}): Promise<Harness> {
  const store = opts.store ?? (await HollyStateStore.load(tmpPath(), TTL));
  const sends: Harness["sends"] = [];
  const shadows: Harness["shadows"] = [];
  const appended: Harness["appended"] = [];
  const evalCalls = { n: 0 };
  const observeCalls = { n: 0 };
  const evalRequests: ProactiveRevivalRequest[] = [];
  const callIdx = new Map<string, number>();

  const deps: ProactiveDeps = {
    now: () => NOW,
    listGroups: () => opts.groups,
    getHistory: (groupKey) => {
      const idx = callIdx.get(groupKey) ?? 0;
      callIdx.set(groupKey, idx + 1);
      return opts.getHistory(groupKey, idx);
    },
    observeWorld: opts.observation === undefined
      ? undefined
      : async () => {
          observeCalls.n += 1;
          return opts.observation ?? null;
        },
    evaluateRevival: async (request) => {
      evalCalls.n += 1;
      evalRequests.push(request);
      return opts.decision === undefined ? DEFAULT_DECISION : opts.decision;
    },
    send: async (groupId, text) => {
      sends.push({ groupId, text });
      return null;
    },
    appendAssistantTurn: (groupKey, text) => {
      appended.push({ groupKey, text });
    },
    parseGroupId: (groupKey) => {
      const n = Number(groupKey);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    },
    log: () => {},
    shadowLog: (record) => {
      shadows.push(record);
    },
    config: baseConfig(opts.config),
    state: store,
  };
  return { deps, store, sends, shadows, appended, evalCalls, evalRequests, observeCalls };
}

// ── validateProactiveLine ────────────────────────────────────────────────────

test("validateProactiveLine: accepts a natural single line", () => {
  assert.equal(validateProactiveLine("黑洞那个我也想聊", 80).ok, true);
});
test("validateProactiveLine: rejects empty / multiline / @ spam / too long / question barrage", () => {
  assert.equal(validateProactiveLine("", 80).reason, "empty");
  assert.equal(validateProactiveLine("a\nb", 80).reason, "multiline");
  assert.equal(validateProactiveLine("[CQ:at,qq=123]来", 80).reason, "at_spam");
  assert.equal(validateProactiveLine("@123456 在吗", 80).reason, "at_spam");
  assert.equal(validateProactiveLine("x".repeat(200), 80).reason, "too_long");
  assert.equal(validateProactiveLine("真的？是吗？为啥？", 80).reason, "question_barrage");
});

// ── findDroppedInterestThread ────────────────────────────────────────────────

test("findDroppedInterestThread: empty history → null", () => {
  assert.equal(findDroppedInterestThread([], baseConfig()), null);
});
test("findDroppedInterestThread: interest keyword in window → thread", () => {
  const thread = findDroppedInterestThread([userTurn("聊聊黑洞吧", NOW - 20 * MIN)], baseConfig());
  assert.ok(thread);
  assert.equal(thread?.matchedKeyword, "黑洞");
  assert.match(thread?.summary ?? "", /黑洞/);
  // Cycle start = interest window start before the last message.
  assert.equal(thread?.windowStartMs, NOW - 20 * MIN - 45 * MIN);
});
test("findDroppedInterestThread: no interest keyword → null", () => {
  assert.equal(findDroppedInterestThread([userTurn("今天天气不错", NOW - 20 * MIN)], baseConfig()), null);
});
test("findDroppedInterestThread: interest turn older than the window → null", () => {
  const history = [userTurn("聊聊黑洞", NOW - 100 * MIN), userTurn("嗯", NOW - 20 * MIN)];
  // window = [last-45min, last] = [NOW-65min, NOW-20min]; the 黑洞 turn (NOW-100min) is excluded.
  assert.equal(findDroppedInterestThread(history, baseConfig()), null);
});
test("findDroppedInterestThread: assistant interest turn does not count (user-only)", () => {
  assert.equal(findDroppedInterestThread([botTurn("黑洞很有意思", NOW - 20 * MIN)], baseConfig()), null);
});

// ── runProactiveTick: skip conditions ────────────────────────────────────────

test("tick: lull too short → no model call, no shadow", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 5 * MIN)], // lull 5min < 10min
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 0);
  assert.equal(h.shadows.length, 0);
});

test("tick: echo-only group is skipped", async () => {
  const h = await makeHarness({
    groups: ["20000003"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)],
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 0);
});

test("tick: last turn is Holly → skip", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 25 * MIN), botTurn("我在", NOW - 20 * MIN)],
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 0);
});

test("tick: daily cap reached → skip before model call", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  const capped = store.getGroup("111");
  capped.dailyCount = 6; // == perGroupDailyCap
  capped.dailyDate = localDateKey(new Date(NOW)); // align with the tick's clock so rollDaily won't reset
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)],
    store,
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 0);
});

test("tick: cooldown active → skip", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  store.getGroup("111").lastProactiveAt = NOW - 5 * MIN; // < 30min cooldown
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)],
    store,
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 0);
});

test("tick: global cap exhausted → skip", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)],
    config: { globalDailyCap: 0 },
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 0);
});

// ── runProactiveTick: decision + output gates ────────────────────────────────

test("tick: valid candidate in shadow → logs, never sends, records state", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞吧", NOW - 20 * MIN)],
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 1);
  // Gate B gets the group + cycle start only — no re-quoted excerpt of the timeline.
  assert.deepEqual(h.evalRequests[0], {
    groupKey: "111",
    cycleStartMs: NOW - 20 * MIN - 45 * MIN,
    observationSummary: null,
  });
  assert.equal(h.shadows.length, 1);
  assert.equal(h.sends.length, 0); // shadow never sends
  assert.equal(h.store.getGroup("111").dailyCount, 1);
  assert.ok(h.store.getGroup("111").pendingObservation);
});

test("tick: browser observation is injected before model decision", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("ai news", NOW - 20 * MIN)],
    observation: {
      query: "ai latest",
      summary: "Browser found one relevant update.",
      urls: ["https://example.com/ai"],
    },
  });
  await runProactiveTick(h.deps);
  assert.equal(h.observeCalls.n, 1);
  assert.equal(h.evalCalls.n, 1);
  assert.equal(h.evalRequests[0].observationSummary, "Browser found one relevant update.");
  assert.deepEqual(h.shadows[0].worldObservation, {
    query: "ai latest",
    urls: ["https://example.com/ai"],
    cached: false,
  });
});

test("tick: model says no → no shadow, no state mutation", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)],
    decision: { shouldReply: false, finalAnswer: "", thinkingProcess: "没东西可补" },
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 1);
  assert.equal(h.shadows.length, 0);
  assert.equal(h.store.getGroup("111").dailyCount, 0);
});

test("tick: invalid model output (multiline) → dropped, not logged as send", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)],
    decision: { shouldReply: true, finalAnswer: "第一行\n第二行", thinkingProcess: "x" },
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 1);
  assert.equal(h.shadows.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.getGroup("111").dailyCount, 0);
});

// ── runProactiveTick: live mode + send-time re-check (1A) ─────────────────────

test("tick: live + allowlisted + stable history → sends and records the turn", async () => {
  const h = await makeHarness({
    groups: ["111"],
    getHistory: () => [userTurn("聊聊黑洞", NOW - 20 * MIN)], // same on both calls
    config: { mode: "live", liveGroupAllowlist: ["111"] },
  });
  await runProactiveTick(h.deps);
  assert.equal(h.sends.length, 1);
  assert.equal(h.appended.length, 1);
  assert.equal(h.store.getGroup("111").dailyCount, 1);
});

test("tick: live re-check aborts when a new message arrived since eval", async () => {
  const h = await makeHarness({
    groups: ["111"],
    // call 0 (eval): quiet for 20min. call 1 (re-check): a fresh user message just landed.
    getHistory: (_g, idx) =>
      idx === 0
        ? [userTurn("聊聊黑洞", NOW - 20 * MIN)]
        : [userTurn("聊聊黑洞", NOW - 20 * MIN), userTurn("新消息来了", NOW - 30 * 1000)],
    config: { mode: "live", liveGroupAllowlist: ["111"] },
  });
  await runProactiveTick(h.deps);
  assert.equal(h.evalCalls.n, 1); // model was consulted
  assert.equal(h.sends.length, 0); // but send aborted by the 1A re-check
});

// ── runProactiveTick: observation settlement (2A) ─────────────────────────────

test("tick: pending observation with a user reply in-window → success, backoff reset", async () => {
  const store = await HollyStateStore.load(tmpPath(), TTL);
  store.recordProactive("111", "黑洞:1", NOW - 2 * MIN);
  store.getGroup("111").backoffLevel = 2;
  const h = await makeHarness({
    groups: ["111"],
    // last turn is a user reply 30s ago → lull < lullMin (no new candidate), but
    // it falls inside the success window after the proactive send → engaged.
    getHistory: () => [userTurn("对啊黑洞", NOW - 30 * 1000)],
    store,
  });
  await runProactiveTick(h.deps);
  assert.equal(h.store.getGroup("111").pendingObservation, null);
  assert.equal(h.store.getGroup("111").backoffLevel, 0);
  await rm(tmpPath(), { force: true }).catch(() => {});
});
