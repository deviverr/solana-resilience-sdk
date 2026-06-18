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

export interface TritonFeeSourceOptions {
  /** Triton (RPC Pool) RPC URL. */
  readonly url: string;
  /** Percentile of recent fees to target (0–100, default 75). */
  readonly percentile?: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * Triton "dedicated" priority-fee source. Triton's `getRecentPrioritizationFees`
 * accepts a `percentile` hint (in basis points) and returns recent
 * prioritization fees; we then take the requested percentile of the non-zero
 * fees client-side, in micro-lamports per CU. Scopes to `context.accounts` when
 * provided for a more accurate, write-lock-aware estimate.
 */
export function tritonPriorityFeeSource(
  options: TritonFeeSourceOptions,
): FeeSource {
  const fetchFn = options.fetchFn ?? fetch;
  const p = options.percentile ?? 75;
  return {
    name: "triton",
    async estimate(context) {
      const config = { percentile: Math.round(p * 100) }; // Triton uses 0–10000 bp
      const accounts = context.accounts ?? [];
      const response = await fetchFn(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "fee-estimate",
          method: "getRecentPrioritizationFees",
          params: [accounts, config],
        }),
        signal: context.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as {
        result?: readonly { readonly prioritizationFee?: bigint | number }[];
      };
      const fees = (json.result ?? [])
        .map((r) => Number(r.prioritizationFee))
        .filter((f) => f > 0);
      if (fees.length === 0) return null;
      return percentile(fees, p);
    },
  };
}

export interface QuickNodeFeeSourceOptions {
  /** QuickNode endpoint URL (with the Priority Fee API add-on enabled). */
  readonly url: string;
  /** Recommendation level to read from `per_compute_unit` (default `medium`). */
  readonly level?: "low" | "medium" | "high" | "extreme";
  /** Restrict the estimate to writes touching this account/program. */
  readonly account?: string;
  /** Number of recent blocks to consider. */
  readonly lastNBlocks?: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * QuickNode dedicated priority-fee source via the `qn_estimatePriorityFees`
 * add-on. Returns the per-compute-unit fee (micro-lamports/CU) for the chosen
 * recommendation `level`.
 */
export function quickNodePriorityFeeSource(
  options: QuickNodeFeeSourceOptions,
): FeeSource {
  const fetchFn = options.fetchFn ?? fetch;
  const level = options.level ?? "medium";
  return {
    name: "quicknode",
    async estimate(context) {
      const params: Record<string, unknown> = { api_version: 2 };
      if (options.lastNBlocks != null) params["last_n_blocks"] = options.lastNBlocks;
      if (options.account) params["account"] = options.account;
      const response = await fetchFn(options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "fee-estimate",
          method: "qn_estimatePriorityFees",
          params,
        }),
        signal: context.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as {
        result?: { per_compute_unit?: Partial<Record<string, number>> };
      };
      const value = json.result?.per_compute_unit?.[level];
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
