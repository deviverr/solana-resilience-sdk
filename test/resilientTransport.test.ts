import { describe, it, expect } from "vitest";
import {
  createResilientTransport,
  methodOf,
} from "../src/core/resilientTransport.js";
import {
  AllEndpointsFailedError,
  NoHealthyEndpointsError,
} from "../src/core/errors.js";
import { MetricsCollector } from "../src/observability/metrics.js";
import { SimulatedNetwork, payloadFor } from "./mocks/networkSimulator.js";

function build(net: SimulatedNetwork, opts = {}) {
  return createResilientTransport({
    endpoints: [{ url: "a" }, { url: "b" }, { url: "c" }],
    transportFactory: net.transportFactory,
    clock: net.clock.now,
    sleep: net.sleep,
    strategy: "least-latency",
    ...opts,
  });
}

describe("methodOf", () => {
  it("reads the method from a payload", () => {
    expect(methodOf({ method: "getSlot" })).toBe("getSlot");
  });
  it("handles batches and unknowns", () => {
    expect(methodOf([{ method: "getSlot" }])).toBe("getSlot(+batch)");
    expect(methodOf([{}])).toBe("batch");
    expect(methodOf({})).toBe("unknown");
    expect(methodOf(null)).toBe("unknown");
  });
});

describe("createResilientTransport", () => {
  it("returns a result and records success metrics", async () => {
    const net = new SimulatedNetwork();
    const metrics = new MetricsCollector();
    const { transport, pool } = build(net, { metrics });
    const res = await transport<{ result: unknown }>(payloadFor("getSlot"));
    expect(res.result).toBe(123);
    expect(pool.endpoints[0]!.totalRequests).toBe(1);
    expect(metrics.snapshot().totalRequests).toBe(1);
    expect(metrics.snapshot().totalFailures).toBe(0);
  });

  it("fails over to the next endpoint when one errors", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { alwaysFail: true });
    const metrics = new MetricsCollector();
    const { transport } = build(net, { metrics });

    const res = await transport<{ result: unknown }>(payloadFor("getSlot"));
    expect(res.result).toBe(123);
    // a failed, b served.
    expect(net.callCount("a")).toBe(1);
    expect(net.callCount("b")).toBe(1);
    const snap = metrics.snapshot();
    expect(snap.totalFailures).toBe(1);
    expect(snap.totalRequests).toBe(2);
  });

  it("throws AllEndpointsFailedError when every endpoint fails", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { alwaysFail: true });
    net.set("b", { alwaysFail: true });
    net.set("c", { alwaysFail: true });
    const { transport } = build(net);
    await expect(transport(payloadFor("getSlot"))).rejects.toBeInstanceOf(
      AllEndpointsFailedError,
    );
  });

  it("throws NoHealthyEndpointsError when all circuits are open", async () => {
    const net = new SimulatedNetwork();
    const { transport, pool } = build(net, {
      breaker: { failureThreshold: 1 },
    });
    pool.endpoints.forEach((e) => e.recordFailure(1, new Error("x")));
    await expect(transport(payloadFor("getSlot"))).rejects.toBeInstanceOf(
      NoHealthyEndpointsError,
    );
  });

  it("does not fail over when the caller aborts", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { alwaysFail: true });
    const controller = new AbortController();
    controller.abort();
    const { transport } = build(net);
    await expect(
      transport({ payload: payloadFor("getSlot").payload, signal: controller.signal }),
    ).rejects.toThrow(/simulated failure/);
    // Only the first endpoint was tried.
    expect(net.callCount("b")).toBe(0);
  });

  it("respects a custom shouldFailover predicate", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { alwaysFail: true });
    const { transport } = build(net, { shouldFailover: () => false });
    await expect(transport(payloadFor("getSlot"))).rejects.toThrow(
      /simulated failure/,
    );
    expect(net.callCount("b")).toBe(0);
  });

  it("limits the number of failover attempts", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { alwaysFail: true });
    net.set("b", { alwaysFail: true });
    net.set("c", { alwaysFail: true });
    const { transport } = build(net, { maxFailovers: 2 });
    await expect(transport(payloadFor("getSlot"))).rejects.toBeInstanceOf(
      AllEndpointsFailedError,
    );
    expect(net.callCount("c")).toBe(0); // capped at 2 endpoints
  });

  it("recovers a flaky endpoint on a subsequent call", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { failTimes: 1 }); // first call fails, then succeeds
    const { transport } = createResilientTransport({
      endpoints: [{ url: "a" }],
      transportFactory: net.transportFactory,
      clock: net.clock.now,
      sleep: net.sleep,
    });
    // Single endpoint, first attempt fails → surfaces as an aggregate error.
    await expect(transport(payloadFor("getSlot"))).rejects.toBeInstanceOf(
      AllEndpointsFailedError,
    );
    // Second call: the endpoint has recovered.
    const res = await transport<{ result: unknown }>(payloadFor("getSlot"));
    expect(res.result).toBe(123);
  });
});
