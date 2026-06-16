import { describe, it, expect, vi } from "vitest";
import {
  HealthChecker,
  createGetHealthProbe,
} from "../src/core/healthChecker.js";
import { NodePool } from "../src/core/nodePool.js";
import type { Transport } from "../src/core/types.js";

const pool = () => new NodePool([{ url: "a" }, { url: "b" }]);

describe("createGetHealthProbe", () => {
  it("reports healthy when the transport resolves", async () => {
    const transports = new Map<string, Transport>([
      ["a", (async () => ({ result: "ok" })) as Transport],
    ]);
    const probe = createGetHealthProbe(transports, () => 0);
    const p = pool();
    const result = await probe(p.endpoints[0]!);
    expect(result.ok).toBe(true);
  });

  it("reports unhealthy when no transport is registered", async () => {
    const probe = createGetHealthProbe(new Map());
    const result = await probe(pool().endpoints[0]!);
    expect(result).toEqual({ ok: false, latencyMs: 0 });
  });
});

describe("HealthChecker", () => {
  it("marks endpoints healthy/unhealthy from probe results", async () => {
    const p = pool();
    const probe = vi.fn(async (ep) =>
      ep.url === "a"
        ? { ok: true, latencyMs: 5 }
        : { ok: false, latencyMs: 0 },
    );
    const checker = new HealthChecker(p, probe);
    await checker.checkOnce();
    expect(p.endpoints[0]!.healthy).toBe(true);
    expect(p.endpoints[1]!.healthy).toBe(false);
    expect(p.endpoints[1]!.totalFailures).toBe(1);
  });

  it("treats a thrown probe as unhealthy", async () => {
    const p = pool();
    const checker = new HealthChecker(p, async () => {
      throw new Error("connection refused");
    });
    await checker.checkOnce();
    expect(p.endpoints[0]!.healthy).toBe(false);
    expect(p.endpoints[0]!.lastError).toContain("connection refused");
  });

  it("runs immediately and on an interval, and stops cleanly", async () => {
    const p = pool();
    const probe = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    let intervalCb: (() => void) | undefined;
    let cleared = false;
    const checker = new HealthChecker(p, probe, {
      intervalMs: 100,
      setIntervalFn: (cb) => {
        intervalCb = cb;
        return 7;
      },
      clearIntervalFn: (h) => {
        cleared = h === 7;
      },
    });
    checker.start();
    checker.start(); // idempotent
    await new Promise((r) => setImmediate(r));
    expect(probe).toHaveBeenCalled(); // immediate run
    intervalCb?.();
    await new Promise((r) => setImmediate(r));
    checker.stop();
    expect(cleared).toBe(true);
    checker.stop(); // idempotent
  });
});
