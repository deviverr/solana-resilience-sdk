import { describe, it, expect, vi } from "vitest";
import { DatadogExporter } from "../src/observability/datadog.js";
import type { RpcMetricEvent } from "../src/core/types.js";

const ev = (over: Partial<RpcMetricEvent> = {}): RpcMetricEvent => ({
  endpoint: "a",
  method: "getSlot",
  ok: true,
  latencyMs: 100,
  timestamp: 0,
  ...over,
});

describe("DatadogExporter", () => {
  it("buffers events and submits a series payload on flush", async () => {
    const fetchFn = vi.fn(
      async (
        _url: string,
        _init: { method: string; headers: Record<string, string>; body: string },
      ) => ({ ok: true, status: 202 }),
    );
    const exporter = new DatadogExporter({
      apiKey: "secret",
      flushIntervalMs: 0,
      fetchFn,
      clock: () => 1_000_000,
      tags: ["env:test"],
    });
    exporter.onEvent(ev());
    exporter.onEvent(ev({ ok: false }));
    await exporter.flush();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain("datadoghq.com/api/v1/series");
    expect(init.headers["DD-API-KEY"]).toBe("secret");
    const body = JSON.parse(init.body) as {
      series: { metric: string; points: number[][]; tags: string[] }[];
    };
    const requests = body.series.find((s) => s.metric === "solana.rpc.requests");
    expect(requests!.points[0]![1]).toBe(2);
    expect(requests!.tags).toContain("env:test");
    expect(requests!.points[0]![0]).toBe(1_000); // ms → seconds
  });

  it("no-ops when there is nothing buffered", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }));
    const exporter = new DatadogExporter({ apiKey: "k", flushIntervalMs: 0, fetchFn });
    await exporter.flush();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when Datadog rejects the submission", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403 }));
    const exporter = new DatadogExporter({ apiKey: "k", flushIntervalMs: 0, fetchFn });
    exporter.onEvent(ev());
    await expect(exporter.flush()).rejects.toThrow(/status 403/);
  });

  it("auto-flushes on the configured interval and cleans up on shutdown", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 202 }));
    let intervalCb: (() => void) | undefined;
    let cleared = false;
    const exporter = new DatadogExporter({
      apiKey: "k",
      flushIntervalMs: 5_000,
      fetchFn,
      setIntervalFn: (cb) => {
        intervalCb = cb;
        return 1;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    exporter.onEvent(ev());
    intervalCb?.();
    await new Promise((r) => setImmediate(r));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await exporter.shutdown();
    expect(cleared).toBe(true);
  });
});
