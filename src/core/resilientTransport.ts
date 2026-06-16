import {
  type Clock,
  type EndpointConfig,
  type LoadBalanceStrategy,
  type Transport,
  type RpcTransportRequest,
  type Sleep,
  defaultClock,
  defaultSleep,
} from "./types.js";
import { NodePool, Endpoint, type NodePoolOptions } from "./nodePool.js";
import type { CircuitBreakerOptions } from "./circuitBreaker.js";
import { computeBackoff } from "./retry.js";
import { AllEndpointsFailedError, NoHealthyEndpointsError, type FailedAttempt } from "./errors.js";
import type { MetricsCollector } from "../observability/metrics.js";
import { createDefaultRpcTransport } from "@solana/web3.js";

export interface ResilientTransportConfig {
  /** Upstream RPC endpoints, in rough order of preference. */
  readonly endpoints: readonly EndpointConfig[];
  /**
   * Build a low-level transport for an endpoint. Defaults to web3.js v2's
   * `createDefaultRpcTransport`. Overridden in tests with a simulator.
   */
  readonly transportFactory?: (endpoint: EndpointConfig) => Transport;
  readonly strategy?: LoadBalanceStrategy;
  readonly breaker?: CircuitBreakerOptions;
  /** Max distinct endpoints to try per logical call (default: all). */
  readonly maxFailovers?: number;
  /** Backoff applied between failover attempts. */
  readonly backoff?: {
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly jitter?: number;
  };
  /** Decide whether an error should trigger failover (default: all but aborts). */
  readonly shouldFailover?: (error: unknown) => boolean;
  /** Reuse an existing collector so the monitor/exporters see every call. */
  readonly metrics?: MetricsCollector;
  /** Reuse an existing pool (e.g. shared with a health checker). */
  readonly pool?: NodePool;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

export interface ResilientTransport {
  /** A web3.js v2-compatible transport with failover + load balancing baked in. */
  readonly transport: Transport;
  readonly pool: NodePool;
  readonly metrics?: MetricsCollector;
  /** Per-endpoint low-level transports, keyed by URL (used by health checks). */
  readonly transports: ReadonlyMap<string, Transport>;
}

/** Extract the JSON-RPC method name from a transport payload (best effort). */
export function methodOf(payload: unknown): string {
  if (Array.isArray(payload) && payload.length > 0) {
    const inner = methodOf(payload[0]);
    return inner === "unknown" ? "batch" : `${inner}(+batch)`;
  }
  if (payload && typeof payload === "object" && "method" in payload) {
    const m = (payload as { method?: unknown }).method;
    if (typeof m === "string") return m;
  }
  return "unknown";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const defaultTransportFactory = (endpoint: EndpointConfig): Transport =>
  createDefaultRpcTransport({
    url: endpoint.url,
    // web3.js types forbidden headers as `undefined`; our plain map is fine.
    headers: endpoint.headers as never,
  }) as unknown as Transport;

/**
 * Build a resilient web3.js v2 transport.
 *
 * Each logical RPC call selects the best available endpoint from the pool, and
 * on a transport-level failure fails over to the next-best endpoint (with
 * backoff) until one succeeds or every candidate is exhausted. Latency and
 * outcomes are recorded to the pool (for circuit breaking + load balancing) and
 * to the metrics collector (for observability + the live monitor).
 */
export function createResilientTransport(
  config: ResilientTransportConfig,
): ResilientTransport {
  const clock = config.clock ?? defaultClock;
  const sleep = config.sleep ?? defaultSleep;
  const random = config.random ?? Math.random;
  const factory = config.transportFactory ?? defaultTransportFactory;
  const metrics = config.metrics;
  const shouldFailover =
    config.shouldFailover ?? ((err: unknown) => !isAbortError(err));

  const poolOptions: NodePoolOptions = {
    strategy: config.strategy,
    breaker: config.breaker,
    clock,
    random,
  };
  const pool = config.pool ?? new NodePool(config.endpoints, poolOptions);

  // One low-level transport per endpoint, created once and reused.
  const transports = new Map<string, Transport>();
  for (let i = 0; i < pool.endpoints.length; i++) {
    const ep = pool.endpoints[i]!;
    const cfg = config.endpoints[i] ?? { url: ep.url };
    transports.set(ep.url, factory(cfg));
  }

  const base = config.backoff?.baseDelayMs ?? 150;
  const max = config.backoff?.maxDelayMs ?? 2_000;
  const jitter = config.backoff?.jitter ?? 1;
  const maxTries = Math.min(
    config.maxFailovers ?? pool.endpoints.length,
    pool.endpoints.length,
  );

  const transport: Transport = async <TResponse>(
    request: RpcTransportRequest,
  ): Promise<TResponse> => {
    const method = methodOf(request.payload);
    const used = new Set<Endpoint>();
    const attempts: FailedAttempt[] = [];

    for (let attempt = 0; attempt < maxTries; attempt++) {
      const ep =
        attempt === 0 ? pool.acquire() : pool.acquireExcluding(used);
      if (!ep) break;
      used.add(ep);

      const upstream = transports.get(ep.url)!;
      ep.inflight++;
      const start = clock();

      let result: TResponse;
      try {
        result = await upstream<TResponse>(request);
      } catch (err) {
        ep.inflight--;
        const latency = clock() - start;
        ep.recordFailure(latency, err);
        metrics?.record({
          endpoint: ep.name,
          method,
          ok: false,
          latencyMs: latency,
          timestamp: clock(),
          error: toError(err).message,
          failedOver: attempt > 0,
        });
        attempts.push({ endpoint: ep.name, error: toError(err) });

        if (request.signal?.aborted || !shouldFailover(err)) {
          throw toError(err);
        }
        if (attempt < maxTries - 1) {
          await sleep(computeBackoff(attempt, base, max, jitter, random));
        }
        continue;
      }

      ep.inflight--;
      const latency = clock() - start;
      ep.recordSuccess(latency);
      metrics?.record({
        endpoint: ep.name,
        method,
        ok: true,
        latencyMs: latency,
        timestamp: clock(),
        failedOver: attempt > 0,
      });
      return result;
    }

    if (attempts.length === 0) throw new NoHealthyEndpointsError();
    throw new AllEndpointsFailedError(method, attempts);
  };

  return { transport, pool, metrics, transports };
}
