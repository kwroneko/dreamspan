import { expectTextBox } from "./support/textbox.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { apiLogin, serverPerFile, withAdmin, ADMIN } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { UNSAVED, expectSaveState, saveButton, saveRevision } from "./support/saveRevision.ts"
import { chatNameLine, renameCard } from "./support/cardEditor.ts"
const server = serverPerFile(withAdmin)
test("another tab creating the same pair must disable Create in the waiting tab", async ({ context, page }) => {
  test.setTimeout(120000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const other = await context.newPage()
  for (const tab of [page, other]) {
    await tab.goto(`${server().url}/library`)
    await tab.getByRole("button", { name: "New card", exact: true }).click()
    const dialog = tab.getByRole("dialog", { name: "New card" })
    await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Review cross-tab")
    await dialog.getByRole("textbox", { name: "Version", exact: true }).fill("1")
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled()
  }
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Review cross-tab", exact: true })).toBeVisible()
  const create = other.getByRole("dialog").getByRole("button", { name: "Create", exact: true })
  await expect(create).toBeDisabled()
  const refs = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
  expect(refs.filter((ref) => ref.label === "Review cross-tab" && ref.subtitle === "1")).toHaveLength(1)
})
test("group member listing includes the card version", async ({ page }) => {
  test.setTimeout(120000)
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Review A", name: "Review A", version: "distinctive-version-7" })
      const b = yield* api.CreateCard({ label: "Review B", name: "Review B", version: "distinctive-version-9" })
      return yield* api.StartChat({
        cards: [a.entityId, b.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Synthetic hello", speakerEntityId: null }
      })
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/groups/${started.chat.id}`)
  const members = page.getByRole("list", { name: "Characters in the group" })
  await expect(members).toContainText("Review A")
  await expect(members).toContainText("distinctive-version-7")
  await page.goto(server().url)
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Groups", exact: true })
    .click()
  const groups = page.getByRole("main").getByLabel("Groups", { exact: true })
  // A tile counts its members (UI audit, 2026-10-31); its tooltip names them with their versions.
  await expect(groups.getByRole("button").filter({ hasText: "2 members" })).toBeVisible()
  await expect(
    groups.getByTitle("Review A · distinctive-version-7, Review B · distinctive-version-9", { exact: true })
  ).toBeVisible()
})
test("the sidebar refreshes card name and version after an ordinary editor Save", async ({ page }) => {
  test.setTimeout(120000)
  const ref = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const ref = yield* api.CreateCard({ label: "Cache original", name: "Cache original", version: "1" })
      yield* api.StartChat({
        cards: [ref.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Synthetic", speakerEntityId: null }
      })
      return ref
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${ref.id}`)
  const sidebar = page.getByRole("complementary")
  // The shell's left panel lists cards with their versions under Characters (unit E).
  await sidebar
    .getByRole("group", { name: "Left panel", exact: true })
    .getByRole("button", { name: "Characters" })
    .click()
  await expect(sidebar).toContainText("Cache original")
  await expect(sidebar.getByRole("button", { name: "Open Cache original · 1", exact: true })).toBeVisible()
  // The name chats use changes, so the rename asks about past messages on confirm.
  await renameCard(page, "display", "Cache renamed")
  await page.getByRole("dialog").getByRole("button", { name: "Just change it", exact: true }).click()
  await renameCard(page, "version", "2")
  await saveButton(page).click()
  await expect(page.getByRole("heading", { name: "Cache renamed", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "Open Cache renamed · 2", exact: true })).toBeVisible()
})
test("three name drafts and diffs work, but history must refuse a colliding restore", async ({ page }) => {
  test.setTimeout(180000)
  const original = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "History original", name: "History original", version: "1", nickname: "Model original" })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${original.id}`)
  // A display name changed with a nickname set asks nothing; the nickname asks (no chats here).
  await renameCard(page, "display", "History renamed")
  await expect(page.getByRole("heading", { level: 1, name: "History renamed", exact: true })).toBeVisible()
  await renameCard(page, "nickname", "Model renamed")
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^No\. Past messages will keep/ })
    .click()
  await renameCard(page, "version", "2")
  const description = "Synthetic CodeMirror text beside the three identity fields."
  await page.getByRole("textbox", { name: "Description", exact: true }).fill(description)
  await expectSaveState(page, UNSAVED)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "History renamed", exact: true })).toBeVisible()
  await expect(chatNameLine(page, "Model renamed")).toBeVisible()
  await expect(page.getByRole("main").getByText("2", { exact: true }).first()).toBeVisible()
  await expectTextBox(page.getByRole("textbox", { name: "Description", exact: true }), description)
  // Save asks nothing; History's comparison below names the four fields it saved.
  await saveRevision(page)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "History original", name: "History original", version: "1" })
  )
  await page.reload()
  await page.getByRole("button", { name: "History", exact: true }).click()
  const history = page.getByRole("dialog", { name: "History" })
  const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions).toHaveCount(2)
  await revisions
    .first()
    .getByRole("button", { name: /^Revision \d+ / })
    .click()
  const diff = history.locator('div[aria-label="Revision changes"]:not([role="tablist"])')
  for (const label of ["Display name", "In-chat nickname", "Version (shown as subtitle)", "Description"])
    await expect(diff).toContainText(label)
  await revisions
    .last()
    .getByRole("button", { name: /^Revision \d+ / })
    .click()
  // DESIGN §10.1 historyui: Restore is an entry action; name validation runs on activation.
  const restore = revisions.last().getByRole("button", { name: "Restore to revision 1", exact: true })
  await restore.click()
  await expect(history.getByRole("alert")).toContainText("Another card is already called History original · 1")
  await expect(revisions).toHaveCount(2)
  await history.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "History renamed", exact: true })).toBeVisible()
})

test("submission rechecks names even without a tab notification", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: "New card", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "New card" })
  await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Unannounced import")
  const create = dialog.getByRole("button", { name: "Create", exact: true })
  await expect(create).toBeEnabled()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Unannounced import", name: "Unannounced import" })
  )
  await create.click()
  await expect(dialog.getByRole("alert")).toContainText("Another card is already called Unannounced import")
  await expect(create).toBeDisabled()
  const refs = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
  expect(refs.filter((ref) => ref.label === "Unannounced import")).toHaveLength(1)
})

test("forks with equal display names are separate library entries", async ({ page }) => {
  const ref = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const original = yield* api.CreateCard({
        label: "Versioned variants",
        name: "Versioned variants",
        version: "original-version"
      })
      yield* api.ForkCard({
        refId: original.id,
        name: original.label,
        nickname: "",
        characterVersion: "second-version"
      })
      return original
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${ref.id}`)
  await expect(page.getByRole("navigation", { name: "Variants" })).toHaveCount(0)
  const refs = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
  expect(
    refs
      .filter((card) => card.label === ref.label)
      .map((card) => card.subtitle)
      .sort()
  ).toEqual(["original-version", "second-version"])
})

test("Save rechecks names and disables the action after an unannounced collision", async ({ page }) => {
  const original = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Late save", name: "Late save", version: "1" })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${original.id}`)
  await renameCard(page, "display", "Late target")
  await page.getByRole("dialog").getByRole("button", { name: "Just change it", exact: true }).click()
  const save = saveButton(page)
  await expect(save).toBeEnabled()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Late target", name: "Late target", version: "1" })
  )
  // Save asks nothing, so the recheck happens on the click itself.
  await save.click()
  // The clash shows once in the editor's status line.
  await expect(
    page.getByRole("status").filter({ hasText: "Another card is already called Late target · 1" })
  ).toBeVisible()
  await expect(save).toBeDisabled()
  const refs = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
  expect(refs.find((ref) => ref.id === original.id)?.label).toBe("Late save")
})
