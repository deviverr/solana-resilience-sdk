import { metrics, type Meter } from "@opentelemetry/api";
import type { MetricsExporter } from "./metrics.js";

export interface OpenTelemetryExporterOptions {
  /** Provide a meter from your OTel SDK; defaults to the global meter provider. */
  readonly meter?: Meter;
  /** Instrument name prefix (default `solana.rpc`). */
  readonly prefix?: string;
}

/**
 * Export RPC metrics to OpenTelemetry instruments (counters + a latency
 * histogram). With an OTLP exporter configured in your OTel SDK these flow to
 * Datadog, Grafana, Honeycomb, etc. Safe to use with no SDK registered — the
 * global API falls back to no-op instruments.
 */
export function createOpenTelemetryExporter(
  options: OpenTelemetryExporterOptions = {},
): MetricsExporter {
  const meter = options.meter ?? metrics.getMeter("solana-resilience-sdk");
  const prefix = options.prefix ?? "solana.rpc";

  const requestCounter = meter.createCounter(`${prefix}.requests`, {
    description: "Total RPC requests issued through the resilience layer",
  });
  const failureCounter = meter.createCounter(`${prefix}.failures`, {
    description: "RPC requests that failed before failover succeeded",
  });
  const failoverCounter = meter.createCounter(`${prefix}.failovers`, {
    description: "RPC requests that were retried on another endpoint",
  });
  const latency = meter.createHistogram(`${prefix}.latency`, {
    description: "RPC request latency",
    unit: "ms",
  });

  return {
    name: "opentelemetry",
    onEvent(event) {
      const attributes = {
        endpoint: event.endpoint,
        method: event.method,
        ok: event.ok,
      };
      requestCounter.add(1, attributes);
      if (!event.ok) failureCounter.add(1, attributes);
      if (event.failedOver) failoverCounter.add(1, attributes);
      latency.record(event.latencyMs, attributes);
    },
  };
}
