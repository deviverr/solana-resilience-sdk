import { describe, it, expect, vi } from "vitest";
import { withRetry, computeBackoff } from "../src/core/retry.js";

const noSleep = async () => {};

describe("computeBackoff", () => {
  it("grows exponentially and caps at maxDelay with jitter disabled", () => {
    expect(computeBackoff(0, 100, 10_000, 0)).toBe(100);
    expect(computeBackoff(1, 100, 10_000, 0)).toBe(200);
    expect(computeBackoff(2, 100, 10_000, 0)).toBe(400);
    expect(computeBackoff(8, 100, 1_000, 0)).toBe(1_000); // capped
  });

  it("applies full jitter within [min, exp]", () => {
    // random=0 → lower bound, random=1 → exp
    expect(computeBackoff(1, 100, 10_000, 1, () => 0)).toBe(0);
    expect(computeBackoff(1, 100, 10_000, 1, () => 1)).toBe(200);
    const mid = computeBackoff(1, 100, 10_000, 0.5, () => 0.5);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(200);
  });
});

describe("withRetry", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw new Error("fail");
      return n;
    });
    const onRetry = vi.fn();
    await expect(
      withRetry(fn, { sleep: noSleep, onRetry, jitter: 0 }),
    ).resolves.toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once retries are exhausted", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      withRetry(fn, { maxRetries: 2, sleep: noSleep }),
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("stops early when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(
      withRetry(fn, { sleep: noSleep, shouldRetry: () => false }),
    ).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
