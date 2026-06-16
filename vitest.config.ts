import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      include: ["src/**/*.ts"],
      // The CLI entrypoint and the public barrel are thin I/O wiring; the
      // logic they delegate to is covered directly in its own modules.
      // `types.ts` and `mevRelay.ts` are interface-only (no runtime code).
      exclude: [
        "src/cli/index.ts",
        "src/index.ts",
        "src/**/types.ts",
        "src/relay/mevRelay.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
