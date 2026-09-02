export type ConnectionWatchdogConfig = {
  // Consecutive top-level LLM call failures (each already exhausted its own
  // internal retries) before the watchdog reports the process as stuck.
  consecutiveFailureThreshold: number;
};

export const DEFAULT_CONNECTION_WATCHDOG_CONFIG: ConnectionWatchdogConfig = {
  consecutiveFailureThreshold: 5,
};

export class LlmHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryAt: number | null;

  constructor(provider: string, status: number, detail: string, retryAt: number | null) {
    super(`${provider} API error ${status}: ${detail}`);
    this.name = "LlmHttpError";
    this.provider = provider;
    this.status = status;
    this.retryAt = retryAt;
  }
}

export class LlmRateLimitPauseError extends Error {
  readonly provider: string;
  readonly retryAt: number;

  constructor(provider: string, retryAt: number) {
    super(`${provider} requests are paused until ${new Date(retryAt).toISOString()} after a rate limit.`);
    this.name = "LlmRateLimitPauseError";
    this.provider = provider;
    this.retryAt = retryAt;
  }
}

export function shouldCountTowardConnectionWatchdog(error: unknown): boolean {
  if (error instanceof LlmHttpError || error instanceof LlmRateLimitPauseError) return false;
  if (!(error instanceof Error)) return false;

  // Positive classification only: credentials, config parsing, and application
  // errors must never accumulate toward a process restart. Count failures that
  // actually indicate a stuck/failed transport.
  const message = error.message.toLowerCase();
  const cause = (error as Error & { cause?: unknown }).cause;
  const code = (error as Error & { code?: unknown }).code
    ?? (cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined);
  return error.name === "TimeoutError"
    || error.name === "AbortError"
    || message.includes("fetch failed")
    || message.includes("timed out")
    || message.includes("timeout")
    || code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "ETIMEDOUT"
    || code === "EPIPE";
}

export function shouldRetryLlmCall(error: unknown): boolean {
  if (error instanceof LlmRateLimitPauseError) return false;
  if (error instanceof LlmHttpError) {
    return error.status !== 401 && error.status !== 403 && error.status !== 429;
  }
  return true;
}

export type ProviderRateLimitGateOptions = {
  provider: string;
  now?: () => number;
  fallbackPauseMs?: number;
};

export class ProviderRateLimitGate {
  private readonly provider: string;
  private readonly now: () => number;
  private readonly fallbackPauseMs: number;
  private pausedUntil: number | null = null;
  private revision = 0;

  constructor(options: ProviderRateLimitGateOptions) {
    this.provider = options.provider;
    this.now = options.now ?? (() => Date.now());
    this.fallbackPauseMs = Math.max(1_000, Math.floor(options.fallbackPauseMs ?? 5 * 60_000));
  }

  assertOpen(): void {
    if (this.pausedUntil === null) return;
    if (this.now() >= this.pausedUntil) {
      this.pausedUntil = null;
      return;
    }
    throw new LlmRateLimitPauseError(this.provider, this.pausedUntil);
  }

  beginRequest(): number {
    this.assertOpen();
    return this.revision;
  }

  recordSuccess(requestRevision: number): void {
    if (requestRevision === this.revision) {
      this.pausedUntil = null;
    }
  }

  pauseUntil(retryAt: number | null): number {
    const now = this.now();
    const next = retryAt !== null && Number.isFinite(retryAt) && retryAt > now
      ? retryAt
      : now + this.fallbackPauseMs;
    this.revision += 1;
    this.pausedUntil = Math.max(this.pausedUntil ?? 0, next);
    return this.pausedUntil;
  }

  getPausedUntil(): number | null {
    if (this.pausedUntil !== null && this.now() >= this.pausedUntil) {
      this.pausedUntil = null;
    }
    return this.pausedUntil;
  }
}

/**
 * Detects a long-running-but-silently-broken process: every LLM call fails
 * the same way while a brand-new process using the identical config/profile
 * succeeds immediately. This happened on 2026-08-24 — a two-day-old process
 * got HTTP 403 on every single Claude call for 2+ hours (most likely a dead
 * pooled connection to the local proxy) while `npm run llm:test` succeeded
 * on the first try every time it was run fresh. The process never crashed,
 * so PM2's autorestart-on-exit never triggered.
 *
 * This tracker is the missing signal: a success resets the streak, and
 * crossing the threshold is edge-triggered (reported exactly once per
 * streak) so a caller that reacts by exiting the process does so once, not
 * on every failure after the threshold. Pure and side-effect free — the
 * caller decides what "stuck" means to do (log, exit, alert, ...).
 */
export class ConnectionWatchdog {
  private readonly threshold: number;
  private consecutiveFailures = 0;

  constructor(config: ConnectionWatchdogConfig = DEFAULT_CONNECTION_WATCHDOG_CONFIG) {
    this.threshold = Math.max(1, Math.floor(config.consecutiveFailureThreshold));
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  // Returns true the moment the streak first reaches the threshold.
  recordFailure(): boolean {
    this.consecutiveFailures += 1;
    return this.consecutiveFailures === this.threshold;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
