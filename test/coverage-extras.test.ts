import { describe, it, expect } from "vitest";
import { createResilientTransport } from "../src/core/resilientTransport.js";
import { createResilientClient } from "../src/core/resilientRpc.js";
import { createFeeEstimator } from "../src/fees/feeEstimator.js";
import { staticFeeSource, heliusPriorityFeeSource } from "../src/fees/providers.js";
import { DatadogExporter, createDatadogExporter } from "../src/observability/datadog.js";
import { createMonitor } from "../src/monitor/monitor.js";
import { MetricsCollector } from "../src/observability/metrics.js";
import { NodePool } from "../src/core/nodePool.js";
import {
  ResilientSender,
  createResilientSender,
  type SenderRpc,
} from "../src/relay/sender.js";
import {
  AllEndpointsFailedError,
  TransactionConfirmationError,
} from "../src/core/errors.js";
import { base58Encode, bytesToBase64 } from "../src/util/base58.js";
import { manualClock, SimulatedNetwork, payloadFor } from "./mocks/networkSimulator.js";

/**
 * Exercises the production default paths (real default factories/timers) that
 * the deterministic tests inject around, without performing any network I/O.
 */
describe("default wiring paths", () => {
  it("builds a transport with web3.js's default transport factory", () => {
    // No transportFactory → uses createDefaultRpcTransport for each endpoint.
    // Construction must not perform any network call.
    const { pool } = createResilientTransport({
      endpoints: [{ url: "https://rpc.example.com", headers: { "x-api": "k" } }],
    });
    expect(pool.endpoints).toHaveLength(1);
  });

  it("accepts healthCheck: true and wires default options", async () => {
    const client = createResilientClient({
      endpoints: [{ url: "https://rpc.example.com" }],
      healthCheck: true,
    });
    expect(client.healthChecker).toBeDefined();
    await client.close();
  });

  it("createFeeEstimator factory produces a working estimator", async () => {
    const est = createFeeEstimator({ sources: [staticFeeSource(123)] });
    expect((await est.estimate()).microLamportsPerCu).toBe(123);
  });

  it("DatadogExporter uses real timers by default and cleans up", async () => {
    const exporter = new DatadogExporter({
      apiKey: "k",
      flushIntervalMs: 60_000,
      fetchFn: (async () => ({ ok: true, status: 202 })) as never,
    });
    await exporter.shutdown(); // clears the real interval
    expect(exporter.name).toBe("datadog");
  });

  it("Monitor uses real timers by default and stops", () => {
    const monitor = createMonitor({
      collector: new MetricsCollector(),
      pool: new NodePool([{ url: "https://a.test" }]),
    });
    monitor.start(60_000);
    monitor.stop();
    expect(monitor.snapshot().endpoints).toHaveLength(1);
  });

  it("createResilientSender factory returns a working sender", async () => {
    const rpc: SenderRpc = {
      sendTransaction: () => ({ send: async () => "sig" }),
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [{ confirmationStatus: "confirmed" as const, err: null }],
        }),
      }),
      getEpochInfo: () => ({ send: async () => ({ blockHeight: 0 }) }),
    };
    const sender = createResilientSender({ rpc });
    const result = await sender.send({ base64Transaction: "TX", signature: "sig" });
    expect(result.confirmed).toBe(true);
    expect(result.route).toBe("rpc");
  });

  it("createDatadogExporter factory builds an exporter", async () => {
    const exporter = createDatadogExporter({
      apiKey: "k",
      flushIntervalMs: 60_000,
      fetchFn: (async () => ({ ok: true, status: 202 })) as never,
    });
    expect(exporter).toBeInstanceOf(DatadogExporter);
    await exporter.shutdown();
  });

  it("acquireExcluding honors the least-inflight strategy", () => {
    const pool = new NodePool([{ url: "a" }, { url: "b" }, { url: "c" }], {
      strategy: "least-inflight",
    });
    pool.endpoints[1]!.inflight = 9;
    pool.endpoints[2]!.inflight = 1;
    const first = pool.acquire()!; // a (all unproven → lowest inflight = a@0)
    const next = pool.acquireExcluding(new Set([first]))!;
    expect(next.url).toBe("c"); // c (inflight 1) beats b (inflight 9)
  });

  it("acquireExcluding honors the weighted-random strategy", () => {
    const pool = new NodePool([{ url: "a", weight: 1 }, { url: "b", weight: 5 }], {
      strategy: "weighted-random",
      random: () => 0.99,
    });
    const first = pool.acquire()!;
    const next = pool.acquireExcluding(new Set([first]))!;
    expect(next.url).not.toBe(first.url); // only one candidate remains
  });

  it("weighted-random falls back to the first candidate when all weights are zero", () => {
    const pool = new NodePool([{ url: "a", weight: 0 }, { url: "b", weight: 0 }], {
      strategy: "weighted-random",
      random: () => 0.5,
    });
    expect(pool.acquire()!.url).toBe("a");
  });

  it("base58 round-trips leading zeros and matches a known vector", () => {
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
    // "hello world" → known base58 vector.
    const hello = new TextEncoder().encode("hello world");
    expect(base58Encode(hello)).toBe("StV1DL6CwTryKyV");
  });

  it("bytesToBase64 uses the browser btoa fallback when Buffer is absent", () => {
    const original = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      (globalThis as { Buffer?: unknown }).Buffer = undefined;
      expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk="); // "hi"
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = original;
    }
  });

  it("wraps a non-Error value thrown by the upstream transport", async () => {
    // String (non-Error) rejections must be normalized to Error for diagnostics.
    const transportFactory = () =>
      (async () => {
        throw "boom-string";
      }) as never;
    const { transport } = createResilientTransport({
      endpoints: [{ url: "a" }],
      transportFactory,
      backoff: { baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      sleep: async () => {},
    });
    const err = await transport(payloadFor("getSlot")).catch((e) => e);
    expect(err).toBeInstanceOf(AllEndpointsFailedError);
    expect((err as AllEndpointsFailedError).attempts[0]!.error.message).toBe(
      "boom-string",
    );
  });

  it("builds upstreams for a shared pool larger than the endpoint config list", async () => {
    const net = new SimulatedNetwork();
    const pool = new NodePool([{ url: "a" }, { url: "b" }]);
    const { transport, transports } = createResilientTransport({
      endpoints: [{ url: "a" }], // fewer than the shared pool
      pool,
      transportFactory: net.transportFactory,
      clock: net.clock.now,
      sleep: net.sleep,
    });
    // Endpoint 'b' had no matching config entry → synthesized as { url }.
    expect(transports.size).toBe(2);
    const res = await transport<{ result: unknown }>(payloadFor("getSlot"));
    expect(res.result).toBe(123);
  });

  it("AllEndpointsFailedError renders cleanly with no attempts", () => {
    const err = new AllEndpointsFailedError("getSlot", []);
    expect(err.message).toBe('All 0 endpoint(s) failed for "getSlot"');
    expect(err.attempts).toHaveLength(0);
  });

  it("weighted-random returns the last candidate when the RNG hits its upper bound", () => {
    const pool = new NodePool([{ url: "a", weight: 1 }, { url: "b", weight: 1 }], {
      strategy: "weighted-random",
      random: () => 1, // r is decremented to exactly 0, never < 0 → falls through
    });
    expect(pool.acquire()!.url).toBe("b");
  });

  it("DatadogExporter uses every default (fetch, clock, timers, interval)", async () => {
    // Only apiKey supplied → default fetch, clock, setInterval/clearInterval and
    // the default 10s flush interval (the timer is unref'd and cleared below).
    const exporter = new DatadogExporter({ apiKey: "k" });
    expect(exporter.name).toBe("datadog");
    await exporter.shutdown(); // clears the default interval; no events → no network
  });

  it("heliusPriorityFeeSource defaults to the global fetch when none is given", () => {
    expect(heliusPriorityFeeSource({ url: "https://helius.test" }).name).toBe(
      "helius",
    );
  });

  it("MetricsCollector evicts the oldest latency sample beyond the window", () => {
    const c = new MetricsCollector();
    for (let i = 0; i < 600; i++) {
      c.record({ endpoint: "a", method: "m", ok: true, latencyMs: i, timestamp: 0 });
    }
    const snap = c.snapshot();
    expect(snap.totalRequests).toBe(600);
    // The window is capped at 500, so the small early latencies are evicted and
    // the median reflects only the most recent samples (100..599).
    expect(snap.p50LatencyMs).toBeGreaterThan(300);
  });

  it("swallows errors thrown while rebroadcasting an unconfirmed transaction", async () => {
    const clock = manualClock();
    let sends = 0;
    const rpc: SenderRpc = {
      sendTransaction: () => ({
        send: async () => {
          if (sends++ > 0) throw new Error("rebroadcast failed"); // initial ok, then fail
          return "sig";
        },
      }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
      getEpochInfo: () => ({ send: async () => ({ blockHeight: 0 }) }),
    };
    const sender = new ResilientSender({
      rpc,
      clock: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });
    await expect(
      sender.send(
        { base64Transaction: "TX", signature: "sig" },
        { confirmTimeoutMs: 5_000, pollIntervalMs: 1_000 },
      ),
    ).rejects.toBeInstanceOf(TransactionConfirmationError);
    expect(sends).toBeGreaterThan(1); // a rebroadcast was attempted and its error swallowed
  });

  it("truncates an over-long endpoint name in the rendered dashboard", () => {
    const longName = "this-is-a-really-long-endpoint-name-way-over-28-characters";
    const text = createMonitor({
      collector: new MetricsCollector(),
      pool: new NodePool([{ url: "https://x.test", name: longName }]),
    }).render();
    expect(text).toContain(longName.slice(0, 28));
    expect(text).not.toContain(longName); // full name truncated to the column width
  });

  it("caps an endpoint's latency window and still computes p95", () => {
    const pool = new NodePool([{ url: "a" }]);
    for (let i = 0; i < 150; i++) pool.endpoints[0]!.recordSuccess(i);
    expect(pool.endpoints[0]!.stats().p95LatencyMs).toBeGreaterThan(0);
  });

  it("acquireExcluding (least-latency) scores a proven remaining endpoint by latency", () => {
    const pool = new NodePool([{ url: "a" }, { url: "b" }], {
      strategy: "least-latency",
    });
    pool.endpoints[0]!.recordSuccess(10);
    pool.endpoints[1]!.recordSuccess(20);
    const first = pool.acquire()!; // a (lower latency)
    const next = pool.acquireExcluding(new Set([first]))!;
    expect(next.url).toBe("b"); // b scored by its own avgLatencyMs, not the unproven sentinel
  });

  it("Monitor.stop() is a no-op when it was never started", () => {
    const monitor = createMonitor({
      collector: new MetricsCollector(),
      pool: new NodePool([{ url: "https://a.test" }]),
    });
    expect(() => monitor.stop()).not.toThrow();
  });

  it("renders a recent failure that carries no error message", () => {
    const collector = new MetricsCollector();
    collector.record({
      endpoint: "a",
      method: "getSlot",
      ok: false,
      latencyMs: 5,
      timestamp: 0,
    }); // no `error` field → render falls back to the literal "error"
    const text = createMonitor({
      collector,
      pool: new NodePool([{ url: "https://a.test" }]),
    }).render();
    expect(text).toContain("recent failures");
  });

  it("keeps polling when a status has no confirmation level yet", async () => {
    const clock = manualClock();
    let polls = 0;
    const rpc: SenderRpc = {
      sendTransaction: () => ({ send: async () => "sig" }),
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [
            polls++ === 0
              ? { confirmationStatus: undefined, err: null } // present, not yet confirmed
              : { confirmationStatus: "confirmed" as const, err: null },
          ],
        }),
      }),
      getEpochInfo: () => ({ send: async () => ({ blockHeight: 0 }) }),
    };
    const sender = new ResilientSender({
      rpc,
      clock: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });
    const result = await sender.send(
      { base64Transaction: "TX", signature: "sig" },
      { pollIntervalMs: 1_000 },
    );
    expect(result.confirmed).toBe(true);
  });

  it("sender treats a non-expired blockhash as still pending", async () => {
    const clock = manualClock();
    let polls = 0;
    const rpc: SenderRpc = {
      sendTransaction: () => ({ send: async () => "sig" }),
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [
            polls++ === 0
              ? null
              : { confirmationStatus: "confirmed" as const, err: null },
          ],
        }),
      }),
      getEpochInfo: () => ({ send: async () => ({ blockHeight: 50 }) }),
    };
    const sender = new ResilientSender({
      rpc,
      clock: clock.now,
      sleep: async (ms) => clock.advance(ms),
    });
    // blockHeight (50) <= lastValidBlockHeight (100) → not expired, keeps polling.
    const result = await sender.send(
      { base64Transaction: "TX", signature: "sig", lastValidBlockHeight: 100 },
      { pollIntervalMs: 1_000 },
    );
    expect(result.confirmed).toBe(true);
  });
});
