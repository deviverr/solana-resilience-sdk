import { describe, it, expect, vi } from "vitest";
import {
  nativeRecentFeesSource,
  heliusPriorityFeeSource,
  staticFeeSource,
  type RecentFeesRpc,
} from "../src/fees/providers.js";

function fakeRpc(
  rows: { slot: number; prioritizationFee: bigint | number }[],
  spy?: (accounts?: readonly string[]) => void,
): RecentFeesRpc {
  return {
    getRecentPrioritizationFees(accounts) {
      spy?.(accounts);
      return { send: async () => rows };
    },
  };
}

describe("nativeRecentFeesSource", () => {
  it("returns the requested percentile of non-zero fees", async () => {
    const rpc = fakeRpc([
      { slot: 1, prioritizationFee: 0 },
      { slot: 2, prioritizationFee: 100n },
      { slot: 3, prioritizationFee: 200n },
      { slot: 4, prioritizationFee: 300n },
    ]);
    const source = nativeRecentFeesSource(rpc, { percentile: 50 });
    const value = await source.estimate({});
    expect(value).toBe(200);
  });

  it("returns null when there are no non-zero fees", async () => {
    const source = nativeRecentFeesSource(fakeRpc([{ slot: 1, prioritizationFee: 0 }]));
    expect(await source.estimate({})).toBeNull();
  });

  it("scopes the query to the provided accounts", async () => {
    const spy = vi.fn();
    const source = nativeRecentFeesSource(fakeRpc([{ slot: 1, prioritizationFee: 5n }], spy));
    await source.estimate({ accounts: ["Acc1"] });
    expect(spy).toHaveBeenCalledWith(["Acc1"]);
  });
});

describe("heliusPriorityFeeSource", () => {
  const okResponse = (value: unknown) =>
    ({
      ok: true,
      json: async () => ({ result: { priorityFeeEstimate: value } }),
    }) as Response;

  it("queries by account keys and parses the estimate", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init: { body: string }) => okResponse(1234),
    );
    const source = heliusPriorityFeeSource({
      url: "https://helius.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const value = await source.estimate({ accounts: ["A", "B"] });
    expect(value).toBe(1234);
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.params[0].accountKeys).toEqual(["A", "B"]);
    expect(body.params[0].options.priorityLevel).toBe("Medium");
  });

  it("queries by serialized transaction when provided", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init: { body: string }) => okResponse(9),
    );
    const source = heliusPriorityFeeSource({
      url: "https://helius.test",
      transaction: "BASE64TX",
      priorityLevel: "High",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await source.estimate({});
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.params[0].transaction).toBe("BASE64TX");
    expect(body.params[0].options.priorityLevel).toBe("High");
  });

  it("returns null without accounts or a transaction", async () => {
    const fetchFn = vi.fn();
    const source = heliusPriorityFeeSource({
      url: "https://helius.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns null on a non-ok HTTP response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false }) as Response);
    const source = heliusPriorityFeeSource({
      url: "https://helius.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({ accounts: ["A"] })).toBeNull();
  });
});

describe("staticFeeSource", () => {
  it("always returns the configured value", async () => {
    expect(await staticFeeSource(777).estimate({})).toBe(777);
  });
});
