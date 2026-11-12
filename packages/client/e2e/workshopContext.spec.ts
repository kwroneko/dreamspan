// Workshop context in the browser (spec/WORKSHOP-CONTEXT.md §1.3, §4.3, §4.4): the model picker
// shows each model's window and says when it is assumed; "Convert to workshop" makes a new preset
// from a story preset; a persona's menu sets the workshop persona without changing the story
// default. Synthetic data only; the connection points at a scripted loopback provider.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { modelChip } from "./support/strip.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR
let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
let seeded: { chatId: string; presetId: string }

test.beforeAll(async () => {
  provider = await startWorkshopProvider()
  seeded = await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const wide = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic-wide",
        overrides: { context: 200_000, maxOutput: 64_000 }
      })
      yield* api.AddUserModel({ connectionId: connection.id, key: "synthetic-unreported", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: wide.id }, preset: null }
      })
      const chat = yield* api.CreateChat({ title: "Harbor story" })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Synthetic story." })
      const preset = yield* api.CreatePreset({ label: "Harbor preset" })
      return { chatId: chat.id as string, presetId: preset.id as string }
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})
test.setTimeout(120_000)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`window, conversion and workshop persona at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `workctx-${name}-${width}-${theme}.png`) })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }

      // The picker: each row's window, the assumed one in the warning tone with its explanation.
      await page.goto(`${server().url}/chats/${seeded.chatId}`)
      await modelChip(page).click()
      const list = page.getByRole("radiogroup", { name: "Model", exact: true })
      await expect(list).toBeVisible()
      const wide = list.locator("[data-picker-row]").filter({ hasText: "synthetic-wide" })
      const unreported = list.locator("[data-picker-row]").filter({ hasText: "synthetic-unreported" })
      await expect(wide).toContainText("200k context ·")
      await expect(unreported).toContainText("128k context (assumed) ·")
      await expect(unreported.locator(".text-warning")).toHaveText(/128k context \(assumed\)/)
      await unreported.getByRole("radio").hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
        "Context window: 128,000 tokens, assumed: nothing reports this model's window. Set it in Settings → Connections."
      )
      await shot("picker")
      await expectLayout(page, info, `workctx-picker-${width}-${theme}`, { hovered: true })
      await page.keyboard.press("Escape")

      // Convert a story preset: the dialog, its choices, the new preset opened.
      await page.goto(`${server().url}/library/${seeded.presetId}`)
      const convert = page.getByRole("button", { name: "Convert to workshop", exact: true })
      await expect(convert).toBeVisible()
      await expect(convert).toHaveAccessibleDescription(
        "Makes a new workshop preset from this one's saved version. You choose which story pieces to keep; this preset doesn't change."
      )
      await shot("preset-editor")
      await expectLayout(page, info, `workctx-preset-editor-${width}-${theme}`)
      await convert.click()
      const dialog = page.getByRole("dialog", { name: "Convert to a workshop preset" })
      await expect(dialog).toBeVisible()
      const name = dialog.getByLabel("Name", { exact: true })
      await expect(name).toHaveValue("Harbor preset (workshop)")
      const label = `Harbor workshop ${width} ${theme}`
      await name.fill(label)
      await dialog.getByLabel("Workspace instructions").fill("Ask before renaming cards.")
      const pieces = dialog.getByRole("list", { name: "Pieces to keep or drop" })
      if (await pieces.count()) {
        const first = pieces.getByRole("listitem").first()
        await first.getByRole("button", { name: "Drop", exact: true }).click()
        await first.getByRole("button", { name: "Keep", exact: true }).click()
      }
      await shot("convert-dialog")
      await expectLayout(page, info, `workctx-convert-dialog-${width}-${theme}`)
      await dialog.getByRole("button", { name: "Make preset", exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(page).not.toHaveURL(new RegExp(`/library/${seeded.presetId}$`))
      await expect(page.getByText(label).first()).toBeVisible()
      const made = await admin((api) => api.ListLibrary({ kind: "preset" }))
      expect(made.some((ref) => ref.label === label)).toBe(true)

      // The workshop persona from a persona's menu; the story default stays as it was.
      const persona = await admin((api) =>
        Effect.gen(function* () {
          const card = yield* api.CreateCard({
            label: `Pilot ${width} ${theme}`,
            name: `Pilot ${width} ${theme}`,
            persona: true
          })
          yield* api.ChangeGenerationDefaults({ change: { persona: null } })
          return card
        })
      )
      await page.goto(`${server().url}/library?show=personas`)
      await page.getByRole("button", { name: `More actions for ${persona.label}`, exact: true }).click()
      const set = page.getByRole("menuitem", { name: "Set as workshop persona", exact: true })
      await set.focus()
      await expect(set).toHaveAccessibleDescription(
        "New workshops start with this persona. Your stories' default persona doesn't change."
      )
      await shot("persona-menu")
      await expectLayout(page, info, `workctx-persona-menu-${width}-${theme}`, { hovered: true })
      await set.click()
      await expect.poll(async () => (await admin((api) => api.GetWorkshopDefaults({}))).persona).toBe(persona.entityId)
      expect((await admin((api) => api.GetGenerationDefaults())).persona ?? null).toBeNull()
      await page.getByRole("button", { name: `More actions for ${persona.label}`, exact: true }).click()
      await expect(page.getByRole("menuitem", { name: "Clear workshop persona", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
    })
