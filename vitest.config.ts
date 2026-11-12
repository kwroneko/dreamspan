import { availableParallelism, loadavg } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

/**
 * Test files that run only in `npm run test:slow`: model-based runs over many seeds, scale
 * fixtures, and measurements of time or memory, which a busy host fails. `npm test` (and
 * so `npm run check`) runs every other file. Paths are relative to packages/server.
 */
const SLOW_SERVER_FILES = [
  "test/protocol/*.model.test.ts",
  "test/*Scale.test.ts",
  "test/historyPerf.test.ts",
  // Process spawns, with time limits on startup and shutdown.
  "test/startup.test.ts",
  "test/shutdown.test.ts"
]

/**
 * The live provider suite (`npm run test:live`): real requests to the providers' own APIs,
 * paid or quota-limited, so never part of `npm test` or `npm run check`. Skipped unless
 * RP_LIVE_KEY_DIR names a directory of key files (packages/server/test/live/support/live.ts).
 */
const LIVE_SERVER_FILES = ["test/live/**/*.test.ts"]

/**
 * Tests in the other files that measure time or load: tagged `slow`, run by test:slow only.
 * `slowIt.live(…)` (packages/server/test/support/slow.ts), or `tags: ["slow"]` in the options.
 */
const tags = [{ name: "slow", description: "Timing, scale or soak: run by npm run test:slow, not npm test." }]

/**
 * Test processes: the host's free cores less a margin, so a run on a busy machine doesn't
 * oversubscribe it and fail tests on time limits, but never fewer than a quarter of the
 * cores, so a saturated host still gets a run that finishes. VITEST_MAX_WORKERS overrides
 * it (Vitest reads it after this config).
 *
 * Computed once per process: Vitest evaluates this file again for each project, and the load
 * moves in between. Projects given different values refuse to start ("Projects … have
 * different 'maxWorkers' but same 'sequence.groupOrder'").
 */
const once = globalThis as { rpVitestMaxWorkers?: number }
const maxWorkers = (once.rpVitestMaxWorkers ??= (() => {
  const cores = availableParallelism()
  const free = Math.floor(cores - (loadavg()[0] ?? 0)) - 2
  return Math.max(2, Math.floor(cores / 4), Math.min(cores - 2, free))
})())

/**
 * Some tests import a large module graph in their body, and Vite transforms it on first use:
 * more than Vitest's default 5 s on a busy host.
 */
const unit = { include: ["test/**/*.test.ts"], environment: "node", tags, testTimeout: 30_000 } as const

const server = {
  root: "packages/server",
  environment: join(import.meta.dirname, "packages/server/test/support/testEnvironment.ts"),
  tags,
  setupFiles: [join(import.meta.dirname, "packages/server/test/support/environment.ts")],
  testTimeout: 30_000,
  // Builds the worker bundles once per run, and checks the run leaves no temporary files.
  globalSetup: [join(import.meta.dirname, "packages/server/test/support/globalSetup.ts")],
  // Works around a V8 bug in Node 24 (nodejs/node#66366, fixed upstream in V8
  // 9b8ca54d5a but not yet in a 24.x release): Wasm code GC can free an import
  // wrapper twice while another isolate tiers it up. Source-mode database workers
  // each run Node's type stripper (Wasm), and the tests create and terminate them
  // constantly, so a test process would die now and then with SIGSEGV or
  // "Check failed: jit_page". See ARCHITECTURE.md §3.6.
  execArgv: ["--no-wasm-code-gc"]
} as const

export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      { test: { ...unit, name: "shared", root: "packages/shared" } },
      { test: { ...unit, name: "client", root: "packages/client" } },
      {
        test: {
          ...server,
          name: "server",
          include: ["test/**/*.test.ts"],
          exclude: [...SLOW_SERVER_FILES, ...LIVE_SERVER_FILES]
        }
      },
      {
        test: {
          ...server,
          name: "server-slow",
          include: SLOW_SERVER_FILES,
          testTimeout: 600_000,
          // Registered during imports, before a test file can change runtime config.
          // Large synthetic fixtures can take more than 10 s to remove.
          hookTimeout: 60_000
        }
      },
      {
        test: {
          ...server,
          name: "server-live",
          include: LIVE_SERVER_FILES,
          globalSetup: [join(import.meta.dirname, "packages/server/test/live/support/setup.ts")],
          env: { TEST_DB_WORKERS: "source" },
          testTimeout: 900_000,
          hookTimeout: 120_000
        }
      }
    ]
  }
})
