import type {
  EndpointConfig,
  RpcTransportRequest,
  Transport,
} from "../../src/core/types.js";

/** A deterministic, advanceable clock for time-dependent tests. */
export interface ManualClock {
  now(): number;
  advance(ms: number): void;
}

export function manualClock(start = 0): ManualClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Per-endpoint failure/latency injection knobs. */
export interface EndpointBehavior {
  /** Latency added to the shared clock on every call (default 10ms). */
  readonly latencyMs?: number;
  /** Fail every call. */
  readonly alwaysFail?: boolean;
  /** Fail the first N calls, then succeed (recovery simulation). */
  readonly failTimes?: number;
  /** Probabilistic failure in [0,1], evaluated against the injected RNG. */
  readonly failRate?: number;
  /** Start returning rate-limit (429) errors once call count exceeds this. */
  readonly rateLimitAfter?: number;
  /** Custom error factory (overrides the default failure error). */
  readonly error?: () => Error;
  /** Custom JSON-RPC response builder. */
  readonly responder?: (method: string, params: unknown, id: unknown) => unknown;
}

const DEFAULT_RESULTS: Record<string, unknown> = {
  getHealth: "ok",
  getSlot: 123,
  getVersion: { "solana-core": "2.0.0", "feature-set": 1 },
  getEpochInfo: { blockHeight: 1000, epoch: 1, slotIndex: 0, slotsInEpoch: 432000 },
};

function defaultResult(method: string): unknown {
  return method in DEFAULT_RESULTS ? DEFAULT_RESULTS[method] : null;
}

/**
 * Simulates a network of RPC endpoints with controllable latency and failure
 * modes. Use {@link transportFactory} as the `transportFactory` of a resilient
 * transport, {@link clock} as its `clock`, and {@link sleep} as its `sleep` to
 * get fully deterministic, offline failure-mode tests.
 */
export class SimulatedNetwork {
  readonly clock = manualClock();
  readonly calls = new Map<string, number>();
  private readonly behaviors = new Map<string, EndpointBehavior>();
  private readonly random: () => number;

  constructor(options: { random?: () => number } = {}) {
    this.random = options.random ?? (() => 0.5);
  }

  set(url: string, behavior: EndpointBehavior): this {
    this.behaviors.set(url, behavior);
    return this;
  }

  callCount(url: string): number {
    return this.calls.get(url) ?? 0;
  }

  /** A sleep implementation that advances the shared clock instead of waiting. */
  readonly sleep = async (ms: number): Promise<void> => {
    this.clock.advance(ms);
  };

  readonly transportFactory = (endpoint: EndpointConfig): Transport => {
    const url = endpoint.url;
    return async <T>(request: RpcTransportRequest): Promise<T> => {
      const n = this.callCount(url) + 1;
      this.calls.set(url, n);

      const behavior = this.behaviors.get(url) ?? {};
      this.clock.advance(behavior.latencyMs ?? 10);

      const rateLimited =
        behavior.rateLimitAfter != null && n > behavior.rateLimitAfter;
      const shouldFail =
        behavior.alwaysFail === true ||
        (behavior.failTimes != null && n <= behavior.failTimes) ||
        rateLimited ||
        (behavior.failRate != null && this.random() < behavior.failRate);

      if (shouldFail) {
        if (behavior.error) throw behavior.error();
        throw new Error(
          rateLimited
            ? "429 Too Many Requests"
            : `simulated failure on ${url} (call ${n})`,
        );
      }

      const payload = request.payload as {
        method?: string;
        params?: unknown;
        id?: unknown;
      };
      const method = payload?.method ?? "unknown";
      if (behavior.responder) {
        return behavior.responder(method, payload?.params, payload?.id) as T;
      }
      return {
        jsonrpc: "2.0",
        id: payload?.id ?? 1,
        result: defaultResult(method),
      } as T;
    };
  };
}

/** Build a JSON-RPC transport payload for a method (for direct transport tests). */
export function payloadFor(method: string, params: unknown[] = [], id = 1) {
  return { payload: { jsonrpc: "2.0", id, method, params } };
}
