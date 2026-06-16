import { type RpcMetricEvent } from "../core/types.js";
import { percentile } from "../core/nodePool.js";

/** A pluggable sink for raw metric events (OpenTelemetry, Datadog, …). */
export interface MetricsExporter {
  readonly name: string;
  /** Called synchronously for every recorded event. */
  onEvent?(event: RpcMetricEvent): void;
  /** Flush any buffered data (called by `MetricsCollector.flush`). */
  flush?(): Promise<void> | void;
  /** Release resources. */
  shutdown?(): Promise<void> | void;
}

export interface MethodStats {
  readonly requests: number;
  readonly failures: number;
  readonly avgLatencyMs: number;
}

export interface MetricsSnapshot {
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly failureRate: number;
  readonly avgLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly perEndpoint: Record<string, MethodStats>;
  readonly perMethod: Record<string, MethodStats>;
  readonly recentFailures: readonly RpcMetricEvent[];
}

interface Bucket {
  requests: number;
  failures: number;
  latencySum: number;
}

const RECENT_WINDOW = 500;
const RECENT_FAILURES = 25;

/**
 * In-memory aggregator and fan-out for RPC metric events.
 *
 * Every `record()` updates rolling aggregates, notifies subscribers (used by
 * the live monitor) and forwards the event to any registered exporters.
 */
export class MetricsCollector {
  private readonly exporters: MetricsExporter[] = [];
  private readonly listeners = new Set<(e: RpcMetricEvent) => void>();
  private readonly endpointBuckets = new Map<string, Bucket>();
  private readonly methodBuckets = new Map<string, Bucket>();
  private readonly recentLatencies: number[] = [];
  private readonly recentFailures: RpcMetricEvent[] = [];

  private total = 0;
  private failures = 0;
  private latencySum = 0;

  record(event: RpcMetricEvent): void {
    this.total++;
    this.latencySum += event.latencyMs;
    if (!event.ok) {
      this.failures++;
      this.recentFailures.push(event);
      if (this.recentFailures.length > RECENT_FAILURES) {
        this.recentFailures.shift();
      }
    }

    bump(this.endpointBuckets, event.endpoint, event);
    bump(this.methodBuckets, event.method, event);

    this.recentLatencies.push(event.latencyMs);
    if (this.recentLatencies.length > RECENT_WINDOW) {
      this.recentLatencies.shift();
    }

    for (const listener of this.listeners) listener(event);
    for (const exporter of this.exporters) exporter.onEvent?.(event);
  }

  /** Register an exporter; returns a de-registration function. */
  addExporter(exporter: MetricsExporter): () => void {
    this.exporters.push(exporter);
    return () => {
      const i = this.exporters.indexOf(exporter);
      if (i >= 0) this.exporters.splice(i, 1);
    };
  }

  /** Subscribe to raw events (the monitor uses this); returns unsubscribe. */
  subscribe(listener: (e: RpcMetricEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): MetricsSnapshot {
    return {
      totalRequests: this.total,
      totalFailures: this.failures,
      failureRate: this.total === 0 ? 0 : this.failures / this.total,
      avgLatencyMs: this.total === 0 ? 0 : this.latencySum / this.total,
      p50LatencyMs: percentile(this.recentLatencies, 50),
      p95LatencyMs: percentile(this.recentLatencies, 95),
      p99LatencyMs: percentile(this.recentLatencies, 99),
      perEndpoint: toStats(this.endpointBuckets),
      perMethod: toStats(this.methodBuckets),
      recentFailures: [...this.recentFailures],
    };
  }

  async flush(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.flush?.()));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.shutdown?.()));
    this.listeners.clear();
  }
}

function bump(map: Map<string, Bucket>, key: string, event: RpcMetricEvent): void {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { requests: 0, failures: 0, latencySum: 0 };
    map.set(key, bucket);
  }
  bucket.requests++;
  bucket.latencySum += event.latencyMs;
  if (!event.ok) bucket.failures++;
}

function toStats(map: Map<string, Bucket>): Record<string, MethodStats> {
  const out: Record<string, MethodStats> = {};
  for (const [key, b] of map) {
    out[key] = {
      requests: b.requests,
      failures: b.failures,
      avgLatencyMs: b.requests === 0 ? 0 : b.latencySum / b.requests,
    };
  }
  return out;
}
