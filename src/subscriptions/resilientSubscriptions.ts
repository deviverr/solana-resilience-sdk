import {
  createSolanaRpcSubscriptions,
  type RpcSubscriptions,
  type SolanaRpcSubscriptionsApi,
} from "@solana/web3.js";
import { type Sleep, defaultSleep } from "../core/types.js";
import { computeBackoff } from "../core/retry.js";
import { SubscriptionClosedError } from "../core/errors.js";

/**
 * Establish one subscription stream. Receives a zero-based `generation`
 * (incremented on every reconnect — the adapter uses it to rotate endpoints)
 * and a per-connection `AbortSignal` that fires when this stream is being torn
 * down (reconnect or caller abort). Forward that signal to the underlying
 * `.subscribe({ abortSignal })` call so the socket is closed on teardown.
 */
export type SubscriptionConnect<T> = (
  generation: number,
  signal: AbortSignal,
) => Promise<AsyncIterable<T>>;

export interface BackoffConfig {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: number;
}

export interface ResilientSubscriptionOptions<T> {
  readonly connect: SubscriptionConnect<T>;
  /** Stop the subscription for good when this fires. */
  readonly signal?: AbortSignal;
  /** Max reconnects before giving up (default `Infinity` — never give up). */
  readonly maxReconnects?: number;
  readonly backoff?: BackoffConfig;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  /** Observe each reconnect (error that dropped the stream, attempt, delay). */
  readonly onReconnect?: (
    error: unknown,
    generation: number,
    delayMs: number,
  ) => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Wrap a reconnecting subscription stream as a single, continuous async
 * iterable. When the underlying stream ends or errors (a dropped WebSocket, a
 * node going away) it transparently reconnects — backing off only while the
 * stream keeps failing, and reconnecting promptly once a stream has delivered
 * data. Caller abort (via `signal`) ends it cleanly; exhausting `maxReconnects`
 * throws {@link SubscriptionClosedError}.
 *
 * The core is transport-agnostic: `connect` supplies the stream, so it is fully
 * exercisable offline. {@link createResilientSubscriptions} binds it to web3.js.
 */
export async function* resilientSubscription<T>(
  options: ResilientSubscriptionOptions<T>,
): AsyncGenerator<T> {
  const {
    connect,
    signal,
    maxReconnects = Infinity,
    backoff,
    sleep = defaultSleep,
    random = Math.random,
    onReconnect,
  } = options;

  const base = backoff?.baseDelayMs ?? 250;
  const max = backoff?.maxDelayMs ?? 10_000;
  const jitter = backoff?.jitter ?? 1;

  let generation = 0;
  let failStreak = 0;
  let lastError: unknown;

  while (!signal?.aborted) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let delivered = false;
    try {
      const stream = await connect(generation, ac.signal);
      for await (const item of stream) {
        delivered = true;
        yield item;
      }
      // Stream ended without error — server closed the channel; reconnect.
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      lastError = error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      ac.abort(); // ensure the underlying socket is torn down
    }

    if (signal?.aborted) return;

    generation++;
    failStreak = delivered ? 0 : failStreak + 1;
    if (generation > maxReconnects) {
      throw new SubscriptionClosedError(generation - 1, lastError);
    }

    const delay = computeBackoff(failStreak, base, max, jitter, random);
    onReconnect?.(lastError, generation, delay);
    await sleep(delay);
  }
}

/** An endpoint for subscriptions — a WebSocket URL (string or `{ url }`). */
export type SubscriptionEndpoint = string | { readonly url: string };

export interface ResilientSubscriptionsConfig {
  /** WebSocket endpoints, tried in rotation on reconnect. */
  readonly endpoints: readonly SubscriptionEndpoint[];
  readonly maxReconnects?: number;
  readonly backoff?: BackoffConfig;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly onReconnect?: (
    error: unknown,
    generation: number,
    delayMs: number,
  ) => void;
  /** Override the per-endpoint subscriptions client (injected in tests). */
  readonly subscriptionsFactory?: (
    url: string,
  ) => RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

export type SubscribeOptions = {
  readonly signal?: AbortSignal;
  readonly maxReconnects?: number;
  readonly onReconnect?: (
    error: unknown,
    generation: number,
    delayMs: number,
  ) => void;
};

export interface ResilientSubscriptions {
  /**
   * Subscribe resiliently. `select` opens a stream on a given subscriptions
   * client (forward the supplied signal to `.subscribe({ abortSignal })`); the
   * returned async iterable transparently fails over across endpoints and
   * reconnects on drop.
   *
   * ```ts
   * for await (const slot of subs.subscribe((rpc, signal) =>
   *   rpc.slotNotifications().subscribe({ abortSignal: signal }),
   * )) { ... }
   * ```
   */
  subscribe<T>(
    select: (
      client: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
      signal: AbortSignal,
    ) => Promise<AsyncIterable<T>>,
    options?: SubscribeOptions,
  ): AsyncGenerator<T>;
  readonly clients: readonly RpcSubscriptions<SolanaRpcSubscriptionsApi>[];
}

const urlOf = (e: SubscriptionEndpoint): string =>
  typeof e === "string" ? e : e.url;

/**
 * Health-aware, auto-reconnecting wrapper over web3.js v2 RPC subscriptions.
 * Rotates across the configured WebSocket endpoints on every reconnect so a
 * single flaky node never silently kills your `accountSubscribe` /
 * `slotSubscribe` / `signatureSubscribe` stream.
 */
export function createResilientSubscriptions(
  config: ResilientSubscriptionsConfig,
): ResilientSubscriptions {
  if (config.endpoints.length === 0) {
    throw new Error("createResilientSubscriptions requires at least one endpoint");
  }
  const factory = config.subscriptionsFactory ?? createSolanaRpcSubscriptions;
  const clients = config.endpoints.map((e) => factory(urlOf(e)));

  return {
    clients,
    subscribe(select, options = {}) {
      return resilientSubscription({
        connect: (generation, signal) =>
          select(clients[generation % clients.length]!, signal),
        signal: options.signal,
        maxReconnects: options.maxReconnects ?? config.maxReconnects,
        backoff: config.backoff,
        sleep: config.sleep,
        random: config.random,
        onReconnect: options.onReconnect ?? config.onReconnect,
      });
    },
  };
}
