export interface RelaySendOptions {
  readonly signal?: AbortSignal;
  readonly skipPreflight?: boolean;
}

/**
 * A transaction relay (e.g. a Jito/MEV block engine) that accepts fully-signed,
 * base64-encoded transactions and returns the resulting signature. Implementing
 * this interface lets the resilient sender route through any relay with the
 * same automatic RPC fallback behaviour.
 */
export interface MevRelay {
  readonly name: string;
  /** Submit a base64, fully-signed transaction; resolves with its signature. */
  sendTransaction(
    base64Transaction: string,
    options?: RelaySendOptions,
  ): Promise<string>;
}
