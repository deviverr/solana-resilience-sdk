import { type Clock, type EndpointStats, defaultClock } from "../core/types.js";
import type { NodePool } from "../core/nodePool.js";
import type { MetricsCollector, MetricsSnapshot } from "../observability/metrics.js";

export interface MonitorSnapshot {
  readonly timestamp: number;
  readonly metrics: MetricsSnapshot;
  readonly endpoints: readonly EndpointStats[];
}

export interface MonitorOptions {
  readonly collector: MetricsCollector;
  readonly pool: NodePool;
  readonly clock?: Clock;
  readonly setIntervalFn?: (cb: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Real-time view over the resilience layer: combines live pool health with
 * aggregated RPC metrics into a snapshot, and can push periodic updates to
 * subscribers (the CLI `monitor` command renders these).
 */
export class Monitor {
  private readonly collector: MetricsCollector;
  private readonly pool: NodePool;
  private readonly clock: Clock;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly listeners = new Set<(s: MonitorSnapshot) => void>();
  private handle: unknown;

  constructor(options: MonitorOptions) {
    this.collector = options.collector;
    this.pool = options.pool;
    this.clock = options.clock ?? defaultClock;
    this.setIntervalFn =
      options.setIntervalFn ??
      ((cb, ms) => {
        const timer = setInterval(cb, ms);
        timer.unref?.();
        return timer;
      });
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  snapshot(): MonitorSnapshot {
    return {
      timestamp: this.clock(),
      metrics: this.collector.snapshot(),
      endpoints: this.pool.snapshot(),
    };
  }

  onUpdate(listener: (snapshot: MonitorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Begin emitting periodic snapshots to subscribers. */
  start(intervalMs = 1_000): void {
    if (this.handle !== undefined) return;
    this.emit();
    this.handle = this.setIntervalFn(() => this.emit(), intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.clearIntervalFn(this.handle);
    this.handle = undefined;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Render a snapshot as a plain-text dashboard (no ANSI — caller may colorize). */
  render(snapshot: MonitorSnapshot = this.snapshot()): string {
    const m = snapshot.metrics;
    const lines: string[] = [];
    lines.push("Solana RPC Resilience — Live Monitor");
    lines.push(
      `requests=${m.totalRequests}  failures=${m.totalFailures}  ` +
        `failRate=${(m.failureRate * 100).toFixed(1)}%  ` +
        `p50=${m.p50LatencyMs.toFixed(0)}ms  p95=${m.p95LatencyMs.toFixed(0)}ms`,
    );
    lines.push("");

    const header = [
      pad("ENDPOINT", 28),
      pad("HEALTH", 8),
      pad("CIRCUIT", 10),
      pad("AVG", 8),
      pad("P95", 8),
      pad("REQ", 7),
      pad("FAIL", 7),
      pad("INFLT", 6),
    ].join(" ");
    lines.push(header);
    lines.push("-".repeat(header.length));

    for (const e of snapshot.endpoints) {
      lines.push(
        [
          pad(e.name, 28),
          pad(e.healthy ? "up" : "down", 8),
          pad(e.circuit, 10),
          pad(`${e.avgLatencyMs.toFixed(0)}ms`, 8),
          pad(`${e.p95LatencyMs.toFixed(0)}ms`, 8),
          pad(String(e.totalRequests), 7),
          pad(String(e.totalFailures), 7),
          pad(String(e.inflight), 6),
        ].join(" "),
      );
    }

    if (m.recentFailures.length > 0) {
      lines.push("");
      lines.push("recent failures:");
      for (const f of m.recentFailures.slice(-3)) {
        lines.push(`  ${f.endpoint} ${f.method}: ${f.error ?? "error"}`);
      }
    }
    return lines.join("\n");
  }
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value.slice(0, width)
    : value + " ".repeat(width - value.length);
}

export function createMonitor(options: MonitorOptions): Monitor {
  return new Monitor(options);
}
