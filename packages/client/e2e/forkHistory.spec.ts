// A fork's History is a git branch's log (owner, DESIGN §4 [D] 2026-11-06), in a real browser
// against the real server: the fork's own revisions, "Forked here from <original>", then the
// original's revisions up to the fork, each saying whose it is; Restore of an inherited one
// makes the fork's new revision and leaves the original as it is. Presets and cards; every
// entry here is made up.
import { mkdirSync } from "node:fs"
import { expect, type Locator, type Page, test, type TestInfo } from "@playwright/test"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { saveField, seedPresetFork } from "./support/forkMerge.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.FORK_HISTORY_ARTIFACTS

/** A screenshot (when asked for) and, under LAYOUT_AUDIT, the audit of that surface. */
const capture = async (page: Page, info: TestInfo, surface: Locator, name: string) => {
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: `${shots}/${name}.png` })
  }
  if (process.env.LAYOUT_AUDIT) {
    await surface.evaluate((el) => el.setAttribute("data-forkhistory-audit", ""))
    await expectLayout(page, info, name, { scope: "[data-forkhistory-audit]" })
    await surface.evaluate((el) => el.removeAttribute("data-forkhistory-audit"))
  }
}

const openHistory = async (page: Page, refId: RefId) => {
  await page.goto(`${server().url}/library/${refId}`)
  await page.getByRole("button", { name: "History", exact: true }).first().click()
  const history = page.getByRole("dialog", { name: "History", exact: true })
  return { history, rows: history.getByRole("list", { name: "Revisions" }).getByRole("listitem") }
}

const mainPrompt = (doc: unknown) =>
  (doc as { prompts: Array<{ identifier: string; content: string }> }).prompts.find((p) => p.identifier === "main")!
    .content

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a preset fork's History runs on through its original's ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const { fork, parent } = await seedPresetFork(server(), ` ${width} ${theme}`)
      const { history, rows } = await openHistory(page, fork.id)

      // The fork's two revisions, then the parent's two from before the fork; not the two since.
      await expect(rows).toHaveCount(4)
      await expect(rows.nth(0)).toContainText("Revision 4")
      await expect(rows.nth(0)).toContainText("latest")
      await expect(rows.nth(1)).toContainText("Revision 3")
      const marker = rows.nth(1).getByText(/^Forked here from/)
      await expect(marker).toHaveText(`Forked here from ${parent.label}`)
      await expect(marker.getByRole("link", { name: parent.label })).toHaveAttribute("href", `/library/${parent.id}`)
      for (const [index, number] of [
        [2, 2],
        [3, 1]
      ] as const) {
        await expect(rows.nth(index)).toContainText(`Revision ${number}`)
        await expect(rows.nth(index)).toContainText(`From ${parent.label}`)
        // Its message is the original's to set.
        await expect(rows.nth(index).getByRole("button", { name: `Add message to Revision ${number}` })).toHaveCount(0)
      }
      await expect(rows.nth(0).getByRole("button", { name: "Add message to Revision 4" })).toHaveCount(1)
      await expect(rows.nth(0)).not.toContainText("From ")

      // The fork's first revision compares with the revision it was forked from.
      await rows
        .nth(1)
        .getByRole("button", { name: /^Revision 3 .*: Compare$/ })
        .click()
      await expect(rows.nth(1)).toContainText("No fields differ.")
      await capture(page, info, history, `${width}-${theme}-fork-history`)
      await rows
        .nth(1)
        .getByRole("button", { name: /^Revision 3 .*: Compare$/ })
        .click()

      // Restoring the parent's revision makes the fork's fifth; the parent is as it was.
      const restore = rows.nth(2).getByRole("button", { name: "Restore to revision 2", exact: true })
      await expect(restore).toHaveAccessibleDescription(
        `Restores the content of revision 2 here, as a new revision; ${parent.label} doesn't change`
      )
      await restore.click()
      await expect(rows).toHaveCount(5)
      await expect(rows.nth(0)).toContainText("Revision 5")
      await expect(rows.nth(0)).toContainText("latest")
      const [mine, theirs] = await admin((api) =>
        Effect.all([api.OpenEditor({ refId: fork.id }), api.OpenEditor({ refId: parent.id })])
      )
      expect(mainPrompt(mine.doc)).toBe("Write {{char}}'s next reply.")
      expect(mainPrompt(theirs.doc)).toBe("Write {{char}}'s next reply in the harbour.")

      // The link opens the original, closing History.
      await history
        .getByText(/^Forked here from/)
        .getByRole("link", { name: parent.label })
        .click()
      await expect(history).toHaveCount(0)
      await expect(page).toHaveURL(new RegExp(`/library/${parent.id}$`))
    })

test("a card fork's History runs on through its parent's, and restoring keeps the fork's names", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { parent, fork } = await admin((api) =>
    Effect.gen(function* () {
      const parent = yield* api.CreateCard({ label: "Gull", name: "Gull" })
      yield* saveField(api, parent.id, ["description"], "A gull on the pier.")
      const fork = yield* api.ForkCard({
        refId: parent.id,
        name: "Gull",
        nickname: "Night gull",
        characterVersion: "night"
      })
      yield* saveField(api, fork.id, ["description"], "A gull at night.")
      return { parent, fork }
    })
  )
  const { rows } = await openHistory(page, fork.id)
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(1).getByText(/^Forked here from/)).toHaveText("Forked here from Gull")
  await expect(rows.nth(2)).toContainText("From Gull")
  await expect(rows.nth(3)).toContainText("From Gull")

  // The parent's first revision has the parent's names; restored here, the fork keeps its own.
  await rows.nth(3).getByRole("button", { name: "Restore to revision 1", exact: true }).click()
  await expect(rows).toHaveCount(5)
  const [mine, theirs] = await admin((api) =>
    Effect.all([api.OpenEditor({ refId: fork.id }), api.OpenEditor({ refId: parent.id })])
  )
  expect([mine.doc.description, mine.doc.nickname, mine.doc.character_version, mine.ref.subtitle]).toEqual([
    "",
    "Night gull",
    "night",
    "night"
  ])
  expect(theirs.doc.description).toBe("A gull on the pier.")
})
