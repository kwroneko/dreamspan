// Finding and ordering a message's versions in the version picker (VersionPicker.tsx; audit
// item 007): fifty long versions, a text filter that marks the words and keeps the hidden
// section and the starred filter, the sort menu, and Compare still working, at 1440 and 390
// in light and dark, with the layout audit of the open picker.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const filler = "The tide turns and the waves keep coming over the old stones. ".repeat(60)
let chatId = ""

test.beforeAll(async () => {
  chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Swipes" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: `Version 1. ${filler}`,
        reply: false
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      const slotId = sent.entry.slotId
      let rowVersion = sent.entry.rowVersion
      for (let n = 2; n <= 50; n++) {
        // Version 12 is the shortest; 30 and 41 mention a zeppelin.
        const content =
          n === 12
            ? "Version 12, short."
            : `Version ${n}. ${filler}${n === 30 || n === 41 ? " Then a zeppelin drifts over the harbour." : ""}`
        const entry = yield* api.WriteVersion({ slotId, content, expectedRowVersion: rowVersion })
        rowVersion = entry.rowVersion
      }
      const list = yield* api.ListVersions({ slotId })
      yield* api.SetVersionFlags({ versionId: list[29]!.id, hidden: true })
      yield* api.SetVersionFlags({ versionId: list[40]!.id, starred: true })
      yield* api.SetVersionFlags({ versionId: list[4]!.id, starred: true })
      return chat.id
    })
  )
})

const rows = (page: Page, name: "Versions" | "Hidden versions") =>
  page.getByRole("list", { name, exact: true }).getByRole("listitem")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the picker finds and sorts fifty versions at ${width} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      const message = page.getByRole("article").last()
      await message
        .getByRole("group", { name: "Versions", exact: true })
        .getByRole("button", { name: /choose a version/ })
        .click()
      const picker = page.getByRole("dialog", { name: "Versions of message #1", exact: true })
      await expect(rows(page, "Versions")).toHaveCount(49)

      // The filter: one shown, one hidden, the word marked; the starred filter narrows it.
      const field = picker.getByRole("searchbox", { name: "Find in versions", exact: true })
      await field.fill("Zeppelin")
      await expect(rows(page, "Versions")).toHaveCount(1)
      await expect(rows(page, "Versions").first()).toContainText("#41")
      await expect(rows(page, "Versions").first().locator("mark")).toHaveText("zeppelin")
      await expect(picker.getByText("Hidden 1: left out of the arrows")).toBeVisible()
      await picker.getByRole("button", { name: /^Starred 2/ }).click()
      await expect(rows(page, "Versions")).toHaveCount(1)
      await expect(picker.getByText("Hidden 1: left out of the arrows")).toHaveCount(0)
      await field.fill("nothing like this")
      await expect(picker.getByText("No starred version has “nothing like this”.")).toBeVisible()
      await picker.getByRole("button", { name: /^All 50/ }).click()
      await expect(picker.getByText("No version has “nothing like this”.")).toBeVisible()
      await field.fill("")
      await expect(rows(page, "Versions")).toHaveCount(49)

      // The sort: explained on hover; shortest first puts version 12 at the top.
      const sort = picker.getByRole("button", { name: "Sort versions: Order written", exact: true })
      await sort.hover()
      await expect(page.getByText("Chooses how versions are ordered.").filter({ visible: true })).toBeVisible()
      await sort.click()
      await page.getByRole("menuitemcheckbox", { name: "Shortest first" }).click()
      await expect(picker).toBeVisible()
      await expect(rows(page, "Versions").first()).toContainText("#12")
      await picker.getByRole("button", { name: "Sort versions: Shortest first", exact: true }).click()
      await page.getByRole("menuitemcheckbox", { name: "Starred first" }).click()
      await expect(rows(page, "Versions").nth(0)).toContainText("#5")
      await expect(rows(page, "Versions").nth(1)).toContainText("#41")
      await picker.getByRole("button", { name: "Sort versions: Starred first", exact: true }).click()
      await page.getByRole("menuitemcheckbox", { name: "Newest first" }).click()
      await expect(rows(page, "Versions").first()).toContainText("#50")
      await field.fill("version")
      await expectLayout(page, info, `version-search-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.screenshot({ path: info.outputPath(`picker-${width}-${theme}.png`) })

      // Compare still works on the sorted, filtered list.
      await picker.getByRole("button", { name: "Compare", exact: true }).click()
      await picker.getByRole("checkbox", { name: "Compare version 50", exact: true }).click()
      await picker.getByRole("checkbox", { name: "Compare version 49", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "Version 49 and version 50", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")

      // Reopened, the picker keeps the filter and sort; picking a version shows it.
      await message
        .getByRole("group", { name: "Versions", exact: true })
        .getByRole("button", { name: /choose a version/ })
        .click()
      await expect(picker.getByRole("searchbox", { name: "Find in versions" })).toHaveValue("version")
      await expect(picker.getByRole("button", { name: "Sort versions: Newest first", exact: true })).toBeVisible()
      await picker.getByRole("button", { name: /^Version 12,/ }).click()
      await expect(picker).toHaveCount(0)
      await expect(message).toContainText("Version 12, short.")
    })
