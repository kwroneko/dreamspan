// Every screen at phone and desktop width, light and dark: nothing scrolls sideways.
// With SCREENSHOT_DIR set, each is saved there too.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let connectionPath = ""

test.beforeAll(async () => {
  provider = await startProvider()
  const connection = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-layout-test-key-0042"
    })
  )
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.RefreshModels({ connectionId: connection.id }))
  connectionPath = `/settings/connections/${connection.id}`
})
test.afterAll(async () => {
  await provider.stop()
})

const screens = [
  ["status", "/"],
  ["connections", "/settings/connections"],
  ["new-connection", "/settings/connections/new"],
  ["connection", () => connectionPath],
  ["keys", "/settings/keys"],
  ["network", "/settings/network"],
  ["account", "/settings/account"],
  ["users", "/settings/users"],
  ["library", "/library"],
  ["import", "/import"]
] as const

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height, device] of [
    [390, 844, "phone"],
    [1280, 800, "desktop"]
  ] as const) {
    test(`${device}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
      const page = await context.newPage()
      const shoot = async (name: string) => {
        await noSidewaysScroll(page)
        const dir = process.env.SCREENSHOT_DIR
        if (dir) await page.screenshot({ path: join(dir, `${name}-${device}-${scheme}.png`), fullPage: true })
      }

      await page.goto(`${server().url}/login`)
      await expect(page.getByLabel("Handle")).toBeVisible()
      await shoot("login")

      await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
      for (const [name, path] of screens) {
        await page.goto(`${server().url}${typeof path === "function" ? path() : path}`)
        await expect(
          page
            .getByRole("heading", { level: 1 })
            .or(page.getByRole("heading", { level: 2 }))
            .first()
        ).toBeVisible()
        await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0)
        await shoot(name)
      }
      await page.goto(`${server().url}/settings/keys`)
      await page.getByRole("button", { name: "Replace key" }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await shoot("replace-key-dialog")
      await context.close()
    })
  }
}

test("dialogs work from the keyboard and give focus back", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/users`)
  const trigger = page.getByRole("button", { name: "New user" })
  await trigger.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "New user" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Handle")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})
