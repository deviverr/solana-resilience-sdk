import { describe, it, expect } from "vitest";
import { NodePool, Endpoint, percentile } from "../src/core/nodePool.js";

const cfg = (url: string, weight?: number) => ({ url, weight });

describe("percentile", () => {
  it("handles empty and single-element inputs", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([42], 95)).toBe(42);
  });
  it("interpolates between samples", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });
});

describe("NodePool", () => {
  it("throws when constructed with no endpoints", () => {
    expect(() => new NodePool([])).toThrow(/at least one/);
  });

  it("round-robin cycles through endpoints", () => {
    const pool = new NodePool([cfg("a"), cfg("b"), cfg("c")], {
      strategy: "round-robin",
    });
    const seen = [
      pool.acquire()!.url,
      pool.acquire()!.url,
      pool.acquire()!.url,
      pool.acquire()!.url,
    ];
    expect(seen).toEqual(["a", "b", "c", "a"]);
  });

  it("least-latency prefers the fastest endpoint, trying unproven ones first", () => {
    const pool = new NodePool([cfg("slow"), cfg("fast")], {
      strategy: "least-latency",
    });
    // Both unproven → first wins.
    expect(pool.acquire()!.url).toBe("slow");
    pool.endpoints[0]!.recordSuccess(500);
    pool.endpoints[1]!.recordSuccess(50);
    expect(pool.acquire()!.url).toBe("fast");
  });

  it("least-inflight prefers the least-busy endpoint", () => {
    const pool = new NodePool([cfg("a"), cfg("b")], {
      strategy: "least-inflight",
    });
    pool.endpoints[0]!.inflight = 5;
    pool.endpoints[1]!.inflight = 1;
    expect(pool.acquire()!.url).toBe("b");
  });

  it("weighted-random respects weights via the injected RNG", () => {
    const pool = new NodePool([cfg("a", 1), cfg("b", 9)], {
      strategy: "weighted-random",
      random: () => 0.5, // 0.5 * 10 = 5 → falls into b's weight band
    });
    expect(pool.acquire()!.url).toBe("b");
  });

  it("excludes endpoints with an open circuit", () => {
    const pool = new NodePool([cfg("a"), cfg("b")], {
      strategy: "round-robin",
      breaker: { failureThreshold: 1 },
    });
    pool.endpoints[0]!.recordFailure(10, new Error("x")); // opens a's circuit
    const picked = pool.acquire()!;
    expect(picked.url).toBe("b");
  });

  it("returns null when every circuit is open", () => {
    const pool = new NodePool([cfg("a")], { breaker: { failureThreshold: 1 } });
    pool.endpoints[0]!.recordFailure(10, new Error("x"));
    expect(pool.acquire()).toBeNull();
  });

  it("falls back to circuit availability when all are marked unhealthy", () => {
    const pool = new NodePool([cfg("a"), cfg("b")]);
    pool.endpoints[0]!.healthy = false;
    pool.endpoints[1]!.healthy = false;
    // Health flags say down, but circuits are closed → still selectable.
    expect(pool.acquire()).not.toBeNull();
  });

  it("acquireExcluding skips already-tried endpoints", () => {
    const pool = new NodePool([cfg("a"), cfg("b")], {
      strategy: "round-robin",
    });
    const first = pool.acquire()!;
    const second = pool.acquireExcluding(new Set([first]))!;
    expect(second.url).not.toBe(first.url);
    expect(pool.acquireExcluding(new Set(pool.endpoints))).toBeNull();
  });

  it("tracks stats in snapshots", () => {
    const pool = new NodePool([cfg("a")]);
    pool.endpoints[0]!.recordSuccess(100);
    pool.endpoints[0]!.recordFailure(200, new Error("oops"));
    const [snap] = pool.snapshot();
    expect(snap!.totalRequests).toBe(2);
    expect(snap!.totalFailures).toBe(1);
    expect(snap!.lastError).toBe("oops");
    expect(snap!.avgLatencyMs).toBeGreaterThan(0);
  });
});

describe("Endpoint", () => {
  it("derives a name from the URL host when unnamed", () => {
    const ep = new Endpoint({ url: "https://rpc.example.com/path" });
    expect(ep.name).toBe("rpc.example.com");
  });
  it("falls back to the raw string for non-URL inputs", () => {
    const ep = new Endpoint({ url: "not a url" });
    expect(ep.name).toBe("not a url");
  });
});
