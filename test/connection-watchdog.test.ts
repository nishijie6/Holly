import { test } from "node:test";
import assert from "node:assert/strict";

import * as watchdogModule from "../connection-watchdog.js";

const { ConnectionWatchdog } = watchdogModule;

type FailurePolicyApi = {
  LlmHttpError: new (provider: string, status: number, detail: string, retryAt: number | null) => Error & {
    status: number;
    retryAt: number | null;
  };
  LlmRateLimitPauseError: new (provider: string, retryAt: number) => Error & { retryAt: number };
  ProviderRateLimitGate: new (options: {
    provider: string;
    now: () => number;
    fallbackPauseMs: number;
  }) => {
    assertOpen(): void;
    beginRequest(): number;
    recordSuccess(requestRevision: number): void;
    pauseUntil(retryAt: number | null): number;
    getPausedUntil(): number | null;
  };
  shouldCountTowardConnectionWatchdog(error: unknown): boolean;
  shouldRetryLlmCall(error: unknown): boolean;
};

function failurePolicy(): FailurePolicyApi {
  const candidate = watchdogModule as unknown as Record<string, unknown>;
  assert.equal(typeof candidate.LlmHttpError, "function");
  assert.equal(typeof candidate.LlmRateLimitPauseError, "function");
  assert.equal(typeof candidate.ProviderRateLimitGate, "function");
  assert.equal(typeof candidate.shouldCountTowardConnectionWatchdog, "function");
  assert.equal(typeof candidate.shouldRetryLlmCall, "function");
  return candidate as unknown as FailurePolicyApi;
}

test("recordFailure returns false below the threshold", () => {
  const watchdog = new ConnectionWatchdog({ consecutiveFailureThreshold: 3 });
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.getConsecutiveFailures(), 2);
});

test("recordFailure returns true exactly once when the streak reaches the threshold", () => {
  const watchdog = new ConnectionWatchdog({ consecutiveFailureThreshold: 3 });
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.recordFailure(), true);
  // Streak keeps growing past the threshold, but it only fires once per streak.
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.getConsecutiveFailures(), 4);
});

test("recordSuccess resets the streak so a later failure run starts fresh", () => {
  const watchdog = new ConnectionWatchdog({ consecutiveFailureThreshold: 3 });
  watchdog.recordFailure();
  watchdog.recordFailure();
  watchdog.recordSuccess();
  assert.equal(watchdog.getConsecutiveFailures(), 0);
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.recordFailure(), false);
  assert.equal(watchdog.recordFailure(), true);
});

test("a non-positive configured threshold is clamped to 1", () => {
  const watchdog = new ConnectionWatchdog({ consecutiveFailureThreshold: 0 });
  assert.equal(watchdog.recordFailure(), true);
});

test("HTTP responses and local rate-limit pauses never count as broken connections", () => {
  const {
    LlmHttpError,
    LlmRateLimitPauseError,
    shouldCountTowardConnectionWatchdog,
  } = failurePolicy();

  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmHttpError("codex", 429, "limited", 2_000)),
    false,
  );
  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmHttpError("codex", 401, "expired", null)),
    false,
  );
  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmHttpError("codex", 503, "overloaded", null)),
    false,
  );
  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmRateLimitPauseError("codex", 2_000)),
    false,
  );
  assert.equal(shouldCountTowardConnectionWatchdog(new TypeError("fetch failed")), true);
  assert.equal(shouldCountTowardConnectionWatchdog(new Error("Codex credentials not found")), false);
  assert.equal(shouldCountTowardConnectionWatchdog(new SyntaxError("bad config")), false);
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(shouldCountTowardConnectionWatchdog(timeout), true);
});

test("rate-limit gate suppresses requests until the server reset time", () => {
  const { LlmRateLimitPauseError, ProviderRateLimitGate } = failurePolicy();
  let now = 1_000;
  const gate = new ProviderRateLimitGate({
    provider: "codex",
    now: () => now,
    fallbackPauseMs: 500,
  });

  assert.doesNotThrow(() => gate.assertOpen());
  assert.equal(gate.pauseUntil(2_000), 2_000);
  assert.equal(gate.getPausedUntil(), 2_000);
  assert.throws(
    () => gate.assertOpen(),
    (error: unknown) => error instanceof LlmRateLimitPauseError && error.retryAt === 2_000,
  );

  now = 2_000;
  assert.doesNotThrow(() => gate.assertOpen());
  assert.equal(gate.getPausedUntil(), null);
});

test("rate-limit gate applies a bounded fallback when reset headers are missing", () => {
  const { ProviderRateLimitGate } = failurePolicy();
  const gate = new ProviderRateLimitGate({
    provider: "codex",
    now: () => 10_000,
    fallbackPauseMs: 300_000,
  });

  assert.equal(gate.pauseUntil(null), 310_000);
});

test("a success from an older overlapping request cannot clear a newer rate-limit pause", () => {
  const { LlmRateLimitPauseError, ProviderRateLimitGate } = failurePolicy();
  let now = 1_000;
  const gate = new ProviderRateLimitGate({ provider: "codex", now: () => now, fallbackPauseMs: 500 });
  const olderRequest = gate.beginRequest();
  gate.beginRequest();

  gate.pauseUntil(2_000);
  gate.recordSuccess(olderRequest);

  assert.throws(
    () => gate.assertOpen(),
    (error: unknown) => error instanceof LlmRateLimitPauseError && error.retryAt === 2_000,
  );
  now = 2_000;
  assert.doesNotThrow(() => gate.assertOpen());
});

test("quota and authentication failures skip in-place retries while transient failures may retry", () => {
  const { LlmHttpError, LlmRateLimitPauseError, shouldRetryLlmCall } = failurePolicy();

  assert.equal(shouldRetryLlmCall(new LlmHttpError("codex", 429, "limited", 2_000)), false);
  assert.equal(shouldRetryLlmCall(new LlmHttpError("codex", 401, "expired", null)), false);
  assert.equal(shouldRetryLlmCall(new LlmHttpError("codex", 403, "forbidden", null)), false);
  assert.equal(shouldRetryLlmCall(new LlmRateLimitPauseError("codex", 2_000)), false);
  assert.equal(shouldRetryLlmCall(new LlmHttpError("codex", 503, "overloaded", null)), true);
  assert.equal(shouldRetryLlmCall(new TypeError("fetch failed")), true);
});

test("paused requests recheck quota at most once per interval and resume when it is available", async () => {
  let now = 1_000;
  const gate = new watchdogModule.ProviderRateLimitGate({ provider: "codex", now: () => now, recheckIntervalMs: 1_000 });
  assert.equal(typeof gate.refresh, "function");
  gate.pauseUntil(100_000);
  let checks = 0;
  const limited = async () => { checks++; return { available: false, retryAt: 100_000 }; };
  await gate.refresh(limited);
  assert.equal(checks, 0);
  now += 1_000;
  await gate.refresh(limited);
  assert.equal(checks, 1);
  assert.throws(() => gate.assertOpen(), /requests are paused/);
  await gate.refresh(limited);
  assert.equal(checks, 1);
  now += 1_000;
  await gate.refresh(async () => ({ available: true, retryAt: null }));
  assert.doesNotThrow(() => gate.assertOpen());
});

test("failed or unknown quota checks keep the pause, while a manual refresh can bypass the check interval", async () => {
  let now = 1_000;
  const gate = new watchdogModule.ProviderRateLimitGate({ provider: "codex", now: () => now, recheckIntervalMs: 1_000 });
  assert.equal(typeof gate.refresh, "function");
  gate.pauseUntil(100_000);
  now += 1_000;
  await assert.rejects(gate.refresh(async () => { throw new Error("quota endpoint offline"); }), /offline/);
  assert.throws(() => gate.assertOpen(), /requests are paused/);
  let checks = 0;
  await gate.refresh(async () => { checks++; return { available: true, retryAt: null }; });
  assert.equal(checks, 0, "a failed quota query must also be throttled");
  await gate.refresh(async () => null, true);
  assert.throws(() => gate.assertOpen(), /requests are paused/);
  await gate.refresh(async () => ({ available: true, retryAt: null }), true);
  assert.doesNotThrow(() => gate.assertOpen());
});

test("overlapping quota checks share one request and an old result cannot clear a newer 429", async () => {
  const gate = new watchdogModule.ProviderRateLimitGate({ provider: "codex" });
  assert.equal(typeof gate.refresh, "function");
  gate.pauseUntil(Date.now() + 100_000);
  let resolve!: (value: { available: boolean; retryAt: null }) => void;
  const waiting = new Promise<{ available: boolean; retryAt: null }>(r => { resolve = r; });
  let checks = 0;
  const check = async () => { checks++; return waiting; };
  const first = gate.refresh(check, true);
  const second = gate.refresh(check, true);
  await Promise.resolve();
  assert.equal(checks, 1);
  gate.pauseUntil(Date.now() + 200_000);
  resolve({ available: true, retryAt: null });
  await Promise.all([first, second]);
  assert.throws(() => gate.assertOpen(), /requests are paused/);
});

test("a fresh exhausted window replaces an obsolete longer reset deadline", async () => {
  const gate = new watchdogModule.ProviderRateLimitGate({ provider: "codex", now: () => 1_000 });
  gate.pauseUntil(100_000);
  await gate.refresh(async () => ({ available: false, retryAt: 2_000 }), true);
  assert.equal(gate.getPausedUntil(), 2_000);
});
