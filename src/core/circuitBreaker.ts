import { type Clock, type CircuitState, defaultClock } from "./types.js";

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open (default 5). */
  readonly failureThreshold?: number;
  /** Consecutive successes in half-open needed to close again (default 2). */
  readonly successThreshold?: number;
  /** How long the breaker stays open before a trial request, ms (default 10_000). */
  readonly openDurationMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly clock?: Clock;
}

/**
 * A classic three-state circuit breaker (closed → open → half-open).
 *
 * - **closed**: requests flow; consecutive failures accumulate.
 * - **open**: requests are rejected until `openDurationMs` elapses.
 * - **half-open**: a limited number of trial requests probe recovery; enough
 *   successes close the breaker, a single failure re-opens it.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openDurationMs: number;
  private readonly clock: Clock;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.openDurationMs = options.openDurationMs ?? 10_000;
    this.clock = options.clock ?? defaultClock;
  }

  /** Current state, transitioning open → half-open lazily when the timer elapses. */
  getState(): CircuitState {
    if (
      this.state === "open" &&
      this.clock() - this.openedAt >= this.openDurationMs
    ) {
      this.state = "half-open";
      this.halfOpenSuccesses = 0;
    }
    return this.state;
  }

  /** Whether a request may be attempted right now. */
  canRequest(): boolean {
    return this.getState() !== "open";
  }

  recordSuccess(): void {
    const state = this.getState();
    if (state === "half-open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.close();
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(): void {
    const state = this.getState();
    if (state === "half-open") {
      // Any failure while probing immediately re-opens the breaker.
      this.open();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  /** Force the breaker closed (e.g. after an external health check passes). */
  close(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.clock();
    this.halfOpenSuccesses = 0;
  }
}
