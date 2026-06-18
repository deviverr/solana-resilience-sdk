/**
 * Resilient WebSocket subscriptions: stream live slot notifications with
 * automatic reconnect + endpoint failover. The stream is a single continuous
 * async iterable even as sockets drop and we rotate across endpoints.
 *
 * Run with:  npm run example:subs
 */
import { createResilientSubscriptions } from "../src/index.js";

async function main() {
  const subs = createResilientSubscriptions({
    // Add more wss:// endpoints to fail over across them on reconnect.
    endpoints: ["wss://api.devnet.solana.com"],
    backoff: { baseDelayMs: 250, maxDelayMs: 5_000 },
    onReconnect: (error, generation, delayMs) =>
      console.log(
        `↻ reconnecting (#${generation}) in ${delayMs}ms` +
          (error instanceof Error ? ` after: ${error.message}` : ""),
      ),
  });

  // Stop the demo after 5 notifications or 30s, whichever comes first. Aborting
  // the signal (like calling AbortController in your app) tears the socket down.
  const ac = new AbortController();
  const watchdog = setTimeout(() => ac.abort(), 30_000);

  const stream = subs.subscribe(
    (rpc, signal) => rpc.slotNotifications().subscribe({ abortSignal: signal }),
    { signal: ac.signal },
  );

  console.log("Subscribed to slot notifications — streaming 5 then stopping…\n");

  let count = 0;
  for await (const note of stream) {
    console.log(`slot=${note.slot}  parent=${note.parent}  root=${note.root}`);
    if (++count >= 5) break; // breaking closes the underlying socket cleanly
  }

  clearTimeout(watchdog);
  console.log(`\nStream closed cleanly after ${count} notification(s).`);
}

main()
  // The live WebSocket keeps the event loop alive, so exit explicitly once done.
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
