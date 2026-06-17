import { type Address, AccountRole, address } from "@solana/web3.js";

/** The Solana System Program address. */
export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

/**
 * A web3.js v2-compatible instruction. Structurally matches the `IInstruction`
 * the v2 transaction-message builders consume, so it can be dropped straight
 * into `appendTransactionMessageInstruction(...)`.
 */
export interface TransferInstruction {
  readonly programAddress: Address;
  readonly accounts: readonly {
    readonly address: Address;
    readonly role: AccountRole;
  }[];
  readonly data: Uint8Array;
}

export interface TransferInput {
  readonly from: Address | string;
  readonly to: Address | string;
  readonly lamports: bigint | number;
}

/**
 * Build a SystemProgram `transfer` instruction in web3.js v2 format.
 *
 * The instruction data is the System program's transfer layout: a little-endian
 * u32 discriminator (`2` = Transfer) followed by a little-endian u64 lamport
 * amount.
 */
export function createTransferInstruction(
  input: TransferInput,
): TransferInstruction {
  const lamports = BigInt(input.lamports);
  if (lamports < 0n) {
    throw new Error("transfer lamports must be non-negative");
  }
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // System "Transfer" instruction discriminator
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: address(String(input.from)), role: AccountRole.WRITABLE_SIGNER },
      { address: address(String(input.to)), role: AccountRole.WRITABLE },
    ],
    data,
  };
}
