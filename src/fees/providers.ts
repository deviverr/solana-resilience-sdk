import { percentile } from "../core/nodePool.js";
import type { FeeSource } from "./feeEstimator.js";

/** Minimal structural view of the one RPC method the native source needs. */
export interface RecentFeesRpc {
  getRecentPrioritizationFees(accounts?: readonly string[]): {
    send(options?: { abortSignal?: AbortSignal }): Promise<
      readonly { readonly slot: bigint | number; readonly prioritizationFee: bigint | number }[]
    >;
  };
}

export interface NativeFeeSourceOptions {
  /** Percentile of recent non-zero fees to target (default 75). */
  readonly percentile?: number;
}

/**
 * Native priority-fee source backed by `getRecentPrioritizationFees`. Works
 * with any web3.js v2 RPC (including a resilient one). Returns the chosen
 * percentile of recent non-zero prioritization fees, in micro-lamports per CU.
 */
export function nativeRecentFeesSource(
  rpc: RecentFeesRpc,
  options: NativeFeeSourceOptions = {},
): FeeSource {
  const p = options.percentile ?? 75;
  return {
    name: "native-recent-fees",
    async estimate(context) {
      const accounts = context.accounts;
      const rows = await rpc
        .getRecentPrioritizationFees(accounts)
        .send({ abortSignal: context.signal });
      const fees = rows
        .map((r) => Number(r.prioritizationFee))
        .filter((f) => f > 0);
      if (fees.length === 0) return null;
      return percentile(fees, p);
    },
  };
}

export interface HeliusFeeSourceOptions {
  /** Full Helius RPC URL including `?api-key=…`. */
  readonly url: string;
  /** Priority level (default `Medium`). */
  readonly priorityLevel?: "Min" | "Low" | "Medium" | "High" | "VeryHigh";
  /** Base64 serialized transaction, if you want a tx-scoped estimate. */
  readonly transaction?: string;
  readonly fetchFn?: typeof fetch;
}

/**
 * Helius `getPriorityFeeEstimate` source. Returns micro-lamports per CU for the
 * requested priority level, scoped either to a serialized transaction or to the
 * writable account keys passed in the estimate context.
 */
export function heliusPriorityFeeSource(
  options: HeliusFeeSourceOptions,
): FeeSource {
  const fetchFn = options.fetchFn ?? fetch;
  const priorityLevel = options.priorityLevel ?? "Medium";
  return {
    name: "helius",
    async estimate(context) {
      const params: Record<string, unknown> = {
        options: { priorityLevel },
      };
      if (options.transaction) {
        params["transaction"] = options.transaction;
      } else if (context.accounts && context.accounts.length > 0) {
        params["accountKeys"] = context.accounts;
      } else {
        return null;
      }

      const response = await fetchFn(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "fee-estimate",
          method: "getPriorityFeeEstimate",
          params: [params],
        }),
        signal: context.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as {
        result?: { priorityFeeEstimate?: number };
      };
      const value = json.result?.priorityFeeEstimate;
      return typeof value === "number" ? value : null;
    },
  };
}

/** A constant fee source — useful as a floor or for tests. */
export function staticFeeSource(microLamportsPerCu: number): FeeSource {
  return {
    name: "static",
    estimate: async () => microLamportsPerCu,
  };
}
