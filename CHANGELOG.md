# Changelog

All notable changes to `solana-resilience-sdk` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-17

Initial release. A resilience layer for Solana dApps, implemented as a custom
**web3.js v2.0 `RpcTransport`** so it composes behind the standard
`createSolanaRpc` API.

### Added

- **Resilient RPC** (`createResilientRpc` / `createResilientClient`) — a drop-in
  `Rpc<SolanaRpcApi>` with health-aware load balancing across four strategies
  (`least-latency`, `round-robin`, `least-inflight`, `weighted-random`),
  automatic failover with exponential backoff + full jitter, and per-endpoint
  circuit breaking (closed → open → half-open).
- **Background health checker** — periodic `getHealth` probes steer traffic away
  from degraded nodes before user requests reach them.
- **MEV (Jito) routing** (`createJitoRelay`, `createResilientSender`) — submit
  through the Jito Block Engine with automatic RPC fallback, dropped-transaction
  rebroadcast, confirmation tracking, and blockhash-expiry fast-fail.
- **Dynamic fee estimation** (`createFeeEstimator`) — aggregate priority-fee
  estimates from native `getRecentPrioritizationFees`, Helius, or custom sources
  with caching, multiplier, and min/max clamps.
- **Wallet adapter** (`createResilientWalletAdapter`, `fromWalletStandard`) —
  route any Wallet-Standard wallet's sends through the resilience layer.
- **Observability** — `createOpenTelemetryExporter` (vendor-neutral, no-op safe)
  and `createDatadogExporter` (direct metrics intake), plus a `MetricsCollector`
  exposing global / per-endpoint / per-method p50/p95/p99.
- **Real-time monitor** (`createMonitor`) and a `srpc` diagnostics CLI with
  `doctor`, `bench`, and `monitor` commands.
- **Deterministic network simulator** (`test/mocks/networkSimulator.ts`) with a
  manual clock — drives the fully-offline test suite (110 tests, 99% lines /
  94% branches) across latency, drops, 429 bursts, and intermittent errors.

[0.1.0]: https://github.com/deviverr/solana-resilience-sdk/releases/tag/v0.1.0
