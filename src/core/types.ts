/**
 * Shared types for the resilience layer.
 *
 * The transport types here are structurally compatible with web3.js v2.0's
 * `RpcTransport` so our resilient transport can be passed straight into
 * `createSolanaRpcFromTransport`.
 */

/** A single JSON-RPC transport request, mirroring web3.js v2's shape. */
export interface RpcTransportRequest {
  readonly payload: unknown;
  readonly signal?: AbortSignal;
}

/** A transport function, structurally identical to web3.js v2's `RpcTransport`. */
export type Transport = <TResponse>(
  request: RpcTransportRequest,
) => Promise<TResponse>;

/** Configuration for a single upstream RPC endpoint. */
export interface EndpointConfig {
  /** RPC HTTP(S) URL. */
  readonly url: string;
  /** Human-friendly name (defaults to the URL host). */
  readonly name?: string;
  /**
   * Relative selection weight for weighted load balancing (default 1).
   * Higher weight = more traffic.
   */
  readonly weight?: number;
  /** Extra headers (e.g. API keys) forwarded to the transport factory. */
  readonly headers?: Record<string, string>;
}

/** Load-balancing strategy across healthy endpoints. */
export type LoadBalanceStrategy =
  | "round-robin"
  | "least-latency"
  | "least-inflight"
  | "weighted-random";

export type CircuitState = "closed" | "open" | "half-open";

/** Live stats for a single endpoint, exposed for monitoring. */
export interface EndpointStats {
  readonly url: string;
  readonly name: string;
  readonly weight: number;
  readonly healthy: boolean;
  readonly circuit: CircuitState;
  /** Exponentially weighted moving average latency in ms. */
  readonly avgLatencyMs: number;
  /** p95 latency over the recent window, in ms. */
  readonly p95LatencyMs: number;
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly consecutiveFailures: number;
  readonly inflight: number;
  readonly lastError?: string;
}

/** A single observed RPC call, emitted to the metrics collector. */
export interface RpcMetricEvent {
  readonly endpoint: string;
  readonly method: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly timestamp: number;
  readonly error?: string;
  /** Set when the call was retried/failed-over onto another endpoint. */
  readonly failedOver?: boolean;
}

/** Injectable clock — overridden in tests for determinism. */
export type Clock = () => number;

/** Injectable sleep — overridden in tests for determinism. */
export type Sleep = (ms: number) => Promise<void>;

export const defaultClock: Clock = () => Date.now();

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
