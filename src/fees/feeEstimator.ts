import { type Clock, defaultClock } from "../core/types.js";

export interface FeeEstimate {
  /** Priority fee in micro-lamports per compute unit. */
  readonly microLamportsPerCu: number;
  /** Suggested compute-unit limit, if configured. */
  readonly computeUnitLimit?: number;
  /** Which source(s) contributed to this estimate. */
  readonly source: string;
}

export interface FeeSourceContext {
  /** Writable accounts to scope the estimate to (improves accuracy). */
  readonly accounts?: readonly string[];
  readonly signal?: AbortSignal;
}

/** A single provider of a priority-fee estimate (micro-lamports per CU). */
export interface FeeSource {
  readonly name: string;
  estimate(context: FeeSourceContext): Promise<number | null>;
}

export type AggregationMode = "max" | "min" | "mean" | "median";

export interface FeeEstimatorOptions {
  readonly sources: readonly FeeSource[];
  /** How to combine multiple sources (default `max` — safest for landing). */
  readonly aggregate?: AggregationMode;
  /** Multiply the aggregate for extra headroom (default 1). */
  readonly multiplier?: number;
  /** Floor for the returned fee (default 1). */
  readonly minMicroLamports?: number;
  /** Cap to avoid overpaying (default 5_000_000). */
  readonly maxMicroLamports?: number;
  /** Cache the estimate for this many ms (default 0 = no cache). */
  readonly cacheTtlMs?: number;
  readonly computeUnitLimit?: number;
  readonly clock?: Clock;
}

function aggregate(values: number[], mode: AggregationMode): number {
  if (mode === "max") return Math.max(...values);
  if (mode === "min") return Math.min(...values);
  if (mode === "mean") {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  // median
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Aggregates priority-fee estimates from one or more external/native sources.
 *
 * Sources are queried in parallel and failures are tolerated — as long as one
 * source responds, an estimate is produced. The result is combined, scaled by
 * `multiplier`, clamped to `[min, max]`, and optionally cached.
 */
export class FeeEstimator {
  private readonly sources: readonly FeeSource[];
  private readonly mode: AggregationMode;
  private readonly multiplier: number;
  private readonly min: number;
  private readonly max: number;
  private readonly cacheTtlMs: number;
  private readonly computeUnitLimit?: number;
  private readonly clock: Clock;

  private cached?: { value: FeeEstimate; at: number };

  constructor(options: FeeEstimatorOptions) {
    if (options.sources.length === 0) {
      throw new Error("FeeEstimator requires at least one source");
    }
    this.sources = options.sources;
    this.mode = options.aggregate ?? "max";
    this.multiplier = options.multiplier ?? 1;
    this.min = options.minMicroLamports ?? 1;
    this.max = options.maxMicroLamports ?? 5_000_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.computeUnitLimit = options.computeUnitLimit;
    this.clock = options.clock ?? defaultClock;
  }

  async estimate(context: FeeSourceContext = {}): Promise<FeeEstimate> {
    if (
      this.cached &&
      this.cacheTtlMs > 0 &&
      this.clock() - this.cached.at < this.cacheTtlMs
    ) {
      return this.cached.value;
    }

    const settled = await Promise.allSettled(
      this.sources.map((s) => s.estimate(context)),
    );

    const contributors: string[] = [];
    const values: number[] = [];
    settled.forEach((result, i) => {
      if (
        result.status === "fulfilled" &&
        result.value != null &&
        Number.isFinite(result.value) &&
        result.value >= 0
      ) {
        values.push(result.value);
        contributors.push(this.sources[i]!.name);
      }
    });

    let raw = values.length > 0 ? aggregate(values, this.mode) : this.min;
    raw = Math.round(raw * this.multiplier);
    const clamped = Math.min(this.max, Math.max(this.min, raw));

    const estimate: FeeEstimate = {
      microLamportsPerCu: clamped,
      computeUnitLimit: this.computeUnitLimit,
      source: contributors.length > 0 ? contributors.join("+") : "fallback",
    };

    if (this.cacheTtlMs > 0) {
      this.cached = { value: estimate, at: this.clock() };
    }
    return estimate;
  }
}

export function createFeeEstimator(options: FeeEstimatorOptions): FeeEstimator {
  return new FeeEstimator(options);
}
