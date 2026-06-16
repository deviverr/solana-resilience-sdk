import { describe, it, expect, vi } from "vitest";
import { ResilientSender, type SenderRpc } from "../src/relay/sender.js";
import { TransactionConfirmationError } from "../src/core/errors.js";
import type { MevRelay } from "../src/relay/mevRelay.js";
import { manualClock } from "./mocks/networkSimulator.js";

type Status = { confirmationStatus?: "processed" | "confirmed" | "finalized"; err: unknown } | null;

function fakeRpc(opts: {
  statuses: Status[];
  blockHeight?: number;
  onSend?: () => void;
}): SenderRpc {
  let i = 0;
  return {
    sendTransaction: () => ({
      send: async () => {
        opts.onSend?.();
        return "sig";
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [opts.statuses[Math.min(i++, opts.statuses.length - 1)] ?? null],
      }),
    }),
    getEpochInfo: () => ({
      send: async () => ({ blockHeight: opts.blockHeight ?? 0 }),
    }),
  };
}

function makeSender(rpc: SenderRpc, relay?: MevRelay) {
  const clock = manualClock();
  return new ResilientSender({
    rpc,
    relay,
    clock: clock.now,
    sleep: async (ms) => clock.advance(ms),
  });
}

const input = { base64Transaction: "TX", signature: "sig" };

describe("ResilientSender", () => {
  it("routes the initial submit through the relay when available", async () => {
    const relay: MevRelay = { name: "jito", sendTransaction: vi.fn(async () => "sig") };
    const sender = makeSender(
      fakeRpc({ statuses: [{ confirmationStatus: "confirmed", err: null }] }),
      relay,
    );
    const result = await sender.send(input);
    expect(result.route).toBe("jito");
    expect(result.confirmed).toBe(true);
    expect(relay.sendTransaction).toHaveBeenCalled();
  });

  it("falls back to the RPC when the relay rejects", async () => {
    const relay: MevRelay = {
      name: "jito",
      sendTransaction: vi.fn(async () => {
        throw new Error("relay down");
      }),
    };
    const rpcSend = vi.fn();
    const sender = makeSender(
      fakeRpc({
        statuses: [{ confirmationStatus: "confirmed", err: null }],
        onSend: rpcSend,
      }),
      relay,
    );
    const result = await sender.send(input);
    expect(result.route).toBe("rpc");
    expect(rpcSend).toHaveBeenCalled();
  });

  it("sends via RPC when no relay is configured", async () => {
    const sender = makeSender(
      fakeRpc({ statuses: [{ confirmationStatus: "finalized", err: null }] }),
    );
    const result = await sender.send(input);
    expect(result.route).toBe("rpc");
  });

  it("rebroadcasts an unconfirmed transaction until it lands", async () => {
    const rpcSend = vi.fn();
    const sender = makeSender(
      fakeRpc({
        statuses: [null, null, { confirmationStatus: "confirmed", err: null }],
        onSend: rpcSend,
      }),
    );
    const result = await sender.send(input, { pollIntervalMs: 1_000 });
    expect(result.confirmed).toBe(true);
    expect(result.rebroadcasts).toBeGreaterThanOrEqual(1);
  });

  it("throws when the transaction fails on-chain", async () => {
    const sender = makeSender(
      fakeRpc({ statuses: [{ err: { InstructionError: [0, "Custom"] } }] }),
    );
    await expect(sender.send(input)).rejects.toBeInstanceOf(
      TransactionConfirmationError,
    );
  });

  it("throws when the blockhash expires before confirmation", async () => {
    const sender = makeSender(
      fakeRpc({ statuses: [null], blockHeight: 500 }),
    );
    await expect(
      sender.send({ ...input, lastValidBlockHeight: 100 }),
    ).rejects.toThrow(/expired/);
  });

  it("throws on confirmation timeout", async () => {
    const sender = makeSender(fakeRpc({ statuses: [null] }));
    await expect(
      sender.send(input, { confirmTimeoutMs: 5_000, pollIntervalMs: 1_000, maxRebroadcasts: 1 }),
    ).rejects.toBeInstanceOf(TransactionConfirmationError);
  });
});
