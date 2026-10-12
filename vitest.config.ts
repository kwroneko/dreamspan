import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "shared", root: "packages/shared", include: ["test/**/*.test.ts"], environment: "node" }
      },
      {
        test: { name: "client", root: "packages/client", include: ["test/**/*.test.ts"], environment: "node" }
      },
      {
        test: {
          name: "server",
          root: "packages/server",
          include: ["test/**/*.test.ts"],
          environment: "node",
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
        }
      }
    ]
  }
})
