import { describe, it, expect, vi } from "vitest";
import {
  PrometheusExporter,
  createPrometheusExporter,
  PROMETHEUS_CONTENT_TYPE,
} from "../src/observability/prometheus.js";
import type { RpcMetricEvent } from "../src/core/types.js";

const ev = (over: Partial<RpcMetricEvent> = {}): RpcMetricEvent => ({
  endpoint: "a.rpc",
  method: "getSlot",
  ok: true,
  latencyMs: 30,
  timestamp: 0,
  ...over,
});

/** Parse a single `metric{labels} value` line into its numeric value. */
function valueOf(text: string, line: string): number | undefined {
  const match = text.split("\n").find((l) => l.startsWith(line));
  return match ? Number(match.slice(match.lastIndexOf(" ") + 1)) : undefined;
}

describe("PrometheusExporter", () => {
  it("renders counters and a histogram in exposition format", () => {
    const prom = new PrometheusExporter();
    prom.onEvent(ev({ latencyMs: 30 }));
    prom.onEvent(ev({ latencyMs: 30 }));
    prom.onEvent(ev({ ok: false, latencyMs: 400, failedOver: true }));
    const text = prom.render();

    expect(text).toContain("# TYPE solana_rpc_requests_total counter");
    expect(text).toContain("# TYPE solana_rpc_latency_milliseconds histogram");
    expect(
      valueOf(text, 'solana_rpc_requests_total{endpoint="a.rpc",method="getSlot"}'),
    ).toBe(3);
    expect(
      valueOf(text, 'solana_rpc_failures_total{endpoint="a.rpc",method="getSlot"}'),
    ).toBe(1);
    expect(
      valueOf(text, 'solana_rpc_failovers_total{endpoint="a.rpc",method="getSlot"}'),
    ).toBe(1);
    expect(text).toMatch(/_latency_milliseconds_count\{[^}]*} 3/);
    expect(text).toMatch(/_latency_milliseconds_sum\{[^}]*} 460/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("builds cumulative histogram buckets with a terminal +Inf", () => {
    const prom = new PrometheusExporter({ buckets: [10, 100, 1000] });
    prom.onEvent(ev({ latencyMs: 5 })); // ≤10
    prom.onEvent(ev({ latencyMs: 50 })); // ≤100
    prom.onEvent(ev({ latencyMs: 5000 })); // overflow → only +Inf
    const text = prom.render();

    expect(valueOf(text, 'solana_rpc_latency_milliseconds_bucket{endpoint="a.rpc",method="getSlot",le="10"}')).toBe(1);
    expect(valueOf(text, 'solana_rpc_latency_milliseconds_bucket{endpoint="a.rpc",method="getSlot",le="100"}')).toBe(2);
    expect(valueOf(text, 'solana_rpc_latency_milliseconds_bucket{endpoint="a.rpc",method="getSlot",le="1000"}')).toBe(2);
    expect(valueOf(text, 'solana_rpc_latency_milliseconds_bucket{endpoint="a.rpc",method="getSlot",le="+Inf"}')).toBe(3);
  });

  it("applies static labels and escapes label values", () => {
    const prom = createPrometheusExporter({ labels: { env: "prod" } });
    prom.onEvent(ev({ endpoint: 'we"ird', method: "getSlot" }));
    const text = prom.render();
    expect(text).toContain('env="prod"');
    expect(text).toContain('endpoint="we\\"ird"');
  });

  it("sorts user-supplied buckets ascending", () => {
    const prom = new PrometheusExporter({ buckets: [1000, 10, 100] });
    prom.onEvent(ev({ latencyMs: 50 }));
    const lines = prom
      .render()
      .split("\n")
      .filter((l) => l.includes("_bucket{") && !l.includes("+Inf"));
    const les = lines.map((l) => Number(/le="(\d+)"/.exec(l)![1]));
    expect(les).toEqual([10, 100, 1000]);
  });

  it("formats non-integer bucket bounds with fixed precision", () => {
    const prom = new PrometheusExporter({ buckets: [0.5, 2.5] });
    prom.onEvent(ev({ latencyMs: 0.4 }));
    expect(prom.render()).toContain('le="0.500"');
  });

  describe("requestListener", () => {
    function fakeRes() {
      return {
        status: 0,
        headers: {} as Record<string, string>,
        body: "",
        writeHead(status: number, headers?: Record<string, string>) {
          this.status = status;
          if (headers) this.headers = headers;
        },
        end(body?: string) {
          this.body = body ?? "";
        },
      };
    }

    it("serves the metrics on the configured path", () => {
      const prom = new PrometheusExporter();
      prom.onEvent(ev());
      const res = fakeRes();
      prom.requestListener()({ method: "GET", url: "/metrics?foo=1" }, res);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(PROMETHEUS_CONTENT_TYPE);
      expect(res.body).toContain("solana_rpc_requests_total");
    });

    it("404s an unknown path", () => {
      const res = fakeRes();
      new PrometheusExporter().requestListener("/m")({ method: "GET", url: "/other" }, res);
      expect(res.status).toBe(404);
    });

    it("405s a non-GET method", () => {
      const res = fakeRes();
      new PrometheusExporter().requestListener()({ method: "POST", url: "/metrics" }, res);
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });

    it("defaults the path to / when the request omits a url", () => {
      const res = fakeRes();
      new PrometheusExporter().requestListener("/metrics")({}, res);
      expect(res.status).toBe(404); // url defaults to "/", not "/metrics"
    });
  });

  describe("serve", () => {
    // Use node:http (not global fetch) so the check is deterministic across all
    // supported Node versions — undici's fetch can hang on loopback on Node 18.
    function httpGet(
      port: number,
      path: string,
    ): Promise<{ status: number; contentType?: string; body: string }> {
      return new Promise(async (resolve, reject) => {
        const http = await import("node:http");
        const req = http.get(
          { host: "127.0.0.1", port, path },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: res.headers["content-type"],
                body,
              }),
            );
          },
        );
        req.on("error", reject);
      });
    }

    it("stands up a real /metrics server that responds over HTTP", async () => {
      const prom = new PrometheusExporter();
      prom.onEvent(ev());
      const server = await prom.serve({ port: 0, host: "127.0.0.1" }); // ephemeral, IPv4 loopback
      try {
        const res = await httpGet(server.port, "/metrics");
        expect(res.status).toBe(200);
        expect(res.contentType).toBe(PROMETHEUS_CONTENT_TYPE);
        expect(res.body).toContain("solana_rpc_requests_total");
      } finally {
        await server.close();
      }
    });
  });
});
