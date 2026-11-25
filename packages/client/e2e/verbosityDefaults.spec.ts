import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`verbosity uses effective compat at ${width} ${theme}`, async ({ page }, info) => {
      const key = `museum-gpt-${width}-${theme}`
      const connections = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const make = (supported: boolean) =>
            api.CreateConnection({
              kind: "openai-chat",
              settings: {
                name: `Synthetic ${key} ${supported}`,
                baseUrl: provider.baseUrl,
                compat: { supportsVerbosity: supported },
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null
              }
            })
          const yes = yield* make(true)
          const no = yield* make(false)
          yield* api.AddUserModel({ connectionId: yes.id, key, overrides: {} })
          yield* api.AddUserModel({
            connectionId: yes.id,
            key: `${key}-off`,
            overrides: { compat: { supportsVerbosity: false } }
          })
          yield* api.AddUserModel({ connectionId: no.id, key, overrides: {} })
          yield* api.AddUserModel({
            connectionId: no.id,
            key: `${key}-on`,
            overrides: { compat: { supportsVerbosity: true } }
          })
          return { yes: yes.id, no: no.id }
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((theme) => localStorage.setItem("dreamspan.theme", theme), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const open = async (id: string, model: string) => {
        await page.goto(`${server().url}/settings/connections/${id}`)
        await page.getByRole("button", { name: `Edit ${model}`, exact: true }).click()
        return page.getByRole("dialog", { name: `Edit ${model}`, exact: true })
      }
      let dialog = await open(connections.yes, key)
      const verbosity = dialog.getByRole("group", { name: "Verbosity", exact: true })
      await expect(verbosity).toBeVisible()
      await expectLayout(page, info, `verbosity-${width}-${theme}`, { scope: "[role=dialog]" })
      await verbosity.getByRole("button", { name: "High", exact: true }).click()
      await dialog.getByRole("button", { name: "Save model settings", exact: true }).click()
      await expect(dialog).toBeHidden()
      await page.reload()
      dialog = await open(connections.yes, key)
      await expect(dialog.getByRole("button", { name: "High", exact: true })).toHaveAttribute("aria-pressed", "true")
      await page.keyboard.press("Escape")
      dialog = await open(connections.yes, `${key}-off`)
      await expect(dialog.getByRole("group", { name: "Verbosity", exact: true })).toHaveCount(0)
      await page.keyboard.press("Escape")
      dialog = await open(connections.no, key)
      await expect(dialog.getByRole("group", { name: "Verbosity", exact: true })).toHaveCount(0)
      await page.keyboard.press("Escape")
      dialog = await open(connections.no, `${key}-on`)
      await expect(dialog.getByRole("group", { name: "Verbosity", exact: true })).toBeVisible()
    })
