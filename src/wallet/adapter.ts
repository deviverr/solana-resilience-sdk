import { base58Encode, bytesToBase64 } from "../util/base58.js";
import type {
  ResilientSender,
  SendOptions,
  SendResult,
} from "../relay/sender.js";

/** Anything that can sign a serialized transaction (the only capability we need). */
export interface WalletLike {
  /** Sign a serialized (wire-format) transaction and return the signed bytes. */
  signTransaction(transactionBytes: Uint8Array): Promise<Uint8Array>;
}

export interface ResilientWalletAdapterOptions {
  readonly wallet: WalletLike;
  /** The signer's address (base58) — informational, exposed as `.address`. */
  readonly address: string;
  readonly sender: ResilientSender;
  /** Override base64 encoding of signed bytes. */
  readonly toBase64?: (bytes: Uint8Array) => string;
  /** Override how the signature is derived from signed bytes. */
  readonly getSignature?: (signedBytes: Uint8Array) => string;
}

export interface SignAndSendInput {
  /** Serialized (compiled, unsigned-or-partially-signed) transaction bytes. */
  readonly transaction: Uint8Array;
  readonly lastValidBlockHeight?: bigint | number;
}

/**
 * Plug-and-play bridge between a standard wallet and the resilience layer.
 *
 * The wallet signs (so keys never leave it), but broadcast + confirmation go
 * through the {@link ResilientSender} — meaning every wallet send gets MEV
 * routing, RPC fallback and dropped-transaction rebroadcast for free.
 */
export class ResilientWalletAdapter {
  readonly address: string;
  private readonly wallet: WalletLike;
  private readonly sender: ResilientSender;
  private readonly toBase64: (bytes: Uint8Array) => string;
  private readonly getSignature: (bytes: Uint8Array) => string;

  constructor(options: ResilientWalletAdapterOptions) {
    this.wallet = options.wallet;
    this.address = options.address;
    this.sender = options.sender;
    this.toBase64 = options.toBase64 ?? bytesToBase64;
    this.getSignature =
      options.getSignature ?? ((bytes) => base58Encode(bytes.slice(1, 65)));
  }

  /** Sign with the wallet, then broadcast + confirm via the resilience layer. */
  async signAndSend(
    input: SignAndSendInput,
    options?: SendOptions,
  ): Promise<SendResult> {
    const signed = await this.wallet.signTransaction(input.transaction);
    return this.sender.send(
      {
        base64Transaction: this.toBase64(signed),
        signature: this.getSignature(signed),
        lastValidBlockHeight: input.lastValidBlockHeight,
      },
      options,
    );
  }
}

/** Minimal structural view of a Wallet-Standard `solana:signTransaction` feature. */
export interface WalletStandardSignFeature {
  signTransaction(
    ...inputs: { transaction: Uint8Array }[]
  ): Promise<{ signedTransaction: Uint8Array }[]>;
}

/**
 * Adapt a Wallet-Standard wallet (Phantom, Solflare, Backpack, …) exposing the
 * `solana:signTransaction` feature into the {@link WalletLike} this adapter
 * consumes.
 */
export function fromWalletStandard(
  feature: WalletStandardSignFeature,
): WalletLike {
  return {
    async signTransaction(transactionBytes) {
      const [output] = await feature.signTransaction({
        transaction: transactionBytes,
      });
      if (!output) throw new Error("Wallet returned no signed transaction");
      return output.signedTransaction;
    },
  };
}

export function createResilientWalletAdapter(
  options: ResilientWalletAdapterOptions,
): ResilientWalletAdapter {
  return new ResilientWalletAdapter(options);
}
