import { describe, it, expect } from "vitest";
import {
  createTransferInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from "../src/relay/tip.js";
import {
  JitoRelay,
  createJitoRelay,
  JITO_TIP_ACCOUNTS,
} from "../src/relay/jitoRelay.js";

const PAYER = "8aGVRJSJ3jh2Q3Ccb6Fa3hF8s3a5oR4UqWqf3kqLPump"; // any valid base58 address

describe("createTransferInstruction", () => {
  it("encodes the System transfer layout (discriminator + LE u64 lamports)", () => {
    const ix = createTransferInstruction({
      from: PAYER,
      to: JITO_TIP_ACCOUNTS[0],
      lamports: 10_000,
    });
    expect(ix.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(ix.data).toHaveLength(12);

    const view = new DataView(ix.data.buffer);
    expect(view.getUint32(0, true)).toBe(2); // Transfer discriminator
    expect(view.getBigUint64(4, true)).toBe(10_000n);
  });

  it("marks the payer as a writable signer and the recipient as writable", () => {
    const ix = createTransferInstruction({
      from: PAYER,
      to: JITO_TIP_ACCOUNTS[0],
      lamports: 1,
    });
    // AccountRole: WRITABLE_SIGNER = 3, WRITABLE = 1
    expect(ix.accounts[0]!.role).toBe(3);
    expect(ix.accounts[1]!.role).toBe(1);
    expect(String(ix.accounts[1]!.address)).toBe(JITO_TIP_ACCOUNTS[0]);
  });

  it("accepts bigint lamports and rejects negatives", () => {
    expect(() =>
      createTransferInstruction({ from: PAYER, to: PAYER, lamports: 5_000_000_000n }),
    ).not.toThrow();
    expect(() =>
      createTransferInstruction({ from: PAYER, to: PAYER, lamports: -1 }),
    ).toThrow(/non-negative/);
  });
});

describe("JitoRelay.tipInstruction", () => {
  it("builds a tip transfer to a deterministic tip account with the default tip", () => {
    const relay = new JitoRelay({ random: () => 0 });
    const ix = relay.tipInstruction({ from: PAYER });
    expect(String(ix.accounts[1]!.address)).toBe(JITO_TIP_ACCOUNTS[0]);
    expect(new DataView(ix.data.buffer).getBigUint64(4, true)).toBe(10_000n);
  });

  it("honors a pinned tip account and explicit lamports", () => {
    const relay = new JitoRelay();
    const ix = relay.tipInstruction({
      from: PAYER,
      tipAccount: JITO_TIP_ACCOUNTS[3],
      lamports: 50_000,
    });
    expect(String(ix.accounts[1]!.address)).toBe(JITO_TIP_ACCOUNTS[3]);
    expect(new DataView(ix.data.buffer).getBigUint64(4, true)).toBe(50_000n);
  });

  it("createJitoRelay factory builds a usable relay", () => {
    const relay = createJitoRelay({ random: () => 0 });
    expect(relay.tipInstruction({ from: PAYER }).accounts).toHaveLength(2);
  });
});
