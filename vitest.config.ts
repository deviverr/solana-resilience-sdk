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
      // Floors are set comfortably below the achieved numbers (99% lines /
      // 94% branches) so a small refactor can't silently erode the suite,
      // while still failing CI hard if coverage regresses below the bounty bar.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
