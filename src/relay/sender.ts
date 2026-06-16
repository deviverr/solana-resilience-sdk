import {
  type Clock,
  type Sleep,
  defaultClock,
  defaultSleep,
} from "../core/types.js";
import { TransactionConfirmationError } from "../core/errors.js";
import type { MevRelay } from "./mevRelay.js";

export type Commitment = "processed" | "confirmed" | "finalized";

const COMMITMENT_RANK: Record<Commitment, number> = {
  processed: 1,
  confirmed: 2,
  finalized: 3,
};

interface SignatureStatus {
  readonly confirmationStatus?: Commitment | null;
  readonly err: unknown;
}

/** The minimal RPC surface the sender needs (matches web3.js v2's shape). */
export interface SenderRpc {
  sendTransaction(
    base64Transaction: string,
    config: { encoding: "base64"; skipPreflight?: boolean; maxRetries?: bigint },
  ): { send(options?: { abortSignal?: AbortSignal }): Promise<string> };
  getSignatureStatuses(signatures: readonly string[]): {
    send(options?: { abortSignal?: AbortSignal }): Promise<{
      value: ReadonlyArray<SignatureStatus | null>;
    }>;
  };
  getEpochInfo(): {
    send(options?: { abortSignal?: AbortSignal }): Promise<{
      blockHeight: bigint | number;
    }>;
  };
}

export interface ResilientSenderOptions {
  readonly rpc: SenderRpc;
  /** Optional MEV relay to try first (e.g. Jito). */
  readonly relay?: MevRelay;
  /** Prefer the relay over the RPC for the initial submit (default true). */
  readonly preferRelay?: boolean;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
}

export interface SendInput {
  /** Fully-signed, base64-encoded wire transaction. */
  readonly base64Transaction: string;
  /** The transaction signature (base58). Required for confirmation tracking. */
  readonly signature: string;
  /** Last block height at which the blockhash is valid (for expiry detection). */
  readonly lastValidBlockHeight?: bigint | number;
}

export interface SendOptions {
  readonly skipPreflight?: boolean;
  readonly commitment?: Commitment;
  /** Max times to re-broadcast a not-yet-confirmed transaction (default 5). */
  readonly maxRebroadcasts?: number;
  readonly confirmTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface SendResult {
  readonly signature: string;
  /** Which path carried the *initial* submission. */
  readonly route: "jito" | "rpc";
  readonly rebroadcasts: number;
  readonly confirmed: boolean;
}

/**
 * Submits a signed transaction and drives it to confirmation, resiliently:
 *
 * 1. Routes the initial submit through the MEV relay (if configured), falling
 *    back to the RPC automatically when the relay errors.
 * 2. Polls signature status until the target commitment is reached.
 * 3. Re-broadcasts a still-unconfirmed transaction (dropped-tx recovery) up to
 *    `maxRebroadcasts` times, and detects blockhash expiry to fail fast.
 */
export class ResilientSender {
  private readonly rpc: SenderRpc;
  private readonly relay?: MevRelay;
  private readonly preferRelay: boolean;
  private readonly clock: Clock;
  private readonly sleep: Sleep;

  constructor(options: ResilientSenderOptions) {
    this.rpc = options.rpc;
    this.relay = options.relay;
    this.preferRelay = options.preferRelay ?? true;
    this.clock = options.clock ?? defaultClock;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async send(input: SendInput, options: SendOptions = {}): Promise<SendResult> {
    const target = options.commitment ?? "confirmed";
    const maxRebroadcasts = options.maxRebroadcasts ?? 5;
    const confirmTimeoutMs = options.confirmTimeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    const route = await this.submit(input.base64Transaction, options, true);
    let rebroadcasts = 0;
    const deadline = this.clock() + confirmTimeoutMs;

    while (this.clock() < deadline) {
      const { value } = await this.rpc
        .getSignatureStatuses([input.signature])
        .send({ abortSignal: options.signal });
      const status = value[0];

      if (status) {
        if (status.err) {
          throw new TransactionConfirmationError(
            input.signature,
            rebroadcasts,
            `Transaction ${input.signature} failed on-chain: ${JSON.stringify(status.err)}`,
          );
        }
        if (meetsCommitment(status.confirmationStatus, target)) {
          return {
            signature: input.signature,
            route,
            rebroadcasts,
            confirmed: true,
          };
        }
      }

      if (input.lastValidBlockHeight != null && (await this.isExpired(input))) {
        throw new TransactionConfirmationError(
          input.signature,
          rebroadcasts,
          `Blockhash expired before ${input.signature} confirmed`,
        );
      }

      if (rebroadcasts < maxRebroadcasts) {
        await this.rebroadcast(input.base64Transaction, options);
        rebroadcasts++;
      }
      await this.sleep(pollIntervalMs);
    }

    throw new TransactionConfirmationError(input.signature, rebroadcasts);
  }

  private async submit(
    base64: string,
    options: SendOptions,
    allowRelay: boolean,
  ): Promise<"jito" | "rpc"> {
    if (allowRelay && this.relay && this.preferRelay) {
      try {
        await this.relay.sendTransaction(base64, {
          signal: options.signal,
          skipPreflight: options.skipPreflight,
        });
        return "jito";
      } catch {
        // Relay unavailable/rejected — fall back to the RPC path.
      }
    }
    await this.rpcSend(base64, options);
    return "rpc";
  }

  private async rebroadcast(base64: string, options: SendOptions): Promise<void> {
    // Re-broadcasts are best-effort; a transient failure here just means we
    // retry on the next poll, so swallow the error.
    try {
      await this.rpcSend(base64, options);
    } catch {
      /* ignore */
    }
  }

  private async rpcSend(base64: string, options: SendOptions): Promise<void> {
    await this.rpc
      .sendTransaction(base64, {
        encoding: "base64",
        skipPreflight: options.skipPreflight ?? true,
        maxRetries: 0n,
      })
      .send({ abortSignal: options.signal });
  }

  private async isExpired(input: SendInput): Promise<boolean> {
    const { blockHeight } = await this.rpc.getEpochInfo().send();
    return Number(blockHeight) > Number(input.lastValidBlockHeight);
  }
}

function meetsCommitment(
  status: Commitment | null | undefined,
  target: Commitment,
): boolean {
  if (!status) return false;
  return COMMITMENT_RANK[status] >= COMMITMENT_RANK[target];
}

export function createResilientSender(
  options: ResilientSenderOptions,
): ResilientSender {
  return new ResilientSender(options);
}
