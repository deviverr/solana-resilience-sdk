import { describe, it, expect } from "vitest";
import { FeeEstimator } from "../src/fees/feeEstimator.js";
import type { FeeSource } from "../src/fees/feeEstimator.js";
import { manualClock } from "./mocks/networkSimulator.js";

const src = (name: string, value: number | null): FeeSource => ({
  name,
  estimate: async () => value,
});
const failing = (name: string): FeeSource => ({
  name,
  estimate: async () => {
    throw new Error("provider down");
  },
});

describe("FeeEstimator", () => {
  it("requires at least one source", () => {
    expect(() => new FeeEstimator({ sources: [] })).toThrow(/at least one/);
  });

  it("aggregates with the configured mode", async () => {
    const sources = [src("a", 10), src("b", 30), src("c", 20)];
    const max = await new FeeEstimator({ sources, aggregate: "max" }).estimate();
    const min = await new FeeEstimator({ sources, aggregate: "min" }).estimate();
    const mean = await new FeeEstimator({ sources, aggregate: "mean" }).estimate();
    const median = await new FeeEstimator({
      sources,
      aggregate: "median",
    }).estimate();
    expect(max.microLamportsPerCu).toBe(30);
    expect(min.microLamportsPerCu).toBe(10);
    expect(mean.microLamportsPerCu).toBe(20);
    expect(median.microLamportsPerCu).toBe(20);
    expect(max.source).toBe("a+b+c");
  });

  it("applies multiplier and clamps to [min,max]", async () => {
    const high = await new FeeEstimator({
      sources: [src("a", 1000)],
      multiplier: 10,
      maxMicroLamports: 5000,
    }).estimate();
    expect(high.microLamportsPerCu).toBe(5000); // clamped

    const low = await new FeeEstimator({
      sources: [src("a", 1)],
      minMicroLamports: 100,
    }).estimate();
    expect(low.microLamportsPerCu).toBe(100); // floored
  });

  it("tolerates failing sources as long as one responds", async () => {
    const e = await new FeeEstimator({
      sources: [failing("a"), src("b", 42)],
    }).estimate();
    expect(e.microLamportsPerCu).toBe(42);
    expect(e.source).toBe("b");
  });

  it("falls back to the floor when every source fails", async () => {
    const e = await new FeeEstimator({
      sources: [failing("a"), src("b", null)],
      minMicroLamports: 7,
    }).estimate();
    expect(e.microLamportsPerCu).toBe(7);
    expect(e.source).toBe("fallback");
  });

  it("caches within the TTL and recomputes after it elapses", async () => {
    const clock = manualClock();
    let value = 100;
    const dynamic: FeeSource = { name: "d", estimate: async () => value };
    const est = new FeeEstimator({
      sources: [dynamic],
      cacheTtlMs: 1_000,
      clock: clock.now,
    });
    expect((await est.estimate()).microLamportsPerCu).toBe(100);
    value = 500;
    clock.advance(500);
    expect((await est.estimate()).microLamportsPerCu).toBe(100); // cached
    clock.advance(600);
    expect((await est.estimate()).microLamportsPerCu).toBe(500); // refreshed
  });

  it("computes an even-count median by averaging the two middle values", async () => {
    const sources = [src("a", 10), src("b", 20), src("c", 30), src("d", 40)];
    const e = await new FeeEstimator({ sources, aggregate: "median" }).estimate();
    expect(e.microLamportsPerCu).toBe(25); // (20 + 30) / 2
  });

  it("carries through a configured compute-unit limit", async () => {
    const e = await new FeeEstimator({
      sources: [src("a", 5)],
      computeUnitLimit: 200_000,
    }).estimate();
    expect(e.computeUnitLimit).toBe(200_000);
  });
});
