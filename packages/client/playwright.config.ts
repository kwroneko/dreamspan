// Browser tests (spec/WORKFLOW.md §4): the built client against the real server, with
// real database workers. Each test file starts its own servers on random ports with fresh
// data directories (e2e/support/server.ts). `npm run test:browser` selects Chromium;
// `npm run test:browser:all` runs every project.
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Each worker runs servers and a browser; the host is shared.
  workers: 3,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ]
})
