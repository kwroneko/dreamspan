import { expect, test } from "@playwright/test"
import manifest from "../../../package.json" with { type: "json" }
import { serverPerFile } from "./support/server.ts"

const server = serverPerFile()

test("liveness and Server status show the running release version", async ({ page }) => {
  const health = await page.request.get(`${server().url}/healthz`)
  expect(health.status()).toBe(200)
  expect(health.headers()["x-app-version"]).toBe(manifest.version)

  await page.goto(`${server().url}/settings/status`)
  await expect(page).toHaveTitle(/^Server status/)
  await expect(page.getByText(manifest.version, { exact: true })).toBeVisible()
})
