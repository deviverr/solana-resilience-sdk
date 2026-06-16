#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { createSolanaRpc } from "@solana/web3.js";
import {
  createResilientClient,
  createMonitor,
  type EndpointConfig,
} from "../index.js";

const DEFAULT_ENDPOINTS = ["https://api.mainnet-beta.solana.com"];

function parseEndpoints(value: string | undefined): EndpointConfig[] {
  const urls = (value ?? DEFAULT_ENDPOINTS.join(","))
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return urls.map((url) => ({ url }));
}

const program = new Command();
program
  .name("srpc")
  .description(
    "Diagnostics CLI for the Solana RPC resilience SDK — check endpoint health, " +
      "benchmark latency, and watch a live reliability dashboard.",
  )
  .option(
    "-r, --rpc <urls>",
    "comma-separated RPC endpoint URLs",
    DEFAULT_ENDPOINTS.join(","),
  );

program
  .command("doctor")
  .description("Probe each endpoint's health, slot and version")
  .action(async () => {
    const endpoints = parseEndpoints(program.opts().rpc);
    console.log(pc.bold("\nRPC Doctor\n"));
    let anyDown = false;
    for (const { url } of endpoints) {
      const rpc = createSolanaRpc(url);
      const start = performance.now();
      try {
        await rpc.getHealth().send();
        const slot = await rpc.getSlot().send();
        const version = await rpc.getVersion().send();
        const ms = (performance.now() - start).toFixed(0);
        console.log(
          `${pc.green("● up  ")} ${url}\n    slot=${slot} ` +
            `version=${version["solana-core"]} latency=${ms}ms`,
        );
      } catch (error) {
        anyDown = true;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`${pc.red("● down")} ${url}\n    ${pc.red(message)}`);
      }
    }
    process.exitCode = anyDown ? 1 : 0;
  });

program
  .command("bench")
  .description("Send N requests through the resilient pool and report latency")
  .option("-c, --count <n>", "number of requests", "20")
  .action(async (opts: { count: string }) => {
    const endpoints = parseEndpoints(program.opts().rpc);
    const count = Number(opts.count);
    const client = createResilientClient({ endpoints });
    console.log(pc.bold(`\nBenchmarking ${count} getSlot calls...\n`));

    for (let i = 0; i < count; i++) {
      try {
        await client.rpc.getSlot().send();
      } catch {
        /* failures are reflected in the metrics snapshot */
      }
    }

    const m = client.metrics.snapshot();
    console.log(
      `requests=${m.totalRequests} failures=${m.totalFailures} ` +
        `failRate=${(m.failureRate * 100).toFixed(1)}%`,
    );
    console.log(
      `p50=${m.p50LatencyMs.toFixed(0)}ms ` +
        `p95=${m.p95LatencyMs.toFixed(0)}ms ` +
        `p99=${m.p99LatencyMs.toFixed(0)}ms`,
    );
    console.log(pc.dim("\nper-endpoint:"));
    for (const [name, s] of Object.entries(m.perEndpoint)) {
      console.log(
        `  ${name}: req=${s.requests} fail=${s.failures} ` +
          `avg=${s.avgLatencyMs.toFixed(0)}ms`,
      );
    }
    await client.close();
  });

program
  .command("monitor")
  .description("Live dashboard of endpoint health and RPC metrics")
  .option("-i, --interval <ms>", "refresh interval", "1000")
  .action(async (opts: { interval: string }) => {
    const endpoints = parseEndpoints(program.opts().rpc);
    const interval = Number(opts.interval);
    const client = createResilientClient({
      endpoints,
      healthCheck: { intervalMs: interval },
    });
    const monitor = createMonitor({
      collector: client.metrics,
      pool: client.pool,
    });

    monitor.onUpdate((snapshot) => {
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(colorize(monitor.render(snapshot)));
    });
    monitor.start(interval);

    const shutdown = async () => {
      monitor.stop();
      await client.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
  });

function colorize(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.includes(" up ")
        ? pc.green(line)
        : line.includes(" down ")
          ? pc.red(line)
          : line,
    )
    .join("\n");
}

program.parseAsync().catch((error) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
