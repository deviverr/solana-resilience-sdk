/** The maximum number of transactions the Jito Block Engine accepts per bundle. */
export const JITO_MAX_BUNDLE_SIZE = 5;

/**
 * A Jito bundle: an ordered, atomic set of up to {@link JITO_MAX_BUNDLE_SIZE}
 * fully-signed, base64-encoded transactions that land together, in order, in
 * the same block — or not at all.
 *
 * The builder enforces the size limit and ordering so you can assemble a
 * multi-transaction bundle (e.g. setup → swap → tip) before submitting it via
 * {@link JitoRelay.sendBundle}. One transaction in the bundle must carry the
 * Jito tip — build that tip with {@link JitoRelay.tipInstruction} and append it
 * to whichever transaction you want to pay it, before signing.
 */
export class JitoBundle {
  private readonly txs: string[] = [];

  constructor(transactions: readonly string[] = []) {
    for (const tx of transactions) this.add(tx);
  }

  /** Append a fully-signed, base64-encoded transaction to the bundle. */
  add(base64Transaction: string): this {
    if (this.txs.length >= JITO_MAX_BUNDLE_SIZE) {
      throw new Error(
        `a Jito bundle may contain at most ${JITO_MAX_BUNDLE_SIZE} transactions`,
      );
    }
    if (typeof base64Transaction !== "string" || base64Transaction.length === 0) {
      throw new Error("bundle transactions must be non-empty base64 strings");
    }
    this.txs.push(base64Transaction);
    return this;
  }

  /** The bundle's transactions, in submission order. */
  get transactions(): readonly string[] {
    return this.txs;
  }

  get size(): number {
    return this.txs.length;
  }

  /** True when the bundle holds the maximum number of transactions. */
  get isFull(): boolean {
    return this.txs.length >= JITO_MAX_BUNDLE_SIZE;
  }
}

/** Convenience factory for a {@link JitoBundle}. */
export function createBundle(transactions?: readonly string[]): JitoBundle {
  return new JitoBundle(transactions);
}

/**
 * Normalize a bundle input to a validated, non-empty list of transactions.
 * Shared by {@link JitoRelay.sendBundle}; throws on an empty or over-sized set.
 */
export function normalizeBundle(
  bundle: JitoBundle | readonly string[],
): readonly string[] {
  const txs = bundle instanceof JitoBundle ? bundle.transactions : bundle;
  if (txs.length === 0) {
    throw new Error("a Jito bundle must contain at least one transaction");
  }
  if (txs.length > JITO_MAX_BUNDLE_SIZE) {
    throw new Error(
      `a Jito bundle may contain at most ${JITO_MAX_BUNDLE_SIZE} transactions`,
    );
  }
  return txs;
}
