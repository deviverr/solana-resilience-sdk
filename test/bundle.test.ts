import { describe, it, expect, vi } from "vitest";
import {
  JitoBundle,
  createBundle,
  normalizeBundle,
  JITO_MAX_BUNDLE_SIZE,
} from "../src/relay/bundle.js";
import { JitoRelay } from "../src/relay/jitoRelay.js";

function okFetch(result: unknown) {
  return vi.fn(async (_url: string, _init: { body: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  }));
}

describe("JitoBundle", () => {
  it("collects transactions in order and reports size/fullness", () => {
    const bundle = new JitoBundle(["t1", "t2"]).add("t3");
    expect(bundle.transactions).toEqual(["t1", "t2", "t3"]);
    expect(bundle.size).toBe(3);
    expect(bundle.isFull).toBe(false);
  });

  it("reports full at the max bundle size", () => {
    const bundle = createBundle(["a", "b", "c", "d", "e"]);
    expect(bundle.size).toBe(JITO_MAX_BUNDLE_SIZE);
    expect(bundle.isFull).toBe(true);
  });

  it("rejects exceeding the max bundle size", () => {
    const bundle = createBundle(["a", "b", "c", "d", "e"]);
    expect(() => bundle.add("f")).toThrow(/at most 5/);
  });

  it("rejects empty or non-string transactions", () => {
    expect(() => new JitoBundle().add("")).toThrow(/non-empty/);
    expect(() => new JitoBundle().add(undefined as unknown as string)).toThrow(
      /non-empty/,
    );
  });
});

describe("normalizeBundle", () => {
  it("accepts a JitoBundle and a raw array alike", () => {
    expect(normalizeBundle(createBundle(["a"]))).toEqual(["a"]);
    expect(normalizeBundle(["a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects an empty bundle", () => {
    expect(() => normalizeBundle([])).toThrow(/at least one/);
  });

  it("rejects an over-sized raw array", () => {
    expect(() => normalizeBundle(["a", "b", "c", "d", "e", "f"])).toThrow(
      /at most 5/,
    );
  });
});

describe("JitoRelay bundle integration", () => {
  it("builds a bundle via relay.bundle() and submits it", async () => {
    const fetchFn = okFetch("bundleXYZ");
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    const bundle = relay.bundle(["tx1"]).add("tx2");
    const id = await relay.sendBundle(bundle);

    expect(id).toBe("bundleXYZ");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain("/api/v1/bundles");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.method).toBe("sendBundle");
    expect(body.params[0]).toEqual(["tx1", "tx2"]);
    expect(body.params[1]).toEqual({ encoding: "base64" });
  });

  it("still accepts a raw transaction array", async () => {
    const fetchFn = okFetch("bundle1");
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(await relay.sendBundle(["tx1", "tx2"])).toBe("bundle1");
  });

  it("rejects an empty bundle before hitting the network", async () => {
    const fetchFn = okFetch("never");
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(relay.sendBundle([])).rejects.toThrow(/at least one/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
