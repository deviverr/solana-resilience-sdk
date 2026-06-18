import { describe, it, expect, vi } from "vitest";
import {
  nativeRecentFeesSource,
  heliusPriorityFeeSource,
  tritonPriorityFeeSource,
  quickNodePriorityFeeSource,
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

  it("returns null when the response estimate is not numeric", async () => {
    const fetchFn = vi.fn(
      async () =>
        ({ ok: true, json: async () => ({ result: {} }) }) as Response,
    );
    const source = heliusPriorityFeeSource({
      url: "https://helius.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({ accounts: ["A"] })).toBeNull();
  });
});

describe("tritonPriorityFeeSource", () => {
  const okRows = (rows: { prioritizationFee: number }[]) =>
    ({ ok: true, json: async () => ({ result: rows }) }) as Response;

  it("requests the percentile (in bp) and returns it client-side", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init: { body: string }) =>
        okRows([
          { prioritizationFee: 100 },
          { prioritizationFee: 200 },
          { prioritizationFee: 300 },
        ]),
    );
    const source = tritonPriorityFeeSource({
      url: "https://triton.test",
      percentile: 50,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const value = await source.estimate({ accounts: ["A"] });
    expect(value).toBe(200); // p50 of [100,200,300]
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.method).toBe("getRecentPrioritizationFees");
    expect(body.params[0]).toEqual(["A"]);
    expect(body.params[1].percentile).toBe(5000); // 50% → 5000 bp
  });

  it("returns null when there are no non-zero fees", async () => {
    const fetchFn = vi.fn(async () => okRows([{ prioritizationFee: 0 }]));
    const source = tritonPriorityFeeSource({
      url: "https://triton.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBeNull();
  });

  it("returns null on a non-ok HTTP response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false }) as Response);
    const source = tritonPriorityFeeSource({
      url: "https://triton.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({ accounts: ["A"] })).toBeNull();
  });

  it("returns null when the response carries no result array", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    const source = tritonPriorityFeeSource({
      url: "https://triton.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBeNull();
  });

  it("defaults to the global fetch when none is provided", () => {
    expect(tritonPriorityFeeSource({ url: "https://triton.test" }).name).toBe(
      "triton",
    );
  });
});

describe("quickNodePriorityFeeSource", () => {
  const okFees = (perCu: Record<string, number>) =>
    ({ ok: true, json: async () => ({ result: { per_compute_unit: perCu } }) }) as Response;

  it("reads the configured recommendation level from per_compute_unit", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init: { body: string }) =>
        okFees({ low: 100, medium: 500, high: 1000, extreme: 2000 }),
    );
    const source = quickNodePriorityFeeSource({
      url: "https://quicknode.test",
      level: "high",
      account: "Acc1",
      lastNBlocks: 50,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBe(1000);
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.method).toBe("qn_estimatePriorityFees");
    expect(body.params.account).toBe("Acc1");
    expect(body.params.last_n_blocks).toBe(50);
    expect(body.params.api_version).toBe(2);
  });

  it("defaults to the medium level", async () => {
    const fetchFn = vi.fn(async () => okFees({ medium: 333 }));
    const source = quickNodePriorityFeeSource({
      url: "https://quicknode.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBe(333);
  });

  it("returns null when the level is missing or non-numeric", async () => {
    const fetchFn = vi.fn(async () => okFees({ low: 1 }));
    const source = quickNodePriorityFeeSource({
      url: "https://quicknode.test",
      level: "extreme",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBeNull();
  });

  it("returns null on a non-ok HTTP response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false }) as Response);
    const source = quickNodePriorityFeeSource({
      url: "https://quicknode.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await source.estimate({})).toBeNull();
  });

  it("defaults to the global fetch when none is provided", () => {
    expect(
      quickNodePriorityFeeSource({ url: "https://quicknode.test" }).name,
    ).toBe("quicknode");
  });
});

describe("staticFeeSource", () => {
  it("always returns the configured value", async () => {
    expect(await staticFeeSource(777).estimate({})).toBe(777);
  });
});
