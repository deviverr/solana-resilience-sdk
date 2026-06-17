import { describe, it, expect } from "vitest";
import { createResilientTransport } from "../src/core/resilientTransport.js";
import { createResilientClient } from "../src/core/resilientRpc.js";
import { createFeeEstimator } from "../src/fees/feeEstimator.js";
import { staticFeeSource } from "../src/fees/providers.js";
import { DatadogExporter, createDatadogExporter } from "../src/observability/datadog.js";
import { createMonitor } from "../src/monitor/monitor.js";
import { MetricsCollector } from "../src/observability/metrics.js";
import { NodePool } from "../src/core/nodePool.js";
import {
  ResilientSender,
  createResilientSender,
  type SenderRpc,
} from "../src/relay/sender.js";
import { base58Encode, bytesToBase64 } from "../src/util/base58.js";
import { manualClock } from "./mocks/networkSimulator.js";

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
