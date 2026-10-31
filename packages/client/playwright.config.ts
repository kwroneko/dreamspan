// Browser tests (spec/WORKFLOW.md §4): the built client against the real server, with
// real database workers. Each test file starts its own servers on random ports with fresh
// data directories (e2e/support/server.ts). `npm run test:browser` selects Chromium;
// `npm run test:browser:all` runs every project.
import { availableParallelism, loadavg } from "node:os"
import { defineConfig, devices } from "@playwright/test"

/**
 * Each worker runs a browser and a server with its database workers, about three cores when
 * busy. So: a third of the host's free cores, at least 3, at most 12. PLAYWRIGHT_WORKERS
 * overrides it.
 */
const free = availableParallelism() - loadavg()[0]
const workers = Number(process.env.PLAYWRIGHT_WORKERS) || Math.max(3, Math.min(12, Math.floor(free / 3)))

export default defineConfig({
  testDir: "e2e",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ]
})
