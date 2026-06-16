import {
  type Clock,
  type EndpointConfig,
  type EndpointStats,
  type LoadBalanceStrategy,
  defaultClock,
} from "./types.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuitBreaker.js";

const LATENCY_WINDOW = 100;
const EWMA_ALPHA = 0.3;

/** Percentile (0..100) of a numeric sample using linear interpolation. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/** Mutable per-endpoint state and health accounting. */
export class Endpoint {
  readonly url: string;
  readonly name: string;
  readonly weight: number;
  readonly headers: Record<string, string>;
  readonly breaker: CircuitBreaker;

  /** Health flag set by the (optional) background health checker. */
  healthy = true;
  inflight = 0;
  totalRequests = 0;
  totalFailures = 0;
  consecutiveFailures = 0;
  avgLatencyMs = 0;
  lastError?: string;

  private readonly latencies: number[] = [];

  constructor(config: EndpointConfig, breakerOptions?: CircuitBreakerOptions) {
    this.url = config.url;
    this.name = config.name ?? hostOf(config.url);
    this.weight = config.weight ?? 1;
    this.headers = config.headers ?? {};
    this.breaker = new CircuitBreaker(breakerOptions);
  }

  recordSuccess(latencyMs: number): void {
    this.totalRequests++;
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.pushLatency(latencyMs);
    this.breaker.recordSuccess();
  }

  recordFailure(latencyMs: number, error: unknown): void {
    this.totalRequests++;
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.pushLatency(latencyMs);
    this.breaker.recordFailure();
  }

  /** True when the circuit permits a request. Health flag gates selection too. */
  available(): boolean {
    return this.breaker.canRequest();
  }

  p95(): number {
    return percentile(this.latencies, 95);
  }

  stats(): EndpointStats {
    return {
      url: this.url,
      name: this.name,
      weight: this.weight,
      healthy: this.healthy,
      circuit: this.breaker.getState(),
      avgLatencyMs: Math.round(this.avgLatencyMs * 100) / 100,
      p95LatencyMs: Math.round(this.p95() * 100) / 100,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      consecutiveFailures: this.consecutiveFailures,
      inflight: this.inflight,
      lastError: this.lastError,
    };
  }

  private pushLatency(latencyMs: number): void {
    this.avgLatencyMs =
      this.avgLatencyMs === 0
        ? latencyMs
        : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * this.avgLatencyMs;
    this.latencies.push(latencyMs);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }
}

export interface NodePoolOptions {
  readonly strategy?: LoadBalanceStrategy;
  readonly breaker?: CircuitBreakerOptions;
  readonly clock?: Clock;
  /** Injectable RNG for `weighted-random` (default Math.random). */
  readonly random?: () => number;
}

/**
 * Health-aware pool of RPC endpoints with pluggable load-balancing.
 *
 * `acquire()` returns the best currently-selectable endpoint (circuit closed or
 * half-open, and marked healthy) according to the configured strategy, or
 * `null` when every endpoint is unavailable.
 */
export class NodePool {
  readonly endpoints: Endpoint[];
  private readonly strategy: LoadBalanceStrategy;
  private readonly random: () => number;
  private rrCursor = 0;

  constructor(configs: readonly EndpointConfig[], options: NodePoolOptions = {}) {
    if (configs.length === 0) {
      throw new Error("NodePool requires at least one endpoint");
    }
    this.strategy = options.strategy ?? "least-latency";
    this.random = options.random ?? Math.random;
    this.endpoints = configs.map(
      (c) => new Endpoint(c, options.breaker),
    );
  }

  /** Endpoints currently eligible for selection. */
  private candidates(): Endpoint[] {
    const usable = this.endpoints.filter((e) => e.healthy && e.available());
    // If health checks have marked everything unhealthy but circuits still
    // allow requests, fall back to circuit availability so we never hard-fail
    // purely on stale health flags.
    if (usable.length > 0) return usable;
    return this.endpoints.filter((e) => e.available());
  }

  acquire(): Endpoint | null {
    const candidates = this.candidates();
    if (candidates.length === 0) return null;
    switch (this.strategy) {
      case "round-robin":
        return this.pickRoundRobin(candidates);
      case "least-inflight":
        return this.pickBy(candidates, (e) => e.inflight);
      case "weighted-random":
        return this.pickWeighted(candidates);
      case "least-latency":
      default:
        // Unproven endpoints (no latency yet) are tried eagerly.
        return this.pickBy(candidates, (e) =>
          e.totalRequests === 0 ? -1 : e.avgLatencyMs,
        );
    }
  }

  /** Exclude an endpoint we already tried this call, then re-acquire. */
  acquireExcluding(used: ReadonlySet<Endpoint>): Endpoint | null {
    const remaining = this.candidates().filter((e) => !used.has(e));
    if (remaining.length === 0) return null;
    switch (this.strategy) {
      case "least-inflight":
        return this.pickBy(remaining, (e) => e.inflight);
      case "weighted-random":
        return this.pickWeighted(remaining);
      case "round-robin":
        return this.pickRoundRobin(remaining);
      case "least-latency":
      default:
        return this.pickBy(remaining, (e) =>
          e.totalRequests === 0 ? -1 : e.avgLatencyMs,
        );
    }
  }

  snapshot(): EndpointStats[] {
    return this.endpoints.map((e) => e.stats());
  }

  private pickRoundRobin(candidates: Endpoint[]): Endpoint {
    const ep = candidates[this.rrCursor % candidates.length]!;
    this.rrCursor = (this.rrCursor + 1) % candidates.length;
    return ep;
  }

  private pickBy(candidates: Endpoint[], score: (e: Endpoint) => number): Endpoint {
    let best = candidates[0]!;
    let bestScore = score(best);
    for (let i = 1; i < candidates.length; i++) {
      const s = score(candidates[i]!);
      if (s < bestScore) {
        best = candidates[i]!;
        bestScore = s;
      }
    }
    return best;
  }

  private pickWeighted(candidates: Endpoint[]): Endpoint {
    const total = candidates.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
    if (total <= 0) return candidates[0]!;
    let r = this.random() * total;
    for (const e of candidates) {
      r -= Math.max(0, e.weight);
      if (r < 0) return e;
    }
    return candidates[candidates.length - 1]!;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
