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
    shouldCountTowardConnectionWatchdog(new LlmHttpError("claude", 429, "limited", 2_000)),
    false,
  );
  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmHttpError("claude", 401, "expired", null)),
    false,
  );
  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmHttpError("claude", 529, "overloaded", null)),
    false,
  );
  assert.equal(
    shouldCountTowardConnectionWatchdog(new LlmRateLimitPauseError("claude", 2_000)),
    false,
  );
  assert.equal(shouldCountTowardConnectionWatchdog(new TypeError("fetch failed")), true);
  assert.equal(shouldCountTowardConnectionWatchdog(new Error("Claude credentials not found")), false);
  assert.equal(shouldCountTowardConnectionWatchdog(new SyntaxError("bad config")), false);
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(shouldCountTowardConnectionWatchdog(timeout), true);
});

test("rate-limit gate suppresses requests until the server reset time", () => {
  const { LlmRateLimitPauseError, ProviderRateLimitGate } = failurePolicy();
  let now = 1_000;
  const gate = new ProviderRateLimitGate({
    provider: "claude",
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
    provider: "claude",
    now: () => 10_000,
    fallbackPauseMs: 300_000,
  });

  assert.equal(gate.pauseUntil(null), 310_000);
});

test("a success from an older overlapping request cannot clear a newer rate-limit pause", () => {
  const { LlmRateLimitPauseError, ProviderRateLimitGate } = failurePolicy();
  let now = 1_000;
  const gate = new ProviderRateLimitGate({ provider: "claude", now: () => now, fallbackPauseMs: 500 });
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

  assert.equal(shouldRetryLlmCall(new LlmHttpError("claude", 429, "limited", 2_000)), false);
  assert.equal(shouldRetryLlmCall(new LlmHttpError("claude", 401, "expired", null)), false);
  assert.equal(shouldRetryLlmCall(new LlmHttpError("claude", 403, "forbidden", null)), false);
  assert.equal(shouldRetryLlmCall(new LlmRateLimitPauseError("claude", 2_000)), false);
  assert.equal(shouldRetryLlmCall(new LlmHttpError("claude", 529, "overloaded", null)), true);
  assert.equal(shouldRetryLlmCall(new TypeError("fetch failed")), true);
});
