import { describe, it, expect, vi } from "vitest";
import {
  resilientSubscription,
  createResilientSubscriptions,
} from "../src/subscriptions/resilientSubscriptions.js";
import { SubscriptionClosedError } from "../src/core/errors.js";

/** A stream that yields `items`, then optionally throws. */
async function* streamOf<T>(
  items: T[],
  opts: { thenThrow?: unknown } = {},
): AsyncGenerator<T> {
  for (const it of items) yield it;
  if ("thenThrow" in opts) throw opts.thenThrow;
}

/** Pull at most `n` items, then break (closing the generator). */
async function take<T>(gen: AsyncGenerator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

const fast = { sleep: async () => {}, random: () => 0 };

describe("resilientSubscription (core)", () => {
  it("yields across reconnects when streams end cleanly", async () => {
    const connect = vi.fn(async () => streamOf(["a", "b"]));
    const gen = resilientSubscription({ connect, ...fast });
    // gen0: a,b → gen1: a,b → gen2: a (5th item) → break
    expect(await take(gen, 5)).toEqual(["a", "b", "a", "b", "a"]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("reconnects after a mid-stream error and surfaces it to onReconnect", async () => {
    const drop = new Error("socket closed");
    let call = 0;
    const onReconnect = vi.fn();
    const connect = vi.fn(async () =>
      call++ === 0 ? streamOf([1], { thenThrow: drop }) : streamOf([2, 3]),
    );
    const gen = resilientSubscription({ connect, onReconnect, ...fast });
    expect(await take(gen, 3)).toEqual([1, 2, 3]);
    expect(onReconnect).toHaveBeenCalledWith(drop, 1, 0);
  });

  it("stops cleanly without calling connect when the signal is pre-aborted", async () => {
    const connect = vi.fn(async () => streamOf([1]));
    const ac = new AbortController();
    ac.abort();
    const gen = resilientSubscription({ connect, signal: ac.signal, ...fast });
    expect(await take(gen, 5)).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("stops cleanly when the caller aborts and the stream then ends without error", async () => {
    // Exercises the post-teardown abort check: the stream completes normally
    // *after* the caller has aborted, so we must return rather than reconnect.
    const ac = new AbortController();
    const connect = vi.fn(async () => streamOf([1]));
    const gen = resilientSubscription({ connect, signal: ac.signal, ...fast });
    const out: number[] = [];
    for await (const x of gen) {
      out.push(x);
      ac.abort(); // abort right after the first item; the stream ends cleanly next
    }
    expect(out).toEqual([1]);
    expect(connect).toHaveBeenCalledTimes(1); // aborted → no reconnect
  });

  it("treats an AbortError from the stream as a clean stop", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    const connect = vi.fn(async () => streamOf<number>([], { thenThrow: abortErr }));
    const gen = resilientSubscription({ connect, ...fast });
    expect(await take(gen, 5)).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("tears down the active stream when the caller aborts mid-flight", async () => {
    // A stream that yields its items then blocks until its connection signal
    // fires — modelling a live WebSocket waiting for the next notification.
    const liveStream = (signal: AbortSignal, items: number[]) =>
      (async function* () {
        for (const it of items) yield it;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("aborted", "AbortError");
      })();

    const ac = new AbortController();
    const connect = vi.fn(async (_gen: number, signal: AbortSignal) =>
      liveStream(signal, [1, 2]),
    );
    const out: number[] = [];
    const gen = resilientSubscription({ connect, signal: ac.signal, ...fast });
    for await (const x of gen) {
      out.push(x);
      if (out.length === 2) ac.abort(); // caller stops the subscription
    }
    expect(out).toEqual([1, 2]);
    expect(connect).toHaveBeenCalledTimes(1); // aborted, not reconnected
  });

  it("aborts the per-connection signal when a stream is torn down", async () => {
    const signals: AbortSignal[] = [];
    const connect = vi.fn(async (_gen: number, signal: AbortSignal) => {
      signals.push(signal);
      return streamOf<number>([]);
    });
    await expect(
      take(resilientSubscription({ connect, maxReconnects: 1, ...fast }), 99),
    ).rejects.toBeInstanceOf(SubscriptionClosedError);
    // Every connection we opened must have been aborted on teardown.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("backs off while failing, but reconnects promptly after delivery", async () => {
    const delays: number[] = [];
    let call = 0;
    const connect = vi.fn(async () =>
      call++ === 0 ? streamOf([1]) : streamOf<number>([]),
    );
    const gen = resilientSubscription({
      connect,
      maxReconnects: 2,
      backoff: { baseDelayMs: 100, jitter: 1 },
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1, // full jitter upper bound → deterministic exp backoff
      onReconnect: () => {},
    });
    await expect(take(gen, 99)).rejects.toBeInstanceOf(SubscriptionClosedError);
    // gen0 delivered → failStreak stays 0 → 100ms; gen1 empty → failStreak 1 → 200ms
    expect(delays).toEqual([100, 200]);
  });

  it("throws SubscriptionClosedError carrying the reconnect count and cause", async () => {
    const boom = new Error("down");
    const connect = vi.fn(async () => streamOf<number>([], { thenThrow: boom }));
    const gen = resilientSubscription({ connect, maxReconnects: 2, ...fast });
    const err = await take(gen, 99).catch((e) => e);
    expect(err).toBeInstanceOf(SubscriptionClosedError);
    expect((err as SubscriptionClosedError).reconnects).toBe(2);
    expect((err as SubscriptionClosedError).cause).toBe(boom);
  });
});

describe("createResilientSubscriptions (adapter)", () => {
  it("throws when constructed with no endpoints", () => {
    expect(() => createResilientSubscriptions({ endpoints: [] })).toThrow(
      /at least one endpoint/,
    );
  });

  it("rotates across endpoints on each reconnect", async () => {
    const used: number[] = [];
    const clientFor = (i: number) => ({ id: i }) as never;
    const subs = createResilientSubscriptions({
      endpoints: ["ws://a", "ws://b"],
      maxReconnects: 2,
      subscriptionsFactory: (url) => clientFor(url === "ws://a" ? 0 : 1),
      ...fast,
    });
    const gen = subs.subscribe(async (client) => {
      used.push((client as unknown as { id: number }).id);
      return streamOf<number>([]);
    });
    await expect(take(gen, 99)).rejects.toBeInstanceOf(SubscriptionClosedError);
    expect(used).toEqual([0, 1, 0]); // gen 0,1,2 → round-robin across 2 clients
    expect(subs.clients).toHaveLength(2);
  });

  it("yields items selected from a rotated client", async () => {
    const subs = createResilientSubscriptions({
      endpoints: [{ url: "ws://only" }],
      subscriptionsFactory: () => ({}) as never,
      ...fast,
    });
    const gen = subs.subscribe(async () => streamOf(["x", "y"]));
    expect(await take(gen, 2)).toEqual(["x", "y"]);
  });

  it("builds clients with the default web3.js factory", () => {
    const subs = createResilientSubscriptions({
      endpoints: ["ws://localhost:8900"],
    });
    expect(subs.clients).toHaveLength(1);
  });
});
