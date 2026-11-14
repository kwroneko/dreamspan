// Synthetic loopback workshop: copying asks by name and still leaves the plugin off.
import { test, expect } from "@playwright/test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { asUser } from "./rpc.ts"
import { startWorkshopProvider } from "./workshopProvider.ts"
import { expectLayout } from "./layoutAudit.ts"

export const pluginCopyApprovalTests = () =>
  test.describe("named copy approvals", () => {
    const server = serverPerFile(withAdmin)
    const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
    let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
    let pluginId = ""
    test.beforeAll(async () => {
      provider = await startWorkshopProvider({
        perTask: true,
        answer: "The editable copy is saved and off.",
        calls: [
          {
            name: "plugin_copy_builtin",
            arguments: () => ({
              registry: "noticeChannels",
              id: "notifications.completion-sound",
              pluginId
            })
          }
        ]
      })
      await admin((api) =>
        Effect.gen(function* () {
          yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic copy approvals",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
        })
      )
    })
    test.afterAll(async () => provider.stop())
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`copy asks by plugin name ${width} ${theme}`, async ({ page }, info) => {
          test.setTimeout(120000)
          pluginId = `asked-copy-${width}-${theme}`
          const chat = await admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.CreateWorkshop({ title: "Named copy approval" })
              yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "plugins.write", mode: "ask" })
              return chat
            })
          )
          await page.setViewportSize({ width, height: 1000 })
          await page.emulateMedia({ colorScheme: theme })
          await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          await page.goto(`${server().url}/chats/${chat.id}`)
          await page.getByLabel("Message", { exact: true }).fill("Make an editable copy of Completion sound.")
          await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
          const approval = page.locator("[data-approval]")
          await expect(approval).toContainText("Make an editable copy of Completion sound?", { timeout: 60000 })
          await expect(approval).toContainText("Off. Turning it on requires a separate review.")
          const step = page.locator('[data-step="tool"]').filter({ has: approval })
          await expect(step.locator("button").first()).toContainText("Completion sound (editable)")
          expect((await admin((api) => api.ListPlugins())).some((p) => p.id === pluginId)).toBe(false)
          await page.reload()
          await expect(approval).toContainText("Make an editable copy of Completion sound?")
          await expectLayout(page, info, `copy-approval-${width}-${theme}`, { scope: "[data-approval]" })
          if (process.env.SCREENSHOT_DIR) {
            await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
            await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `copy-approval-${width}-${theme}.png`) })
          }
          await approval.getByRole("button", { name: "Allow", exact: true }).click()
          await expect(page.getByRole("article").last()).toContainText("The editable copy is saved and off.", {
            timeout: 60000
          })
          const badge = page.getByRole("article").last().locator("[data-steps-badge]")
          if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
          const copied = page.locator('[data-step="tool"]').filter({ hasText: "Copied a built-in part" })
          await expect(copied.locator("button").first()).toContainText("Completion sound (editable)")
          await expect(copied.locator("button").first()).toContainText(/Version [a-f0-9]{8}/)
          expect((await admin((api) => api.GetPlugin({ scope: "user", id: pluginId }))).pin).toBeNull()
          await expectLayout(page, info, `copy-step-${width}-${theme}`)
        })
  })
