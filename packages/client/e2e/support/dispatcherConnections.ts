// Shared with layoutAudit: the existing connection Advanced form, both sizes and themes.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export function dispatcherConnectionTests() {
  test.describe("dispatcher connection settings", () => {
    const server = serverPerFile(withAdmin)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        test(`untested opt-in and cache cost at ${width} ${theme}`, async ({ page }, info) => {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
          await page.emulateMedia({ colorScheme: theme })
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const connection = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
            api.CreateConnection({
              kind: "openai-chat",
              settings: {
                name: `Dispatcher ${width} ${theme}`,
                baseUrl: "http://127.0.0.1:1/v1",
                compat: {},
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null
              }
            })
          )
          await page.goto(`${server().url}/settings/connections/${connection.id}`)
          await page.getByText("Advanced", { exact: true }).click()
          const select = page.getByRole("combobox", { name: "Tool loading" })
          await expect(select).toContainText("Automatic")
          await select.click()
          await expectLayout(page, info, `dispatcher-connection-options-${width}-${theme}`)
          await page
            .getByRole("option")
            .filter({ has: page.getByText("Load tools as needed", { exact: true }) })
            .click()
          await expect(
            page.getByText(/Changing the tool list makes the next request read the chat again once/)
          ).toBeVisible()
          await expectLayout(page, info, `dispatcher-connection-${width}-${theme}`)
          await page.getByRole("button", { name: "Save", exact: true }).click()
          await expect
            .poll(() =>
              asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
                api
                  .ListConnections()
                  .pipe(Effect.map((list) => list.find((c) => c.id === connection.id)?.providerSettings.toolLoading))
              )
            )
            .toBe("dispatcher")
          await page.reload()
          await page.getByText("Advanced", { exact: true }).click()
          await expect(select).toContainText("Load tools as needed")
          await expectLayout(page, info, `dispatcher-connection-saved-${width}-${theme}`)
        })
      }
  })
}
