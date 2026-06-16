/**
 * End-to-end example: a resilient RPC across multiple endpoints with health
 * checks, live metrics, dynamic fee estimation and a rendered monitor snapshot.
 *
 * Run with:  npm run example
 */
import {
  createResilientClient,
  createMonitor,
  createFeeEstimator,
  nativeRecentFeesSource,
  createOpenTelemetryExporter,
} from "../src/index.js";

async function main() {
  // 1. A drop-in web3.js v2 RPC that load-balances + fails over across nodes.
  const client = createResilientClient({
    endpoints: [
      { url: "https://api.devnet.solana.com", name: "devnet-primary" },
      { url: "https://api.devnet.solana.com", name: "devnet-secondary", weight: 2 },
    ],
    strategy: "least-latency",
    healthCheck: { intervalMs: 10_000 },
  });

  // Export every RPC metric to OpenTelemetry (→ Datadog/Grafana via OTLP).
  client.metrics.addExporter(createOpenTelemetryExporter());

  // 2. Use it exactly like a normal v2 RPC.
  const slot = await client.rpc.getSlot().send();
  const { value: blockhash } = await client.rpc.getLatestBlockhash().send();
  console.log(`slot=${slot}`);
  console.log(`blockhash=${blockhash.blockhash} (valid to ${blockhash.lastValidBlockHeight})`);

  // 3. Dynamic priority-fee estimate from on-chain recent fees.
  const fees = createFeeEstimator({
    sources: [nativeRecentFeesSource(client.rpc, { percentile: 75 })],
    multiplier: 1.2,
  });
  const estimate = await fees.estimate();
  console.log(
    `priority fee ≈ ${estimate.microLamportsPerCu} µlamports/CU (source: ${estimate.source})`,
  );

  // 4. Live reliability snapshot.
  const monitor = createMonitor({ collector: client.metrics, pool: client.pool });
  console.log("\n" + monitor.render());

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
