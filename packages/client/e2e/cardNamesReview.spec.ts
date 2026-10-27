import { expectTextBox } from "./support/textbox.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { apiLogin, serverPerFile, withAdmin, ADMIN } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
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
    await dialog.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill("1")
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled()
  }
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveValue("Review cross-tab")
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
  await expect(
    page
      .getByRole("list", { name: "Characters and groups" })
      .getByRole("listitem")
      .filter({ hasText: "Review A, Review B" })
  ).toHaveCount(0)
  await expect(
    page
      .getByRole("list", { name: "Characters and groups" })
      .getByRole("link")
      .filter({ hasText: "Review A · distinctive-version-7, Review B · distinctive-version-9" })
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
  await expect(sidebar).toContainText("with Cache original · 1")
  await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Cache renamed")
  await page.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill("2")
  await page.getByRole("button", { name: "Save (2)", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Save a revision" })
    .getByRole("button", { name: "Save revision", exact: true })
    .click()
  await expect(page.getByRole("heading", { name: "Cache renamed", exact: true })).toBeVisible()
  await expect(sidebar).toContainText("with Cache renamed · 2")
})
test("three name drafts and diffs work, but history must refuse a colliding restore", async ({ page }) => {
  test.setTimeout(180000)
  const original = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "History original", name: "History original", version: "1", nickname: "Model original" })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${original.id}`)
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["Display name", "History renamed"],
    ["Name the model sees (leave empty to use the display name)", "Model renamed"],
    ["Version (shown as subtitle)", "2"],
    ["Description", "Synthetic CodeMirror text beside the three identity fields."]
  ]
  for (const [name, value] of fields)
    await page.getByRole("textbox", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).fill(value)
  await expect(page.getByRole("status").filter({ hasText: "4 fields have changes, kept as drafts" })).toBeVisible()
  await page.reload()
  for (const [name, value] of fields)
    await expectTextBox(
      page.getByRole("textbox", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }),
      value
    )
  await page.getByRole("button", { name: "Save (4)", exact: true }).click()
  const save = page.getByRole("dialog", { name: "Save a revision" })
  const changes = save.getByRole("list", { name: "Changes" })
  for (const label of ["Display name", "Name the model sees", "Version (shown as subtitle)", "Description"])
    await expect(changes).toContainText(label)
  await save.getByRole("button", { name: "Save revision", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "History original", name: "History original", version: "1" })
  )
  await page.reload()
  await page.getByRole("button", { name: "History", exact: true }).click()
  const history = page.getByRole("dialog", { name: "History" })
  const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions).toHaveCount(2)
  await revisions.first().getByRole("button").click()
  const diff = history.getByLabel("Revision changes", { exact: true })
  for (const label of ["Display name", "Name the model sees", "Version (shown as subtitle)", "Description"])
    await expect(diff).toContainText(label)
  await revisions.last().getByRole("button").click()
  const restore = history.getByRole("button", { name: "Restore", exact: true })
  await expect(restore).toBeDisabled()
  await expect(history.getByRole("status")).toContainText("Another card is already called History original · 1")
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

test("equal display names remain distinguishable in variant navigation", async ({ page }) => {
  const ref = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const original = yield* api.CreateCard({
        label: "Versioned variants",
        name: "Versioned variants",
        version: "original-version"
      })
      yield* api.ForkVariant({
        refId: original.id,
        label: original.label,
        subtitle: "second-version",
        moveDrafts: false
      })
      return original
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${ref.id}`)
  const variants = page.getByRole("navigation", { name: "Variants" })
  await expect(variants).toContainText("original-version")
  await expect(variants.getByRole("link", { name: "Versioned variants · second-version" })).toBeVisible()
})

test("Save rechecks names and disables the action after an unannounced collision", async ({ page }) => {
  const original = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Late save", name: "Late save", version: "1" })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${original.id}`)
  await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Late target")
  await page.getByRole("button", { name: "Save (1)", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Save a revision" })
  const save = dialog.getByRole("button", { name: "Save revision", exact: true })
  await expect(save).toBeEnabled()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateCard({ label: "Late target", name: "Late target", version: "1" })
  )
  await save.click()
  await expect(dialog.getByRole("status")).toContainText("Another card is already called Late target · 1")
  await expect(save).toBeDisabled()
  const refs = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.ListLibrary({ kind: "card" }))
  expect(refs.find((ref) => ref.id === original.id)?.label).toBe("Late save")
})
