import { describe, it, expect, vi } from "vitest";
import {
  JitoRelay,
  JITO_TIP_ACCOUNTS,
  DEFAULT_JITO_BLOCK_ENGINE,
} from "../src/relay/jitoRelay.js";

function okFetch(result: unknown) {
  return vi.fn(async (_url: string, _init: { body: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  }));
}

describe("JitoRelay", () => {
  it("submits a base64 transaction and returns the signature", async () => {
    const fetchFn = okFetch("sigABC");
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    const sig = await relay.sendTransaction("BASE64TX");
    expect(sig).toBe("sigABC");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_JITO_BLOCK_ENGINE}/api/v1/transactions`);
    const body = JSON.parse((init as { body: string }).body);
    expect(body.method).toBe("sendTransaction");
    expect(body.params[0]).toBe("BASE64TX");
    expect(body.params[1]).toEqual({ encoding: "base64" });
  });

  it("submits a bundle to the bundles endpoint", async () => {
    const fetchFn = okFetch("bundle1");
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    const id = await relay.sendBundle(["tx1", "tx2"]);
    expect(id).toBe("bundle1");
    expect(fetchFn.mock.calls[0]![0]).toContain("/api/v1/bundles");
  });

  it("throws on a JSON-RPC error response", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: -1, message: "rejected" } }),
    }));
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(relay.sendTransaction("tx")).rejects.toThrow(/rejected/);
  });

  it("throws on a non-ok HTTP status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(relay.sendTransaction("tx")).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the relay returns no result", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1 }),
    }));
    const relay = new JitoRelay({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(relay.sendTransaction("tx")).rejects.toThrow(/no result/);
  });

  it("picks a tip account deterministically from the injected RNG", () => {
    const relay = new JitoRelay({ random: () => 0 });
    expect(relay.getTipAccount()).toBe(JITO_TIP_ACCOUNTS[0]);
    const relayLast = new JitoRelay({ random: () => 0.999 });
    expect(relayLast.getTipAccount()).toBe(
      JITO_TIP_ACCOUNTS[JITO_TIP_ACCOUNTS.length - 1],
    );
  });

  it("exposes the canonical 8 tip accounts and a default tip", () => {
    expect(JITO_TIP_ACCOUNTS).toHaveLength(8);
    expect(new JitoRelay().tipLamports).toBe(10_000);
  });
});
