// Realistic synthetic ST import only. Walkthrough forks are made through the UI.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 240_000 })
  await page.close()
})
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`library and editor forks ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const parent = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const cards = yield* api.ListLibrary({ kind: "card" })
          return cards.find((c) => c.label === "Aria Vance")!
        })
      )
      const shot = async (step: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        if (process.env.CF5_SCREENSHOTS) {
          mkdirSync(process.env.CF5_SCREENSHOTS, { recursive: true })
          await page.screenshot({
            path: `${process.env.CF5_SCREENSHOTS}/${step}-${width}-${theme}.png`,
            animations: "disabled"
          })
        }
      }
      await page.goto(`${server().url}/cards/${parent.entityId}`)
      await expect(page.getByRole("list", { name: "Forks tree" })).toContainText(parent.label)
      const usage = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetShellLibrary())
      const used = usage.cards.find((c) => c.card.entityId === parent.entityId)!.card.chats
      await expect(
        page
          .getByRole("list", { name: "Forks tree" })
          .getByRole("listitem")
          .filter({
            has: page.getByText("this card", { exact: true })
          })
      ).toContainText(`${used} chats`)
      await shot("card-page")
      await page.getByRole("button", { name: "Fork", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Fork card", exact: true })
      await expect(dialog.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(parent.label)
      await expect(dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true })).toBeFocused()
      await expect(dialog.getByRole("textbox", { name: "In-character name", exact: true })).toHaveValue(parent.label)
      await expect(dialog.getByRole("button", { name: "Fork card", exact: true })).toBeDisabled()
      await shot("fork-dialog")
      const version = `Storm ${width} ${theme}`
      await dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill(version)
      await dialog.getByRole("textbox", { name: "In-character name", exact: true }).fill("Captain Aria")
      await dialog.getByRole("button", { name: "Fork card", exact: true }).click()
      await expect(page).not.toHaveURL(`${server().url}/library/${parent.id}`)
      await expect(page.getByText("Forked from", { exact: false }).first()).toBeVisible()
      const childUrl = page.url()
      await expect(page.getByRole("list", { name: "Forks tree" })).toContainText(version)
      await shot("editor")
      await page.getByRole("button", { name: "Compare with parent", exact: true }).click()
      const compare = page.getByRole("dialog", { name: "Compare with parent", exact: true })
      await expect(compare.getByLabel("Card differences")).toContainText("Captain Aria")
      await shot("compare")
      await compare.getByRole("button", { name: "Close", exact: true }).click()
      // Make a fork of a fork, and compare with any family member.
      await page.getByRole("button", { name: "Fork", exact: true }).click()
      await dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill(`${version} child`)
      await dialog.getByRole("button", { name: "Fork card", exact: true }).click()
      await expect(page).not.toHaveURL(childUrl)
      await expect(page.getByRole("list", { name: "Forks tree" })).toContainText(`${version} child`)
      await page.getByRole("button", { name: "Compare with parent", exact: true }).click()
      await compare.getByRole("combobox").click()
      await page
        .getByRole("option", { name: `${parent.label}${parent.subtitle ? ` · ${parent.subtitle}` : ""}`, exact: true })
        .click()
      await expect(compare.getByLabel("Card differences")).toContainText("Captain Aria")
      await compare.getByRole("button", { name: "Close", exact: true }).click()
      await page.goto(childUrl)
      await page.getByRole("button", { name: "Mark as a fork of…", exact: true }).click()
      const picker = page.getByRole("dialog", { name: "Mark as a fork of…", exact: true })
      await picker.getByRole("textbox", { name: "Find a parent card" }).fill(`${version} child`)
      await picker.getByRole("button", { name: `${parent.label} · ${version} child`, exact: true }).click()
      await expect(picker.getByRole("alert")).toBeVisible() // descendant would make a cycle
      await picker.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("button", { name: "Unlink", exact: true }).click()
      await expect(page.getByRole("button", { name: "Unlink", exact: true })).toHaveCount(0)
      await page.getByRole("button", { name: "Mark as a fork of…", exact: true }).click()
      await picker.getByRole("textbox", { name: "Find a parent card" }).fill(parent.label)
      await shot("parent-picker")
      await picker
        .getByRole("button", { name: `${parent.label}${parent.subtitle ? ` · ${parent.subtitle}` : ""}`, exact: true })
        .click()
      await expect(picker).not.toBeVisible()
      await expect(page.getByRole("button", { name: "Compare with parent", exact: true })).toBeEnabled()
      await page.goto(`${server().url}/library`)
      const row = page
        .getByRole("list", { name: "Cards", exact: true })
        .locator("li")
        .filter({ hasText: version })
        .filter({ has: page.getByText(version, { exact: true }) })
        .first()
      await expect(row).toContainText("Forked from")
      await expect(row.getByRole("link", { name: /Update .* from a file/ })).toHaveCount(0)
      await row.getByRole("button", { name: "Fork", exact: true }).click()
      await expect(dialog.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue(parent.label)
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await row.getByRole("button", { name: "Forks", exact: true }).click()
      await expect(
        page.getByRole("dialog", { name: "Forks", exact: true }).getByRole("list", { name: "Forks tree" })
      ).toContainText(`${version} child`)
      await shot("library-family")
      await page
        .getByRole("dialog", { name: "Forks", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click()
      await page.goto(`${server().url}/`)
      await expect(page.getByRole("button", { name: `Open ${parent.label} · ${version}`, exact: true })).toBeVisible()
      await page
        .getByRole("button", { name: `Forks of ${parent.label}`, exact: true })
        .first()
        .click()
      await expect(page.getByRole("dialog", { name: "Forks", exact: true })).toContainText(version)
      await shot("grid-family")
    })
  }

test("chat provenance and deleted family members remain visible", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const seed = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const parent = yield* api.CreateCard({ label: "Deleted parent", name: "Deleted parent" })
      const chat = yield* api.CreateChat({ title: "The synthetic harbor" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: parent.entityId } })
      const child = yield* api.ForkCardForChat({
        chatId: chat.id,
        forkId: chat.currentForkId,
        slotId: null,
        entityId: parent.entityId,
        name: "Harbor child",
        nickname: "",
        characterVersion: "storm",
        moveDrafts: false
      })
      return { parent, child, chat }
    })
  )
  // A synthetic binned card; fixture writes run in a database worker.
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      { sql: "UPDATE entities SET deleted_at=? WHERE id=?", params: [Date.now(), seed.parent.entityId] }
    ])
  )
  await page.goto(`${server().url}/library/${seed.child.id}`)
  await expect(page.getByRole("link", { name: "The synthetic harbor", exact: true })).toHaveAttribute(
    "href",
    `/chats/${seed.chat.id}`
  )
  await expect(page.getByRole("list", { name: "Forks tree" })).toContainText("in the bin")
  await expect(page.getByText("Forked from").locator("..")).toContainText("Deleted parent")
  await page.getByRole("button", { name: "Compare with parent", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Compare with parent", exact: true })).toContainText(
    "Restore it from the bin"
  )
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      { sql: "UPDATE entities SET purged_at=? WHERE id=?", params: [Date.now(), seed.parent.entityId] }
    ])
  )
  await page.reload()
  await expect(page.getByRole("list", { name: "Forks tree" })).toContainText("purged")
  await page.getByRole("button", { name: "Compare with parent", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Compare with parent", exact: true })).toContainText("deleted for good")
})

test("the parent picker finds archived cards by their in-character name", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const seed = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const source = yield* api.CreateCard({ label: "Search source", name: "Search source" })
      const parent = yield* api.ForkCard({
        refId: source.id,
        name: "Library title",
        nickname: "Captain Searchable",
        characterVersion: "old",
        moveDrafts: false
      })
      const child = yield* api.CreateCard({ label: "Picker child", name: "Picker child" })
      return { parent, child }
    })
  )
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      { sql: "UPDATE entities SET archived_at=? WHERE id=?", params: [Date.now(), seed.parent.entityId] }
    ])
  )
  await page.goto(`${server().url}/library/${seed.child.id}`)
  await page.getByRole("button", { name: "Mark as a fork of…", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Mark as a fork of…", exact: true })
  await picker.getByRole("textbox", { name: "Find a parent card" }).fill("captain searchable")
  await picker.getByRole("button", { name: "Library title · old", exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(page.getByText("Forked from").locator("..")).toContainText("Library title")
  await expect(page.getByRole("list", { name: "Forks tree" })).toContainText("archived")
})

test("family comparison reads both current saved heads and excludes drafts", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const seed = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const parent = yield* api.CreateCard({ label: "Saved comparison", name: "Saved comparison" })
      const saveDescription = (refId: typeof parent.id, content: string, commit: boolean) =>
        Effect.gen(function* () {
          const opened = yield* api.OpenEditor({ refId })
          const draft = yield* api.SaveEditorDraft({
            refId,
            field: textField(["description"]),
            content,
            draftId: null,
            expectedSession: null,
            expectedRowVersion: null,
            baseRevisionId: opened.ref.headRevisionId
          })
          if (commit)
            yield* api.CommitEditorDrafts({
              refId,
              expectedRowVersion: opened.ref.rowVersion,
              fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
              message: null
            })
        })
      yield* saveDescription(parent.id, "The saved lighthouse keeper.", true)
      const child = yield* api.ForkCard({
        refId: parent.id,
        name: "Saved comparison",
        nickname: "",
        characterVersion: "child",
        moveDrafts: false
      })
      yield* saveDescription(parent.id, "The parent’s later saved premise.", true)
      yield* saveDescription(parent.id, "PARENT DRAFT EXCLUDED", false)
      yield* saveDescription(child.id, "CHILD DRAFT EXCLUDED", false)
      return { child }
    })
  )
  await page.goto(`${server().url}/library/${seed.child.id}`)
  await page.getByRole("button", { name: "Compare with parent", exact: true }).click()
  const diff = page.getByRole("dialog", { name: "Compare with parent", exact: true }).getByLabel("Card differences")
  await expect(diff).toContainText("The parent’s later saved premise.")
  await expect(diff).toContainText("The saved lighthouse keeper.")
  await expect(diff).not.toContainText("DRAFT EXCLUDED")
})

for (const width of [1440, 390]) {
  test(`fork dialog preserves long card names at ${width}`, async ({ page }) => {
    const theme = width === 1440 ? "light" : "dark"
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const parent = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateCard({ label: `Long names ${width}`, name: `Long names ${width}` })
    )
    await page.goto(`${server().url}/library/${parent.id}`)
    await page.getByRole("button", { name: "Fork", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Fork card", exact: true })
    const display = `Keeper ${width} ` + "of the lighthouse ".repeat(20)
    const version = "The autumn storm. ".repeat(40)
    const nickname = "Captain of the northern harbor ".repeat(25)
    await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill(display)
    await dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill(version)
    await dialog.getByRole("textbox", { name: "In-character name", exact: true }).fill(nickname)
    if (process.env.CF5_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.CF5_SCREENSHOTS}/long-fork-${width}-${theme}.png` })
    }
    await dialog.getByRole("button", { name: "Fork card", exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const child = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const family = yield* api.CardFamily({ entityId: parent.entityId })
        const refId = family.members.find((m) => m.entityId !== parent.entityId)!.refId!
        return yield* api.OpenEditor({ refId })
      })
    )
    expect(child.doc.name).toBe(display.trim())
    expect(child.doc.nickname).toBe(nickname)
    expect(child.doc.character_version).toBe(version.trim())
    await page.goto(`${server().url}/cards/${parent.entityId}`)
    await page.getByRole("button", { name: "Compare with family", exact: true }).click()
    const compare = page.getByRole("dialog", { name: "Compare with family", exact: true })
    await expect(compare.getByLabel("Card differences")).toContainText("Keeper")
    if (process.env.CF5_SCREENSHOTS)
      await page.screenshot({ path: `${process.env.CF5_SCREENSHOTS}/root-compare-${width}-${theme}.png` })
  })
}
