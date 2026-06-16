/** Error types raised by the resilience layer. */

/** A failed attempt against a single endpoint, captured for diagnostics. */
export interface FailedAttempt {
  readonly endpoint: string;
  readonly error: Error;
}

/**
 * Thrown when every candidate endpoint failed (or no healthy endpoint was
 * available) for a single logical RPC call. Carries the per-endpoint errors.
 */
export class AllEndpointsFailedError extends Error {
  readonly attempts: readonly FailedAttempt[];
  readonly method: string;

  constructor(method: string, attempts: readonly FailedAttempt[]) {
    const detail = attempts
      .map((a) => `${a.endpoint}: ${a.error.message}`)
      .join("; ");
    super(
      `All ${attempts.length} endpoint(s) failed for "${method}"` +
        (detail ? ` — ${detail}` : ""),
    );
    this.name = "AllEndpointsFailedError";
    this.attempts = attempts;
    this.method = method;
  }
}

/** Thrown when the node pool has no endpoint whose circuit permits a request. */
export class NoHealthyEndpointsError extends Error {
  constructor(message = "No healthy RPC endpoints available") {
    super(message);
    this.name = "NoHealthyEndpointsError";
  }
}

/** Thrown when a submitted transaction could not be confirmed in time. */
export class TransactionConfirmationError extends Error {
  readonly signature: string;
  readonly attempts: number;

  constructor(signature: string, attempts: number, message?: string) {
    super(
      message ??
        `Transaction ${signature} was not confirmed after ${attempts} attempt(s)`,
    );
    this.name = "TransactionConfirmationError";
    this.signature = signature;
    this.attempts = attempts;
  }
}
