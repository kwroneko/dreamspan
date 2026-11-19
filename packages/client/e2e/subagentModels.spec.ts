// The subagent model chip and Settings → Assistant tools (spec/SUBAGENTS.md SA2, SA3): beside the
// model chip in a pending and a saved workshop; a multiselect whose changes go to the account
// while unlocked and to the chat once locked; its footer opens the settings page, where a model's
// name and the limits are saved. Layout audit on the popover and the page at 1440 and 390, light
// and dark. Synthetic data and a loopback provider only; nothing is generated.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startSubagentProvider } from "./support/subagentProvider.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startSubagentProvider>>
let extra = ""
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async () => {
  provider = await startSubagentProvider()
  extra = await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic subagents",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
      const other = yield* api.AddUserModel({ connectionId: connection.id, key: "lookup-tiny", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return `${connection.id} ${other.id}`
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

// One account's settings: the cases run one after another, each from the defaults.
test.describe.configure({ mode: "serial" })
const reset = () =>
  admin((api) =>
    api.ChangeSubagentSettings({ picks: ["same"], rows: { [extra]: { alias: "lookup-tiny", note: "" } }, limits: null })
  )
const chip = (page: Page) => page.getByRole("button", { name: /^Subagent models: / })

const open = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`the subagent model chip in a workshop and its settings at ${width}, ${scheme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await reset()
      await open(page, width, scheme)

      // A workshop not made yet: the chip shows the account's picks, beside the model chip.
      await page.goto(`${server().url}/new/workshop`)
      await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible({ timeout: 30_000 })
      await expect(chip(page)).toBeVisible()
      await expect(chip(page)).toContainText("Subagents: Same model")

      // A saved workshop.
      const workshop = await admin((api) => api.CreateWorkshop({ title: `Subagent models ${width} ${scheme}` }))
      await page.goto(`${server().url}/chats/${workshop.id}`)
      await expect(page.getByTestId("composer")).toBeVisible()
      await expect(chip(page)).toContainText("Subagents: Same model")
      await chip(page).click()
      const picker = page.locator("[data-subagent-model-picker]")
      await expect(picker).toBeVisible()
      await expect(picker.getByRole("checkbox", { name: "Same as this chat's model" })).toBeChecked()
      const add = picker.locator(`[data-subagent-add="${extra}"]`)
      await expect(add).toContainText("lookup-tiny")
      await expectLayout(page, info, `subagent-models-picker-${width}-${scheme}`, {
        scope: "[data-subagent-model-picker]"
      })

      // Unlocked: adding one changes the account's picks.
      await add.click()
      await expect(chip(page)).toContainText("Subagents: Same model +1")
      await expect
        .poll(() => admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.models.picks)))
        .toEqual(["same", extra])
      const added = picker.getByRole("checkbox", { name: /lookup-tiny/ })
      await expect(added).toBeChecked()
      await expect(added).toHaveAccessibleDescription(/Synthetic subagents/)

      // Locked: this chat keeps its own picks; the account's stay as they were.
      await picker.getByRole("switch", { name: "Lock for this chat" }).click()
      await expect(page.getByRole("img", { name: "Subagent models locked for this chat" })).toBeVisible()
      await added.click()
      await expect(chip(page)).toContainText(/Subagents: Same model$/)
      await expect
        .poll(() =>
          admin((api) =>
            Effect.gen(function* () {
              const chat = yield* api.GetChat({ chatId: workshop.id })
              const cast = yield* api.GetCast({ chatId: workshop.id, slotId: chat.activeLeafSlotId })
              return cast.subagentModels ?? null
            })
          )
        )
        .toEqual(["same"])
      expect(await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.models.picks))).toEqual([
        "same",
        extra
      ])

      // The footer opens Settings → Assistant tools.
      await page.getByRole("button", { name: "Subagent settings…" }).click()
      await expect(page).toHaveURL(/\/settings\/assistant-tools$/)
      const models = page.locator("[data-subagent-models]")
      await expect(models).toBeVisible()
      const row = models.locator(`[data-subagent-model-row="${extra}"]`)
      await expect(row).toContainText("lookup-tiny")
      await expect(row).toContainText("Picked")
      await expect(
        models.locator('[data-subagent-model-row="same"]').getByLabel("Name", { exact: true })
      ).toBeDisabled()
      await row.getByLabel("Name", { exact: true }).fill("tiny")
      await row.getByLabel("What it's for", { exact: true }).fill("Quick lookups.")
      await models.getByRole("button", { name: "Save" }).click()
      await expect(models.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
      expect(await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.models.rows[extra]))).toEqual({
        alias: "tiny",
        note: "Quick lookups."
      })

      const limits = page.locator("[data-subagent-limits]")
      await limits.getByLabel("Running at once in your account", { exact: true }).fill("3")
      await limits.getByLabel("Tokens", { exact: true }).fill("lots")
      await limits.getByRole("button", { name: "Save" }).click()
      await expect(limits.getByRole("alert")).toContainText("Tokens: enter a number")
      await limits.getByLabel("Tokens", { exact: true }).fill("")
      await limits.getByRole("button", { name: "Save" }).click()
      await expect(limits.getByRole("status").filter({ hasText: "Saved." })).toBeVisible()
      expect(await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.limits))).toEqual({
        accountConcurrent: 3
      })
      await expectLayout(page, info, `assistant-tools-${width}-${scheme}`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

      await limits.getByRole("button", { name: "Use the defaults" }).click()
      await expect.poll(() => admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.limits))).toEqual({})
    })
