import { type Sleep, defaultSleep } from "./types.js";

export interface RetryOptions {
  /** Maximum number of *retries* after the first attempt (default 3). */
  readonly maxRetries?: number;
  /** Base backoff delay in ms (default 200). */
  readonly baseDelayMs?: number;
  /** Maximum backoff delay in ms (default 5_000). */
  readonly maxDelayMs?: number;
  /**
   * Jitter factor in [0, 1] applied as "full jitter" (default 1 = full).
   * 0 disables jitter (purely deterministic exponential backoff).
   */
  readonly jitter?: number;
  /** Decide whether a given error is worth retrying (default: always). */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Observe each retry (useful for metrics/logging). */
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleep + RNG for deterministic tests. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

/**
 * Compute an exponential backoff delay with optional full jitter.
 *
 * `attempt` is zero-based: attempt 0 is the delay *before* the first retry.
 */
export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  if (jitter <= 0) return exp;
  // Full jitter: random in [exp*(1-jitter), exp].
  const min = exp * (1 - Math.min(1, jitter));
  return min + random() * (exp - min);
}

/**
 * Run `fn`, retrying on failure with exponential backoff + jitter.
 *
 * Resolves with the first successful result; rejects with the last error once
 * retries are exhausted or `shouldRetry` returns false.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    jitter = 1,
    shouldRetry = () => true,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const hasMore = attempt < maxRetries;
      if (!hasMore || !shouldRetry(error, attempt)) break;
      const delay = computeBackoff(
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitter,
        random,
      );
      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
