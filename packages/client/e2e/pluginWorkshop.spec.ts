import { unquoteToolData } from "../../server/test/support/toolData.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { pluginDocumentation } from "../../plugin-api/src/docs.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expectTextBox } from "./support/textbox.ts"

test.describe("workshop plugin consent and dice", () => {
  const server = serverPerFile(withAdmin)
  const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  let pluginId = ""
  const code = pluginDocumentation.find((d) => d.topic === "composerControls")!.example
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      perTask: true,
      answer: (body) =>
        JSON.stringify(body.messages.at(-1)).includes("declined") ? "It stays off." : "The dice button is on.",
      calls: [
        { name: "plugin_api", arguments: { topic: "composerControls" } },
        { name: "plugin_create", arguments: () => ({ id: pluginId, name: "Dice roller", runs: "browser" }) },
        {
          name: "plugin_write",
          arguments: () => ({
            plugin: pluginId,
            path: "src/client.tsx",
            content: code.replace("draft.append", "draft.insertText")
          })
        },
        { name: "plugin_check", arguments: () => ({ plugin: pluginId }) },
        { name: "plugin_api", arguments: { topic: "composerControls" } },
        {
          name: "plugin_edit",
          arguments: () => ({
            plugin: pluginId,
            path: "src/client.tsx",
            old_str: "draft.insertText",
            new_str: "draft.append"
          })
        },
        { name: "plugin_check", arguments: () => ({ plugin: pluginId }) },
        { name: "plugin_commit", arguments: () => ({ plugin: pluginId, message: "Add a d20 button" }) },
        {
          name: "plugin_enable",
          arguments: (body) => ({
            plugin: pluginId,
            commit:
              unquoteToolData(
                body.messages
                  .filter((m) => m.role === "tool")
                  .at(-1)
                  ?.content?.toString() ?? ""
              ).match(/"commit":"([a-f0-9]{40})"/)?.[1] ?? "0".repeat(40)
          })
        }
      ]
    })
    await admin((api) =>
      Effect.gen(function* () {
        yield* api.SetDisplayPrefs({ prefs: { steps: "expanded" } })
        const conn = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Scripted dice",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({
          connectionId: conn.id,
          key: "workshop-small",
          overrides: { context: 200000 }
        })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: conn.id, model: model.id }, preset: null }
        })
      })
    )
  })
  test.afterAll(async () => provider.stop())
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`dice consent, refusal and Undo ${width} ${theme}`, async ({ page, context }, info) => {
        test.setTimeout(240000)
        pluginId = `dice-${width}-${theme}`
        const chat = await admin((api) => api.CreateWorkshop({ title: `Dice ${width} ${theme}` }))
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((v) => localStorage.setItem("dreamspan.theme", v), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/chats/${chat.id}`)
        await page.getByLabel("Message", { exact: true }).fill("Add a dice-roll button to the composer.")
        await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
        const approval = page.locator("[data-approval]")
        await expect(approval).toBeVisible({ timeout: 120000 })
        await expect(approval).toContainText("Turn on Dice roller?")
        const enablingStep = page.locator('[data-step="tool"]').filter({ has: approval })
        await expect(enablingStep.locator("button").first()).toContainText("Dice roller")
        await expect(enablingStep.locator("button").first()).toContainText(/Version [a-f0-9]{8}/)
        await expect(approval).toContainText("Runs only in your browser. It can do anything you can do in the app.")
        await expect(approval).toContainText("Adds controls beside your message.")
        await expect(approval.getByRole("button", { name: "Allow in this workshop" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "🎲", exact: true })).toHaveCount(0)
        await expect(approval.getByRole("button", { name: "Turn on", exact: true })).toHaveAccessibleDescription(
          "Checks and runs this exact version from now on."
        )
        await expectLayout(page, info, `plugin-consent-${width}-${theme}`, { scope: "[data-approval]" })
        if (process.env.SCREENSHOT_DIR) {
          mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
          await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `plugin-consent-${width}-${theme}.png`) })
        }
        await page.reload()
        await expect(approval).toBeVisible()
        await approval.getByRole("button", { name: "Turn on", exact: true }).click()
        await expect(page.getByRole("article").last()).toContainText("The dice button is on.", { timeout: 60000 })
        const die = page.getByRole("button", { name: "🎲", exact: true })
        await expect(die).toBeVisible({ timeout: 30000 })
        await die.click()
        await expectTextBox(page.getByLabel("Message", { exact: true }), /🎲 (?:[1-9]|1[0-9]|20)$/)
        await expectLayout(page, info, `plugin-dice-${width}-${theme}`)
        // Drop server notices to reproduce the cross-tab subscription gap. The local
        // management broadcast still offers Reload, retaining already evaluated code.
        const other = await context.newPage()
        await other.routeWebSocket("**/rpc", (socket) => {
          const upstream = socket.connectToServer()
          socket.onMessage((message) => upstream.send(message))
          upstream.onMessage((message) => {
            if (!message.toString().includes('"PluginsChanged"')) socket.send(message)
          })
        })
        await other.goto(`${server().url}/chats/${chat.id}`)
        await expect(other.getByRole("button", { name: "🎲", exact: true })).toBeVisible()
        const badge = page.getByRole("article").last().locator("[data-steps-badge]")
        if ((await badge.getAttribute("aria-pressed")) !== "true") await badge.click()
        const enabled = page.locator('[data-effect-kind="plugin.enable"]')
        await expect(enabled).toBeVisible()
        await enabled.getByRole("button", { name: "Undo", exact: true }).click()
        await expect(die).toHaveCount(0)
        const reloadNotice = other.getByRole("status", { name: "Plugins", exact: true })
        await expect(reloadNotice).toContainText("Plugins changed. Reload to apply.")
        await reloadNotice.getByRole("button", { name: "Reload", exact: true }).click()
        await expect(other.getByRole("button", { name: "🎲", exact: true })).toHaveCount(0)
        await other.close()
        await expectTextBox(page.getByLabel("Message", { exact: true }), /🎲 /)
        // Next task declines: no extra code runs. The existing checked version can be requested again.
        const details = await admin((api) => api.GetPlugin({ scope: "user", id: pluginId }))
        expect(details.pin?.suspended).toBeTruthy()
        pluginId += "-declined"
        await page
          .getByLabel("Message", { exact: true })
          .fill("Write another dice plugin, then ask me before turning it on.")
        await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
        await expect(approval).toBeVisible({ timeout: 120000 })
        await approval.getByRole("button", { name: "Not now", exact: true }).click()
        await expect(page.getByRole("article").last()).toContainText("It stays off.", { timeout: 30000 })
        await expect(die).toHaveCount(0)
        expect((await admin((api) => api.GetPlugin({ scope: "user", id: pluginId }))).pin).toBeNull()
      })
})
