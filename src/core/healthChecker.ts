import { type Clock, type Transport, defaultClock } from "./types.js";
import type { NodePool, Endpoint } from "./nodePool.js";

/** A probe that reports whether an endpoint is healthy and how fast it replied. */
export type HealthProbe = (
  endpoint: Endpoint,
) => Promise<{ ok: boolean; latencyMs: number }>;

export interface HealthCheckerOptions {
  /** Poll interval in ms (default 15_000). */
  readonly intervalMs?: number;
  /** Custom probe; defaults to a `getHealth` call over each endpoint's transport. */
  readonly probe?: HealthProbe;
  readonly clock?: Clock;
  /** Injectable timers for deterministic tests. */
  readonly setIntervalFn?: (cb: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

/** Build a default `getHealth` probe from a per-endpoint transport map. */
export function createGetHealthProbe(
  transports: ReadonlyMap<string, Transport>,
  clock: Clock = defaultClock,
): HealthProbe {
  return async (endpoint) => {
    const upstream = transports.get(endpoint.url);
    if (!upstream) return { ok: false, latencyMs: 0 };
    const start = clock();
    const payload = { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] };
    const response = await upstream<{ result?: unknown; error?: unknown }>({
      payload,
    });
    const latencyMs = clock() - start;
    // A healthy node replies `{ result: "ok" }`. A node that is *behind* replies
    // with a JSON-RPC error envelope (e.g. -32005 "Node is behind by N slots"),
    // and the raw transport does NOT throw on that — so we must inspect the body
    // or we'd keep routing traffic to a lagging node. Treat any error envelope
    // (or a non-"ok" result) as unhealthy.
    const env =
      response && typeof response === "object"
        ? (response as { result?: unknown; error?: unknown })
        : null;
    const ok = env != null && env.error == null && env.result === "ok";
    return { ok, latencyMs };
  };
}

/**
 * Periodically probes every endpoint and updates pool health, so traffic is
 * steered away from degraded nodes *before* a user request hits them and
 * steered back once they recover.
 */
export class HealthChecker {
  private readonly pool: NodePool;
  private readonly probe: HealthProbe;
  private readonly intervalMs: number;
  private readonly clock: Clock;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private handle: unknown;

  constructor(
    pool: NodePool,
    probe: HealthProbe,
    options: HealthCheckerOptions = {},
  ) {
    this.pool = pool;
    this.probe = probe;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.clock = options.clock ?? defaultClock;
    this.setIntervalFn =
      options.setIntervalFn ??
      ((cb, ms) => {
        const timer = setInterval(cb, ms);
        timer.unref?.();
        return timer;
      });
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /** Probe every endpoint once and fold the result into pool health + stats. */
  async checkOnce(): Promise<void> {
    await Promise.all(
      this.pool.endpoints.map(async (ep) => {
        const start = this.clock();
        try {
          const result = await this.probe(ep);
          if (result.ok) {
            ep.healthy = true;
            ep.recordSuccess(result.latencyMs);
          } else {
            ep.healthy = false;
            ep.recordFailure(result.latencyMs, new Error("health probe failed"));
          }
        } catch (error) {
          ep.healthy = false;
          ep.recordFailure(this.clock() - start, error);
        }
      }),
    );
  }

  /** Begin periodic checks (runs one immediately). */
  start(): void {
    if (this.handle !== undefined) return;
    void this.checkOnce();
    this.handle = this.setIntervalFn(() => {
      void this.checkOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.clearIntervalFn(this.handle);
    this.handle = undefined;
  }
}
