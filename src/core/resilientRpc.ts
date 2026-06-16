import {
  createSolanaRpcFromTransport,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from "@solana/web3.js";
import {
  createResilientTransport,
  type ResilientTransportConfig,
} from "./resilientTransport.js";
import { MetricsCollector } from "../observability/metrics.js";
import {
  HealthChecker,
  createGetHealthProbe,
  type HealthCheckerOptions,
} from "./healthChecker.js";
import type { NodePool } from "./nodePool.js";
import type { Transport } from "./types.js";

export interface ResilientClientConfig extends ResilientTransportConfig {
  /** Enable periodic background health checks (true = defaults, or pass options). */
  readonly healthCheck?: boolean | HealthCheckerOptions;
}

export interface ResilientClient {
  /** A standard web3.js v2 RPC client — drop-in for `createSolanaRpc`'s result. */
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly transport: Transport;
  readonly pool: NodePool;
  readonly metrics: MetricsCollector;
  readonly healthChecker?: HealthChecker;
  /** Stop background work and flush/close exporters. */
  close(): Promise<void>;
}

/**
 * Drop-in replacement for web3.js v2's `createSolanaRpc` that transparently
 * load-balances and fails over across multiple endpoints.
 *
 * ```ts
 * const rpc = createResilientRpc({
 *   endpoints: [{ url: primary }, { url: fallback }],
 * });
 * const slot = await rpc.getSlot().send(); // same API as a normal v2 RPC
 * ```
 */
export function createResilientRpc(
  config: ResilientTransportConfig,
): Rpc<SolanaRpcApi> {
  const { transport } = createResilientTransport(config);
  return createSolanaRpcFromTransport(transport as unknown as RpcTransport);
}

/**
 * Build a resilient RPC together with its pool, metrics collector and optional
 * health checker — for apps that want to observe/monitor the resilience layer.
 */
export function createResilientClient(
  config: ResilientClientConfig,
): ResilientClient {
  const metrics = config.metrics ?? new MetricsCollector();
  const rt = createResilientTransport({ ...config, metrics });
  const rpc = createSolanaRpcFromTransport(
    rt.transport as unknown as RpcTransport,
  );

  let healthChecker: HealthChecker | undefined;
  if (config.healthCheck) {
    const opts =
      typeof config.healthCheck === "object" ? config.healthCheck : {};
    const probe = opts.probe ?? createGetHealthProbe(rt.transports);
    healthChecker = new HealthChecker(rt.pool, probe, opts);
    healthChecker.start();
  }

  return {
    rpc,
    transport: rt.transport,
    pool: rt.pool,
    metrics,
    healthChecker,
    async close() {
      healthChecker?.stop();
      await metrics.shutdown();
    },
  };
}
