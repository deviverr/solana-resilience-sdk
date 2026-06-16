import { describe, it, expect } from "vitest";
import { base58Encode, bytesToBase64 } from "../src/util/base58.js";

describe("base58Encode", () => {
  it("encodes empty and zero inputs", () => {
    expect(base58Encode(new Uint8Array([]))).toBe("");
    expect(base58Encode(new Uint8Array([0]))).toBe("1");
    // 32 zero bytes is the canonical Solana System Program id.
    expect(base58Encode(new Uint8Array(32))).toBe("1".repeat(32));
  });

  it("preserves leading-zero bytes as leading ones", () => {
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  it("encodes a known multi-byte value", () => {
    // 0x000001 with the single leading zero stripped to one '1'.
    expect(base58Encode(new Uint8Array([1]))).toBe("2");
  });
});

describe("bytesToBase64", () => {
  it("matches standard base64 for ASCII bytes", () => {
    // "Hi" => SGk=
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe("SGk=");
  });
});
