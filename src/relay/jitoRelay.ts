import type { MevRelay, RelaySendOptions } from "./mevRelay.js";

/** Canonical Jito mainnet tip accounts (a tip transfer must target one). */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

export const DEFAULT_JITO_BLOCK_ENGINE =
  "https://mainnet.block-engine.jito.wtf";

export interface JitoRelayOptions {
  /** Block engine base URL (default mainnet). Use a regional URL for latency. */
  readonly blockEngineUrl?: string;
  /** Default tip in lamports to advertise to callers (default 10_000). */
  readonly defaultTipLamports?: number;
  readonly fetchFn?: typeof fetch;
  readonly random?: () => number;
}

interface JsonRpcResponse {
  result?: string;
  error?: { code: number; message: string };
}

/**
 * Jito Block Engine relay. Routes transactions through Jito to avoid public
 * mempool frontrunning; the resilient sender wraps this with automatic RPC
 * fallback when the relay is unavailable or rejects the transaction.
 *
 * Note: a Jito-routed transaction must include a SystemProgram transfer of
 * `tipLamports` to one of {@link JITO_TIP_ACCOUNTS} — use {@link getTipAccount}
 * and {@link tipLamports} when building the transaction.
 */
export class JitoRelay implements MevRelay {
  readonly name = "jito";
  readonly tipLamports: number;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;

  constructor(options: JitoRelayOptions = {}) {
    this.baseUrl = (
      options.blockEngineUrl ?? DEFAULT_JITO_BLOCK_ENGINE
    ).replace(/\/$/, "");
    this.tipLamports = options.defaultTipLamports ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.random = options.random ?? Math.random;
  }

  /** Pick a random Jito tip account for the next transaction. */
  getTipAccount(): string {
    const i = Math.floor(this.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[Math.min(i, JITO_TIP_ACCOUNTS.length - 1)]!;
  }

  async sendTransaction(
    base64Transaction: string,
    options: RelaySendOptions = {},
  ): Promise<string> {
    const result = await this.rpc<string>(
      "/api/v1/transactions",
      "sendTransaction",
      [base64Transaction, { encoding: "base64" }],
      options.signal,
    );
    return result;
  }

  /** Submit an atomic bundle of base64 transactions; resolves with a bundle id. */
  async sendBundle(
    base64Transactions: readonly string[],
    options: RelaySendOptions = {},
  ): Promise<string> {
    return this.rpc<string>(
      "/api/v1/bundles",
      "sendBundle",
      [base64Transactions, { encoding: "base64" }],
      options.signal,
    );
  }

  private async rpc<T>(
    path: string,
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Jito ${method} failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as JsonRpcResponse;
    if (json.error) {
      throw new Error(`Jito ${method} error: ${json.error.message}`);
    }
    if (json.result == null) {
      throw new Error(`Jito ${method} returned no result`);
    }
    return json.result as T;
  }
}

export function createJitoRelay(options?: JitoRelayOptions): JitoRelay {
  return new JitoRelay(options);
}
