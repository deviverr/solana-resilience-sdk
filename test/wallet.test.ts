import { describe, it, expect, vi } from "vitest";
import {
  createResilientWalletAdapter,
  fromWalletStandard,
  type WalletLike,
} from "../src/wallet/adapter.js";
import type { ResilientSender, SendResult } from "../src/relay/sender.js";

const sendResult: SendResult = {
  signature: "sig",
  route: "rpc",
  rebroadcasts: 0,
  confirmed: true,
};

function fakeSender() {
  const send = vi.fn(
    async (
      _input: {
        base64Transaction: string;
        signature: string;
        lastValidBlockHeight?: bigint | number;
      },
      _options?: unknown,
    ) => sendResult,
  );
  return { sender: { send } as unknown as ResilientSender, send };
}

describe("ResilientWalletAdapter", () => {
  it("signs with the wallet then broadcasts via the resilient sender", async () => {
    const wallet: WalletLike = {
      signTransaction: vi.fn(async (bytes) => new Uint8Array([1, ...bytes])),
    };
    const { sender, send } = fakeSender();
    const adapter = createResilientWalletAdapter({
      wallet,
      address: "Wallet111",
      sender,
      toBase64: () => "B64",
      getSignature: () => "DERIVED_SIG",
    });
    const tx = new Uint8Array([9, 9]);
    const result = await adapter.signAndSend({ transaction: tx, lastValidBlockHeight: 42 });

    expect(adapter.address).toBe("Wallet111");
    expect(wallet.signTransaction).toHaveBeenCalledWith(tx);
    expect(send).toHaveBeenCalledWith(
      {
        base64Transaction: "B64",
        signature: "DERIVED_SIG",
        lastValidBlockHeight: 42,
      },
      undefined,
    );
    expect(result).toEqual(sendResult);
  });

  it("uses default base64 + signature derivation", async () => {
    // 65-byte signed tx: [count=1][64-byte signature]
    const signed = new Uint8Array(65);
    signed[1] = 1; // make the signature non-trivial
    const wallet: WalletLike = { signTransaction: async () => signed };
    const { sender, send } = fakeSender();
    const adapter = createResilientWalletAdapter({
      wallet,
      address: "W",
      sender,
    });
    await adapter.signAndSend({ transaction: new Uint8Array([0]) });
    const arg = send.mock.calls[0]![0] as { base64Transaction: string; signature: string };
    expect(arg.base64Transaction.length).toBeGreaterThan(0);
    expect(arg.signature.length).toBeGreaterThan(0);
  });
});

describe("fromWalletStandard", () => {
  it("adapts a Wallet-Standard sign feature", async () => {
    const feature = {
      signTransaction: vi.fn(async () => [
        { signedTransaction: new Uint8Array([7, 7]) },
      ]),
    };
    const wallet = fromWalletStandard(feature);
    const out = await wallet.signTransaction(new Uint8Array([1]));
    expect(Array.from(out)).toEqual([7, 7]);
    expect(feature.signTransaction).toHaveBeenCalled();
  });

  it("throws when the wallet returns no output", async () => {
    const feature = { signTransaction: async () => [] };
    const wallet = fromWalletStandard(feature);
    await expect(wallet.signTransaction(new Uint8Array([1]))).rejects.toThrow(
      /no signed transaction/,
    );
  });
});
