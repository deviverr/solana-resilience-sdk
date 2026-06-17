# solana-resilience-sdk

[![CI](https://github.com/deviverr/solana-resilience-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/deviverr/solana-resilience-sdk/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/deviverr/solana-resilience-sdk?label=release&color=9945FF)](https://github.com/deviverr/solana-resilience-sdk/releases)
[![coverage](https://img.shields.io/badge/coverage-99%25%20lines%20%2F%2094%25%20branches-brightgreen)](#testing--network-simulation)
[![web3.js](https://img.shields.io/badge/web3.js-v2.0-9945FF)](https://github.com/anza-xyz/kit)
[![node](https://img.shields.io/badge/node-%E2%89%A518-339933)](#install)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> A systems-grade SDK that makes Solana RPC and transaction submission reliable — built on **web3.js v2.0**.

Public RPCs rate-limit, drop transactions, lag, and occasionally fall over. This SDK wraps web3.js v2.0 with a resilience layer so your dApp keeps working anyway: **health-aware load balancing, automatic failover, circuit breaking, MEV (Jito) routing with RPC fallback, dropped-transaction rebroadcast, dynamic priority-fee estimation, OpenTelemetry/Datadog observability, and a live diagnostics CLI.**

The whole layer is implemented as a **custom web3.js v2 `RpcTransport`**, so it composes *behind* the standard `createSolanaRpc` API. You get a normal v2 RPC object — your existing code doesn't change.

```ts
import { createResilientRpc } from "solana-resilience-sdk";

const rpc = createResilientRpc({
  endpoints: [
    { url: "https://your-primary-rpc" },
    { url: "https://your-fallback-rpc", weight: 2 },
  ],
});

// Exactly the web3.js v2 API — now load-balanced, failed-over and observable.
const slot = await rpc.getSlot().send();
```

---

## Why this design

web3.js v2.0 builds its RPC client from a swappable transport function:
`createSolanaRpcFromTransport(transport)`. We provide a transport that, on every
call, picks the healthiest endpoint, fails over on error, records metrics, and
trips circuit breakers — all transparently.

```
createResilientRpc(config)
  └─ createSolanaRpcFromTransport( resilientTransport )
        resilientTransport:
          NodePool.pick()  →  CircuitBreaker gate  →  upstream transport
              │                                            │
              └──── on failure: backoff + failover to next healthy node
              └──── always: record latency/outcome → MetricsCollector → OTel/Datadog
```

Because it's "just a transport," every concern is isolated and unit-testable,
and you keep 100% of the v2 API surface and types.

## Install

```bash
npm install solana-resilience-sdk @solana/web3.js
```

Requires `@solana/web3.js@^2` (a.k.a. `@solana/kit`) and Node ≥ 18.

---

## Features

### 1. Resilient RPC — load balancing + failover (web3.js v2.0)

`createResilientRpc` returns a standard `Rpc<SolanaRpcApi>`. `createResilientClient`
additionally exposes the pool, metrics and health checker.

```ts
import { createResilientClient } from "solana-resilience-sdk";

const client = createResilientClient({
  endpoints: [{ url: primary }, { url: fallback }],
  strategy: "least-latency",          // or round-robin | least-inflight | weighted-random
  healthCheck: { intervalMs: 10_000 },// background getHealth probes
  breaker: { failureThreshold: 5, openDurationMs: 10_000 },
});

const slot = await client.rpc.getSlot().send();
console.log(client.metrics.snapshot()); // p50/p95, per-endpoint, per-method
await client.close();
```

- **Load balancing** across only the endpoints whose circuit is closed/half-open and that pass health checks.
- **Automatic failover**: a transport error fails the call over to the next-best endpoint with exponential backoff + jitter.
- **Circuit breaker** per endpoint (closed → open → half-open) keeps traffic off degraded nodes and probes recovery.
- **Health checker** steers traffic *before* a user request hits a bad node.

### 2. MEV (Jito) routing with automatic RPC fallback

Route through the Jito Block Engine to avoid public-mempool frontrunning; fall
back to a normal RPC automatically if the relay is unavailable, and re-broadcast
dropped transactions until they confirm or the blockhash expires.

```ts
import { createJitoRelay, createResilientSender } from "solana-resilience-sdk";

const relay = createJitoRelay({ blockEngineUrl: "https://mainnet.block-engine.jito.wtf" });
const sender = createResilientSender({ rpc: client.rpc, relay });

const result = await sender.send(
  { base64Transaction, signature, lastValidBlockHeight },
  { commitment: "confirmed", maxRebroadcasts: 5 },
);
// → { signature, route: "jito" | "rpc", rebroadcasts, confirmed }
```

A Jito-routed transaction must tip: use `relay.getTipAccount()` and `relay.tipLamports`
to add a SystemProgram transfer to one of the canonical tip accounts.

### 3. Dynamic fee estimation

Aggregate priority-fee estimates from multiple sources (native on-chain fees,
Helius, or any custom source) with caching and safety clamps.

```ts
import { createFeeEstimator, nativeRecentFeesSource, heliusPriorityFeeSource } from "solana-resilience-sdk";

const fees = createFeeEstimator({
  sources: [
    nativeRecentFeesSource(client.rpc, { percentile: 75 }),
    heliusPriorityFeeSource({ url: HELIUS_URL, priorityLevel: "High" }),
  ],
  aggregate: "max",      // safest for landing
  multiplier: 1.25,
  cacheTtlMs: 2_000,
});

const { microLamportsPerCu } = await fees.estimate({ accounts: writableAccounts });
```

### 4. Wallet adapter (Wallet Standard)

Plug any standard wallet (Phantom, Solflare, Backpack, …) into the resilience
layer. The wallet signs; broadcast + confirmation go through the resilient
sender, so every wallet send gets MEV routing, RPC fallback and rebroadcast.

```ts
import { createResilientWalletAdapter, fromWalletStandard } from "solana-resilience-sdk";

const adapter = createResilientWalletAdapter({
  wallet: fromWalletStandard(wallet.features["solana:signTransaction"]),
  address: account.address,
  sender,
});

const { signature, confirmed } = await adapter.signAndSend({ transaction, lastValidBlockHeight });
```

### 5. Observability — OpenTelemetry & Datadog

```ts
import { createOpenTelemetryExporter, createDatadogExporter } from "solana-resilience-sdk";

client.metrics.addExporter(createOpenTelemetryExporter());          // → OTLP → Datadog/Grafana/Honeycomb
client.metrics.addExporter(createDatadogExporter({ apiKey: DD_KEY }));// direct Datadog metrics intake
```

Exports request counts, failures, failovers, and a latency histogram, tagged by
endpoint and method.

### 6. Real-time monitor + diagnostics CLI

```bash
npx srpc doctor   --rpc url1,url2     # per-endpoint health, slot, version, latency
npx srpc bench    --rpc url1,url2 -c 50  # latency distribution across the pool
npx srpc monitor  --rpc url1,url2     # live reliability dashboard
```

```
Solana RPC Resilience — Live Monitor
requests=42  failures=1  failRate=2.4%  p50=48ms  p95=179ms

ENDPOINT                     HEALTH   CIRCUIT    AVG      P95      REQ     FAIL    INFLT
-----------------------------------------------------------------------------------------
rpc-primary                  up       closed     46ms     120ms    28      0       1
rpc-fallback                 up       half-open   210ms    640ms    14      1       0
```

`createMonitor({ collector, pool })` also exposes `snapshot()` / `onUpdate()` for
building your own dashboard.

---

## Testing & network simulation

The suite runs **fully offline** against a deterministic network simulator
(`test/mocks/networkSimulator.ts`) that injects latency, dropped/timed-out
calls, HTTP 429 rate-limit bursts, and intermittent errors — with a manual clock
so backoff/expiry/health timing is exact and fast.

```bash
npm test            # 110 tests, fully offline
npm run test:cov    # coverage with enforced thresholds (CI-gated)
```

```
Statements   : 99.37%
Branches     : 94.40%
Functions    : 99.11%
Lines        : 99.37%
```

Failure modes covered: failover to a healthy node, circuit open/half-open/close,
retry/backoff limits, rate-limit handling, Jito→RPC fallback, fee aggregation
with failing providers, dropped-tx rebroadcast, and blockhash-expiry fast-fail.

---

## Bounty requirement → implementation map

| Requirement | Where | Test |
|---|---|---|
| web3.js v2.0 compatibility | `createResilientRpc` → `createSolanaRpcFromTransport` | `resilientRpc.test.ts` |
| Wallet adapter (1+ major wallet) | `wallet/adapter.ts` (`fromWalletStandard`) | `wallet.test.ts` |
| MEV routing + RPC fallback | `relay/jitoRelay.ts`, `relay/sender.ts` | `jitoRelay.test.ts`, `sender.test.ts` |
| Dynamic fee estimates | `fees/feeEstimator.ts`, `fees/providers.ts` | `feeEstimator.test.ts`, `providers.test.ts` |
| Healthy-node distribution | `core/nodePool.ts`, `core/healthChecker.ts` | `nodePool.test.ts`, `healthChecker.test.ts` |
| Observability (OTel/Datadog) | `observability/otel.ts`, `observability/datadog.ts` | `otel.test.ts`, `datadog.test.ts` |
| Real-time monitor | `monitor/monitor.ts` | `monitor.test.ts` |
| Diagnostics CLI | `cli/index.ts` (`srpc`) | live `doctor`/`bench`/`monitor` |
| 90%+ coverage w/ network sim | `test/mocks/networkSimulator.ts` + suite | 99% lines / 94% branches, 110 tests |

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Bundle ESM + CJS + types (tsup) |
| `npm test` / `npm run test:cov` | Run tests / with coverage |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run example` | Run `examples/basic.ts` against devnet |
| `npm run cli -- doctor` | Run the CLI from source |

## Roadmap

- [ ] Triton / QuickNode dedicated fee sources
- [ ] Jito bundle helper that builds the tip transfer for you
- [ ] WebSocket subscription failover (`accountSubscribe`, `slotSubscribe`)
- [ ] Prometheus `/metrics` exporter alongside OpenTelemetry & Datadog
- [ ] Adaptive strategy that auto-switches between load-balancing modes under load

## Contributing

Issues and PRs are welcome. To get set up:

```bash
git clone https://github.com/deviverr/solana-resilience-sdk
cd solana-resilience-sdk
npm install
npm run typecheck && npm run test:cov && npm run build
```

The whole suite runs offline against the deterministic network simulator, so
`npm test` needs no RPC endpoint. Please keep coverage above the enforced
thresholds (95% lines / 90% branches) and add a test for any new failure mode.

## Author

Built and maintained by [**deviverr**](https://github.com/deviverr).

## License

[MIT](./LICENSE) © deviverr
