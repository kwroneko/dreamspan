// Settings → Assistant tools → Subagent types (spec/SUBAGENTS.md SA7, §10): the built-in type is
// listed; New type makes one of the user's own with a tool from the checklist; Edit changes the
// built-in one (marked Edited) and Restore drops the change. The editor is in the URL, so a reload
// keeps it open. Layout audit on the list and the editor at 1440 and 390, light and dark. Synthetic
// data only; nothing is generated.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

// One account's types: the cases run one after another, each from none of the user's own.
test.describe.configure({ mode: "serial" })
const reset = () =>
  admin((api) =>
    Effect.gen(function* () {
      const { types } = yield* api.GetSubagentSettings({})
      for (const type of types) yield* api.ChangeSubagentType({ id: type.id, edit: null })
    })
  )

const open = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`subagent types: new, edit and restore at ${width}, ${scheme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await reset()
      await open(page, width, scheme)
      await page.goto(`${server().url}/settings/assistant-tools`)
      const list = page.locator("[data-subagent-types]")
      await expect(list).toBeVisible({ timeout: 30_000 })
      const research = list.locator('[data-subagent-type="research"]')
      await expect(research).toContainText("Look things up")
      await expect(research).toContainText("Built in")
      await expectLayout(page, info, `subagent-types-${width}-${scheme}`)

      // New type: its id follows its name; one tool from the checklist.
      await page.getByRole("button", { name: "New type" }).click()
      await expect(page).toHaveURL(/type=new/)
      const editor = page.locator('[data-subagent-type-editor="new"]')
      await editor.getByLabel("Name", { exact: true }).fill("Check names")
      await expect(editor.getByLabel("Id", { exact: true })).toHaveValue("check-names")
      await editor.getByLabel("What it's for", { exact: true }).fill("Checks that card names are spelled the same.")
      await editor.getByLabel("Instructions", { exact: true }).fill("You check names. Report each mismatch.")
      const tools = editor.locator("[data-subagent-type-tools]")
      await tools.getByRole("checkbox").first().click()
      await expect(editor).toContainText("1 picked")
      await expectLayout(page, info, `subagent-type-editor-${width}-${scheme}`, {
        scope: '[data-subagent-type-editor="new"]'
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      // The editor is the URL's: a reload keeps it and what it shows.
      await page.reload()
      await expect(page.locator('[data-subagent-type-editor="new"]')).toBeVisible()
      await editor.getByLabel("Name", { exact: true }).fill("Check names")
      await editor.getByLabel("Instructions", { exact: true }).fill("You check names. Report each mismatch.")
      await editor.locator("[data-subagent-type-tools]").getByRole("checkbox").first().click()
      await editor.getByRole("button", { name: "Save" }).click()
      await expect(page).not.toHaveURL(/type=/)
      const mine = list.locator('[data-subagent-type="check-names"]')
      await expect(mine).toContainText("Yours")
      await expect(mine).toContainText("1 tool")
      const saved = await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.types))
      expect(saved.map((t) => [t.id, t.label, t.tools?.length])).toEqual([["check-names", "Check names", 1]])

      // Edit the built-in type: only the change is kept, and the row says Edited.
      await research.getByRole("button", { name: "Edit" }).click()
      await expect(page).toHaveURL(/type=research/)
      const edit = page.locator('[data-subagent-type-editor="research"]')
      await expect(edit.getByLabel("Id", { exact: true })).toBeDisabled()
      await edit.getByLabel("What it's for", { exact: true }).fill("Looks things up, briefly.")
      // Its effort: every level, since it runs on whichever model is picked; used where that model has it.
      const effort = edit.getByRole("combobox", { name: "Reasoning effort" })
      await expect(effort).toContainText("Its model's")
      await effort.click()
      await page.getByRole("option", { name: "Medium", exact: true }).click()
      await expect(effort).toContainText("Medium")
      await expectLayout(page, info, `subagent-type-effort-${width}-${scheme}`, {
        scope: '[data-subagent-type-editor="research"]'
      })
      await edit.getByRole("button", { name: "Save" }).click()
      await expect(research).toContainText("Edited")
      await expect(research).toContainText("Looks things up, briefly.")
      await expect(research).toContainText("Effort: Medium")
      expect(await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.types[1]))).toEqual({
        id: "research",
        description: "Looks things up, briefly.",
        effort: "medium"
      })

      // Restore drops the change; Delete removes the user's own type.
      await research.getByRole("button", { name: "Edit" }).click()
      await page.locator('[data-subagent-type-editor="research"]').getByRole("button", { name: "Restore" }).click()
      await expect(research).not.toContainText("Edited")
      await expect(research).not.toContainText("Effort:")
      await mine.getByRole("button", { name: "Edit" }).click()
      await page
        .locator('[data-subagent-type-editor="check-names"]')
        .getByRole("button", { name: "Delete type" })
        .click()
      await expect(mine).toHaveCount(0)
      expect(await admin((api) => Effect.map(api.GetSubagentSettings({}), (s) => s.types))).toEqual([])
    })
