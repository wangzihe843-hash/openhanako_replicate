import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { parseCLI } from "vitest/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// These suites repeatedly parse the full production source tree and hash schema
// dependencies. Give them a separate serial phase without changing test budgets
// or disabling any cases; ordinary tests retain their normal worker pool.
const sourceScanSuites = [
  "tests/persistence-*.test.ts",
  "tests/memory-reset-persistence-registry.test.ts",
  "tests/secret-file-custody.test.ts",
];

// Vitest 4.1 does not forward CLI excludes to inline projects. Reuse its public
// parser so npm's exclusions and callers' additional --exclude flags survive.
const { options: cliOptions } = parseCLI(["vitest", ...process.argv.slice(2)], { allowUnknownOptions: true });
const cliExcluded = cliOptions.exclude ? [cliOptions.exclude].flat() : [];

const excluded = [
  ...configDefaults.exclude,
  ".cache/**",
  // Local references and worktree copies contain duplicate test snapshots.
  ".codex_refs/**",
  // Review output can contain old reproductions and nested test fixtures.
  "output/**",
  ".claude/**",
  "desktop/native/**/.build/**",
  "dist/**",
  "dist-computer-use/**",
  "dist-sandbox/**",
  "dist-server/**",
  "dist-server-bundle/**",
  ...cliExcluded,
];

export default defineConfig({
  resolve: {
    alias: {
      "@hana/plugin-protocol": path.resolve(__dirname, "packages/plugin-protocol/src/index.ts"),
      "@hana/plugin-sdk": path.resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      "@hana/plugin-runtime": path.resolve(__dirname, "packages/plugin-runtime/src/index.ts"),
      "@hana/plugin-components": path.resolve(__dirname, "packages/plugin-components/src/index.ts"),
      "@": path.resolve(__dirname, "desktop/src/react"),
    },
  },
  test: {
    exclude: excluded,
    testTimeout: 10_000,
    setupFiles: ["./tests/setup-auto-updater.ts"],
    server: {
      deps: {
        inline: ["electron-updater", /desktop\/auto-updater/],
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...excluded, ...sourceScanSuites],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "persistence",
          include: sourceScanSuites,
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
