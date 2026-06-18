# Changelog

All notable changes to `solana-resilience-sdk` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-06-18

### Added

- **Prometheus exporter** — `createPrometheusExporter(...)` renders RPC metrics
  in the Prometheus text exposition format (cumulative counters plus a latency
  histogram with `_bucket`/`_sum`/`_count` series). Mount `requestListener()` on
  an existing server or call `serve({ port })` to stand up a scrapeable
  `/metrics` endpoint, alongside the existing OpenTelemetry & Datadog exporters.
- **Triton & QuickNode fee sources** — `tritonPriorityFeeSource(...)` (percentile
  over Triton's `getRecentPrioritizationFees`) and `quickNodePriorityFeeSource(...)`
  (the `qn_estimatePriorityFees` add-on) join the native and Helius sources, so
  priority-fee estimation works on dedicated providers without a Helius key.
- **Jito bundle helper** — `JitoBundle` / `relay.bundle()` assemble an ordered,
  atomic multi-transaction bundle (validated against the 5-tx Block Engine
  limit), and `relay.sendBundle(...)` now accepts a `JitoBundle` or a raw array.
  Exports `createBundle`, `normalizeBundle`, and `JITO_MAX_BUNDLE_SIZE`.

### Changed

- Test suite expanded to **178 tests** at **100% statements / branches /
  functions / lines**; enforced coverage floors raised to 99/100/98/99.

### Fixed

- **Health checker**: the default `getHealth` probe now inspects the response
  body. A node that is behind replies with a JSON-RPC error envelope that the
  raw transport does not throw on, so it was previously left in rotation; such
  endpoints (and any non-`"ok"` result) are now correctly marked unhealthy.

### Earlier on `main` (pre-tag)

- **WebSocket subscription failover** — `createResilientSubscriptions(...)` wraps
  web3.js v2 subscriptions in an auto-reconnecting, endpoint-rotating async
  iterable so `accountSubscribe` / `slotSubscribe` / `signatureSubscribe` streams
  survive dropped sockets and node failovers. The transport-agnostic core
  (`resilientSubscription`) is fully unit-tested offline. Adds
  `SubscriptionClosedError`. Runnable devnet demo: `npm run example:subs`.
- **Jito tip helper** — `relay.tipInstruction({ from })` and the standalone
  `createTransferInstruction(...)` build the required SystemProgram tip transfer
  as a ready-to-append web3.js v2 instruction. Also exports
  `SYSTEM_PROGRAM_ADDRESS`.
- **Release workflow** — pushing a `v*` tag verifies the build and cuts a GitHub
  release with a packed tarball and generated notes.
- `SECURITY.md` with private vulnerability-reporting guidance.

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

[0.2.0]: https://github.com/deviverr/solana-resilience-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/deviverr/solana-resilience-sdk/releases/tag/v0.1.0
