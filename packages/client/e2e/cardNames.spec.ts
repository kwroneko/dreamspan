// Synthetic path import, standard card metadata, draft revisions and UI-only uniqueness.
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { asUser } from "./support/rpc.ts"
import { saveButton, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { renameCard } from "./support/cardEditor.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let imported = false
const screens = process.env.SCREENSHOT_DIR
if (screens) mkdirSync(screens, { recursive: true })

for (const width of [1440, 390]) {
  test(`standard names and clash messages on realistic synthetic data at ${width}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    if (!imported) {
      const folder = writeRealisticStFolder(join(server().dataDir, "st"))
      await page.goto(`${server().url}/import/st`)
      await page.getByLabel("Folder path").fill(folder)
      await page.getByRole("button", { name: "Look in this folder" }).click()
      await page.getByRole("button", { name: "Import", exact: true }).click()
      await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 120_000 })
      imported = true
    }
    const shoot = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      if (screens) await page.screenshot({ path: join(screens, `${name}-${width}.png`) })
    }
    await page.goto(server().url)
    // Browsing hides bare versions; the editor keeps the labelled version field.
    await expect(page.getByRole("button", { name: "Open Aria Vance", exact: true }).first()).toBeVisible()
    await shoot("grid")
    const groups = await admin((api) => api.ListChatGroups())
    const group = groups[0]!
    await page.goto(`${server().url}/groups/${group.latestChatId}`)
    const members = page.getByRole("list", { name: "Characters in the group" })
    for (const member of group.members) {
      await expect(members).toContainText(member.label)
    }
    await shoot("group-members")
    const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
    const aria = refs.find((ref) => ref.label === "Aria Vance")!
    await page.goto(`${server().url}/cards/${aria.entityId}`)
    await expect(page.getByRole("heading", { name: "Aria Vance", exact: true })).toBeVisible()
    await expect(page.locator("main header:not([data-center-header])").getByText("1", { exact: true })).toHaveCount(0)
    await shoot("card")
    await page.goto(`${server().url}/library/${aria.id}`)
    // The names in the header, each renamed in place (no identity section).
    await expect(page.getByRole("heading", { level: 1, name: "Aria Vance", exact: true })).toBeVisible()
    await expect(page.getByRole("main").getByText("1", { exact: true }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Rename the nickname", exact: true })).toBeVisible()
    await shoot("editor")
    // Fork pair checks; the chosen names become the fork revision, with parent unchanged.
    await page.getByRole("button", { name: "Fork", exact: true }).click()
    const fork = page.getByRole("dialog", { name: "Fork card" })
    await fork.getByRole("textbox", { name: "Display name", exact: true }).fill("Aria Vance")
    await fork.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill("1")
    const clash = "Another card is already called Aria Vance · 1: change the display name or the version"
    await expect(fork.getByRole("status")).toHaveText(clash)
    await expect(fork.getByRole("button", { name: "Fork card" })).toBeDisabled()
    await shoot("fork-clash")
    await fork.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill(`fork-${width}`)
    await expect(fork.getByRole("button", { name: "Fork card" })).toBeEnabled()
    await fork.getByRole("button", { name: "Fork card" }).click()
    await expect(page.getByRole("main").getByText(`fork-${width}`, { exact: true }).first()).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Variants" })).toHaveCount(0)
    await shoot("fork")
    // Renaming an existing card checks the pair on confirm: the field stays open with the clash.
    await renameCard(page, "version", "1")
    await expect(page.getByRole("alert").filter({ hasText: "Another card is already called" })).toContainText(clash)
    await expect(page.getByRole("textbox", { name: "Version", exact: true })).toBeVisible()
    await shoot("rename-clash")
    await page.getByRole("button", { name: "Cancel renaming", exact: true }).click()
    // New card check, then choose a distinct version.
    await page.goto(`${server().url}/library`)
    await page.getByRole("button", { name: "New card", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "New card" })
    await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Aria Vance")
    await dialog.getByRole("textbox", { name: "Version", exact: true }).fill("1")
    await expect(dialog.getByRole("status")).toHaveText(clash)
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled()
    await shoot("new-clash")
    await dialog.getByRole("textbox", { name: "Version", exact: true }).fill(`new-${width}`)
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled()
    await dialog.getByRole("button", { name: "Cancel" }).click()
    // An imported collision remains editable when only other fields change.
    await page.request.post(`${server().url}/library/import?name=collision.json`, {
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3.0",
          data: { name: "Aria Vance", character_version: "1", nickname: "Aria" }
        })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    const duplicates = await admin((api) => api.ListLibrary({ kind: "card" }))
    expect(duplicates.filter((ref) => ref.label === "Aria Vance" && ref.subtitle === "1").length).toBeGreaterThan(1)
    await page.goto(`${server().url}/library/${aria.id}`)
    await page.getByRole("textbox", { name: "Description", exact: true }).fill(`Synthetic edit ${width}`)
    await expect(saveButton(page)).toBeEnabled()
    await saveRevision(page)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    // Keep the greeting / cast names visibly different from the model name.
    await admin((api) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: aria.id })
        const saved = yield* api.SaveEditorDraft({
          refId: aria.id,
          field: textField(["nickname"]),
          content: "Aria model",
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId
        })
        yield* api.CommitEditorDrafts({
          refId: aria.id,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: saved.key.field, draftId: saved.id, expectedRowVersion: saved.rowVersion }],
          message: null
        })
      })
    )
    const usage = await admin((api) => api.ListCardUsage())
    const chatId = usage.find((card) => card.entityId === aria.entityId)!.latestChatId!
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
    await shoot("chat-header")
    await openPanel(page, "Cast")
    const castList = page.getByRole("list", { name: "Characters in this chat" })
    await expect(castList).toContainText("Aria Vance")
    // A Cast row shows the version only to tell two cards of one name apart; Aria's is unique here.
    const row = castList.getByRole("listitem", { name: "Aria Vance", exact: true })
    await expect(row).toContainText("Aria Vance")
    await expect(row).not.toContainText("1")
    await shoot("chat-cast")
    // A normal name/version save refreshes the mounted sidebar, and History cannot
    // restore an occupied imported pair. All surrounding data is the realistic import.
    await page.goto(`${server().url}/library/${aria.id}`)
    // Aria has a nickname, so changing the display name asks nothing.
    await renameCard(page, "display", `Aria revised ${width}`)
    await renameCard(page, "version", `revised-${width}`)
    await saveButton(page).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    if (width === 1440) {
      // The shell's left panel lists cards with their versions under Characters (unit E).
      const sidebar = page.getByRole("complementary")
      await sidebar
        .getByRole("group", { name: "Left panel", exact: true })
        .getByRole("button", { name: "Characters", exact: true })
        .click()
      await expect(sidebar.getByRole("button", { name: `Open Aria revised ${width}`, exact: true })).toBeVisible()
    }
    await shoot("sidebar-save")
    await page.getByRole("button", { name: "History", exact: true }).click()
    const history = page.getByRole("dialog", { name: "History" })
    await history
      .getByRole("list", { name: "Revisions" })
      .getByRole("listitem")
      .last()
      .getByRole("button", { name: /^Revision \d+ / })
      .click()
    // A known name clash disables restore and explains the conflict in the comparison.
    const revisionCount = await history.getByRole("list", { name: "Revisions" }).getByRole("listitem").count()
    await expect(history.getByRole("button", { name: "Restore to revision 1", exact: true })).toBeDisabled()
    await expect(history.getByRole("status")).toContainText("Another card is already called Aria Vance · 1")
    await expect(history.getByRole("list", { name: "Revisions" }).getByRole("listitem")).toHaveCount(revisionCount)
    await history.getByRole("status").scrollIntoViewIfNeeded()
    await shoot("history-clash")
    // Restore the synthetic fixture for the next viewport through the storage-compatible API.
    await admin((api) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: aria.id })
        yield* api.RenameRef({
          refId: aria.id,
          label: "Aria Vance",
          subtitle: "1",
          expectedRowVersion: opened.ref.rowVersion
        })
      })
    )
  })
}
