/**
 * solana-resilience-sdk
 *
 * A systems-grade reliability layer for Solana dApps, built on web3.js v2.0:
 * health-aware load balancing, automatic failover, circuit breaking, MEV (Jito)
 * routing with RPC fallback, dynamic fee estimation, OpenTelemetry/Datadog
 * observability and a live monitor.
 */

// Core resilience
export {
  createResilientRpc,
  createResilientClient,
  type ResilientClient,
  type ResilientClientConfig,
} from "./core/resilientRpc.js";
export {
  createResilientTransport,
  methodOf,
  type ResilientTransport,
  type ResilientTransportConfig,
} from "./core/resilientTransport.js";
export {
  NodePool,
  Endpoint,
  percentile,
  type NodePoolOptions,
} from "./core/nodePool.js";
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
} from "./core/circuitBreaker.js";
export {
  HealthChecker,
  createGetHealthProbe,
  type HealthProbe,
  type HealthCheckerOptions,
} from "./core/healthChecker.js";
export {
  withRetry,
  computeBackoff,
  type RetryOptions,
} from "./core/retry.js";
export {
  AllEndpointsFailedError,
  NoHealthyEndpointsError,
  TransactionConfirmationError,
  type FailedAttempt,
} from "./core/errors.js";
export type {
  EndpointConfig,
  EndpointStats,
  LoadBalanceStrategy,
  CircuitState,
  RpcMetricEvent,
  Transport,
} from "./core/types.js";

// Fees
export {
  FeeEstimator,
  createFeeEstimator,
  type FeeEstimate,
  type FeeSource,
  type FeeSourceContext,
  type FeeEstimatorOptions,
  type AggregationMode,
} from "./fees/feeEstimator.js";
export {
  nativeRecentFeesSource,
  heliusPriorityFeeSource,
  staticFeeSource,
  type RecentFeesRpc,
} from "./fees/providers.js";

// Relays + sending
export type { MevRelay, RelaySendOptions } from "./relay/mevRelay.js";
export {
  JitoRelay,
  createJitoRelay,
  JITO_TIP_ACCOUNTS,
  DEFAULT_JITO_BLOCK_ENGINE,
  type JitoRelayOptions,
} from "./relay/jitoRelay.js";
export {
  ResilientSender,
  createResilientSender,
  type SenderRpc,
  type SendInput,
  type SendOptions,
  type SendResult,
  type Commitment,
  type ResilientSenderOptions,
} from "./relay/sender.js";

// Wallet
export {
  ResilientWalletAdapter,
  createResilientWalletAdapter,
  fromWalletStandard,
  type WalletLike,
  type WalletStandardSignFeature,
  type ResilientWalletAdapterOptions,
  type SignAndSendInput,
} from "./wallet/adapter.js";

// Observability
export {
  MetricsCollector,
  type MetricsExporter,
  type MetricsSnapshot,
  type MethodStats,
} from "./observability/metrics.js";
export {
  createOpenTelemetryExporter,
  type OpenTelemetryExporterOptions,
} from "./observability/otel.js";
export {
  DatadogExporter,
  createDatadogExporter,
  type DatadogExporterOptions,
} from "./observability/datadog.js";

// Monitoring
export {
  Monitor,
  createMonitor,
  type MonitorSnapshot,
  type MonitorOptions,
} from "./monitor/monitor.js";

// Utils
export { base58Encode, bytesToBase64 } from "./util/base58.js";
