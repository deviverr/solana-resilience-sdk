import { describe, it, expect } from "vitest";
import { Monitor } from "../src/monitor/monitor.js";
import { MetricsCollector } from "../src/observability/metrics.js";
import { NodePool } from "../src/core/nodePool.js";
import { manualClock } from "./mocks/networkSimulator.js";

function setup() {
  const collector = new MetricsCollector();
  const pool = new NodePool([{ url: "https://a.test" }, { url: "https://b.test" }]);
  return { collector, pool };
}

describe("Monitor", () => {
  it("combines pool health and metrics into a snapshot", () => {
    const { collector, pool } = setup();
    collector.record({
      endpoint: "a.test",
      method: "getSlot",
      ok: true,
      latencyMs: 50,
      timestamp: 0,
    });
    pool.endpoints[0]!.recordSuccess(50);
    const monitor = new Monitor({ collector, pool, clock: () => 123 });
    const snap = monitor.snapshot();
    expect(snap.timestamp).toBe(123);
    expect(snap.metrics.totalRequests).toBe(1);
    expect(snap.endpoints).toHaveLength(2);
  });

  it("renders a text dashboard with headers, rows and failures", () => {
    const { collector, pool } = setup();
    pool.endpoints[1]!.healthy = false;
    collector.record({
      endpoint: "a.test",
      method: "getSlot",
      ok: false,
      latencyMs: 80,
      timestamp: 0,
      error: "timeout",
    });
    const monitor = new Monitor({ collector, pool });
    const text = monitor.render();
    expect(text).toContain("Live Monitor");
    expect(text).toContain("ENDPOINT");
    expect(text).toContain("a.test");
    expect(text).toContain("down");
    expect(text).toContain("recent failures");
    expect(text).toContain("timeout");
  });

  it("emits periodic snapshots to subscribers and stops cleanly", () => {
    const { collector, pool } = setup();
    let intervalCb: (() => void) | undefined;
    let cleared = false;
    const monitor = new Monitor({
      collector,
      pool,
      clock: manualClock().now,
      setIntervalFn: (cb) => {
        intervalCb = cb;
        return 3;
      },
      clearIntervalFn: (h) => {
        cleared = h === 3;
      },
    });
    const seen: number[] = [];
    monitor.onUpdate((s) => seen.push(s.endpoints.length));
    monitor.start(500);
    monitor.start(500); // idempotent
    expect(seen.length).toBe(1); // immediate emit
    intervalCb?.();
    expect(seen.length).toBe(2);
    monitor.stop();
    expect(cleared).toBe(true);
  });
});
