import { describe, it, expect } from "vitest";
import { createResilientTransport } from "../src/core/resilientTransport.js";
import { createResilientClient } from "../src/core/resilientRpc.js";
import { createFeeEstimator } from "../src/fees/feeEstimator.js";
import { staticFeeSource } from "../src/fees/providers.js";
import { DatadogExporter } from "../src/observability/datadog.js";
import { createMonitor } from "../src/monitor/monitor.js";
import { MetricsCollector } from "../src/observability/metrics.js";
import { NodePool } from "../src/core/nodePool.js";
import { ResilientSender, type SenderRpc } from "../src/relay/sender.js";
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
