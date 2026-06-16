import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  // Type declarations only for the library entry; the CLI is an executable.
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node18",
  // Keep heavy runtime deps external so consumers dedupe their own copy.
  external: ["@solana/web3.js", "@opentelemetry/api"],
});
