// The performance harness (CLIENT-FRAMEWORK §7): `npm run test:perf`. One worker, since
// the scenarios measure frames and the host is shared; budgets in perf/budgets.ts fail it.
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "*.perf.ts",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "../test-results/perf",
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    launchOptions: { args: ["--enable-precise-memory-info"] },
    screenshot: "only-on-failure"
  }
})
