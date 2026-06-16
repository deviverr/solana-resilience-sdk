import { describe, it, expect } from "vitest";
import type { Meter } from "@opentelemetry/api";
import { createOpenTelemetryExporter } from "../src/observability/otel.js";
import type { RpcMetricEvent } from "../src/core/types.js";

function fakeMeter() {
  const counters: Record<string, [number, unknown][]> = {};
  const histograms: Record<string, [number, unknown][]> = {};
  const meter = {
    createCounter: (name: string) => ({
      add: (v: number, a: unknown) => (counters[name] ??= []).push([v, a]),
    }),
    createHistogram: (name: string) => ({
      record: (v: number, a: unknown) => (histograms[name] ??= []).push([v, a]),
    }),
  } as unknown as Meter;
  return { meter, counters, histograms };
}

const ev = (over: Partial<RpcMetricEvent> = {}): RpcMetricEvent => ({
  endpoint: "a",
  method: "getSlot",
  ok: true,
  latencyMs: 50,
  timestamp: 0,
  ...over,
});

describe("createOpenTelemetryExporter", () => {
  it("records request count and latency for successful calls", () => {
    const { meter, counters, histograms } = fakeMeter();
    const exporter = createOpenTelemetryExporter({ meter, prefix: "t" });
    exporter.onEvent?.(ev());
    expect(counters["t.requests"]).toHaveLength(1);
    expect(counters["t.failures"]).toBeUndefined();
    expect(histograms["t.latency"]![0]![0]).toBe(50);
  });

  it("records failures and failovers when present", () => {
    const { meter, counters } = fakeMeter();
    const exporter = createOpenTelemetryExporter({ meter, prefix: "t" });
    exporter.onEvent?.(ev({ ok: false, failedOver: true }));
    expect(counters["t.failures"]).toHaveLength(1);
    expect(counters["t.failovers"]).toHaveLength(1);
  });

  it("falls back to the global meter provider", () => {
    const exporter = createOpenTelemetryExporter();
    expect(() => exporter.onEvent?.(ev())).not.toThrow();
  });
});
