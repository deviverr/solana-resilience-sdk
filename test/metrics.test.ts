import { describe, it, expect, vi } from "vitest";
import { MetricsCollector } from "../src/observability/metrics.js";
import type { RpcMetricEvent } from "../src/core/types.js";

const ev = (over: Partial<RpcMetricEvent> = {}): RpcMetricEvent => ({
  endpoint: "a",
  method: "getSlot",
  ok: true,
  latencyMs: 100,
  timestamp: 0,
  ...over,
});

describe("MetricsCollector", () => {
  it("aggregates global, per-endpoint and per-method stats", () => {
    const c = new MetricsCollector();
    c.record(ev({ latencyMs: 100 }));
    c.record(ev({ latencyMs: 300, ok: false, error: "boom" }));
    c.record(ev({ endpoint: "b", method: "getBlock", latencyMs: 200 }));

    const s = c.snapshot();
    expect(s.totalRequests).toBe(3);
    expect(s.totalFailures).toBe(1);
    expect(s.failureRate).toBeCloseTo(1 / 3);
    expect(s.avgLatencyMs).toBeCloseTo(200);
    expect(s.perEndpoint["a"]!.requests).toBe(2);
    expect(s.perEndpoint["a"]!.failures).toBe(1);
    expect(s.perMethod["getBlock"]!.requests).toBe(1);
    expect(s.recentFailures).toHaveLength(1);
  });

  it("computes latency percentiles", () => {
    const c = new MetricsCollector();
    for (let i = 1; i <= 100; i++) c.record(ev({ latencyMs: i }));
    const s = c.snapshot();
    expect(s.p50LatencyMs).toBeGreaterThan(40);
    expect(s.p95LatencyMs).toBeGreaterThan(s.p50LatencyMs);
    expect(s.p99LatencyMs).toBeGreaterThanOrEqual(s.p95LatencyMs);
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const c = new MetricsCollector();
    const seen: RpcMetricEvent[] = [];
    const off = c.subscribe((e) => seen.push(e));
    c.record(ev());
    off();
    c.record(ev());
    expect(seen).toHaveLength(1);
  });

  it("forwards events to exporters and supports removal", async () => {
    const c = new MetricsCollector();
    const onEvent = vi.fn();
    const flush = vi.fn();
    const shutdown = vi.fn();
    const remove = c.addExporter({ name: "x", onEvent, flush, shutdown });
    c.record(ev());
    await c.flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    await c.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
    remove();
    c.record(ev());
    expect(onEvent).toHaveBeenCalledTimes(1); // not called after removal
  });

  it("caps the recent-failures buffer", () => {
    const c = new MetricsCollector();
    for (let i = 0; i < 40; i++) c.record(ev({ ok: false, error: `e${i}` }));
    expect(c.snapshot().recentFailures.length).toBeLessThanOrEqual(25);
  });
});
