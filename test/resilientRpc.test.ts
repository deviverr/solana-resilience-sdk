import { describe, it, expect } from "vitest";
import {
  createResilientRpc,
  createResilientClient,
} from "../src/core/resilientRpc.js";
import { SimulatedNetwork } from "./mocks/networkSimulator.js";

describe("createResilientRpc (web3.js v2 integration)", () => {
  it("acts as a drop-in v2 RPC and returns decoded results", async () => {
    const net = new SimulatedNetwork();
    const rpc = createResilientRpc({
      endpoints: [{ url: "a" }, { url: "b" }],
      transportFactory: net.transportFactory,
      clock: net.clock.now,
      sleep: net.sleep,
    });
    // getSlot is typed to return a bigint by web3.js — proves the envelope
    // flows through the real RPC API layer, not just our transport.
    const slot = await rpc.getSlot().send();
    expect(slot).toBe(123n);
  });

  it("fails the first endpoint over to the second through the real RPC", async () => {
    const net = new SimulatedNetwork();
    net.set("a", { alwaysFail: true });
    const rpc = createResilientRpc({
      endpoints: [{ url: "a" }, { url: "b" }],
      transportFactory: net.transportFactory,
      clock: net.clock.now,
      sleep: net.sleep,
      strategy: "round-robin",
    });
    const slot = await rpc.getSlot().send();
    expect(slot).toBe(123n);
    expect(net.callCount("b")).toBe(1);
  });
});

describe("createResilientClient", () => {
  it("exposes pool + metrics and shares the collector", async () => {
    const net = new SimulatedNetwork();
    const client = createResilientClient({
      endpoints: [{ url: "a" }],
      transportFactory: net.transportFactory,
      clock: net.clock.now,
      sleep: net.sleep,
    });
    expect(client.healthChecker).toBeUndefined();
    await client.rpc.getSlot().send();
    expect(client.metrics.snapshot().totalRequests).toBe(1);
    await client.close();
  });

  it("starts a health checker when enabled and stops it on close", async () => {
    const net = new SimulatedNetwork();
    let tick: (() => void) | undefined;
    let cleared = false;
    const client = createResilientClient({
      endpoints: [{ url: "a" }],
      transportFactory: net.transportFactory,
      clock: net.clock.now,
      sleep: net.sleep,
      healthCheck: {
        intervalMs: 1_000,
        setIntervalFn: (cb) => {
          tick = cb;
          return 1;
        },
        clearIntervalFn: () => {
          cleared = true;
        },
      },
    });
    expect(client.healthChecker).toBeDefined();
    expect(typeof tick).toBe("function");
    // Let the immediate checkOnce resolve.
    await new Promise((r) => setImmediate(r));
    expect(client.pool.endpoints[0]!.healthy).toBe(true);
    await client.close();
    expect(cleared).toBe(true);
  });
});
