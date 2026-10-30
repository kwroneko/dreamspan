import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const save = async (page: Page) => {
  await page.getByRole("button", { name: /^Save \(/ }).click()
  const dialog = page.getByRole("dialog", { name: "Save a revision" })
  await expect(dialog.getByText("Some changes no longer fit the document")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Everything is saved." })).toBeVisible()
}

for (const width of [1440, 390]) {
  test(`embedded lorebook drafts, revisions, removal and export at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    // Synthetic imported metadata must survive edits to neighbouring fields.
    const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name: `Keeper ${width}`,
            description: "Synthetic keeper",
            personality: "",
            scenario: "",
            first_mes: "Hello",
            mes_example: "",
            character_book: {
              name: "Harbour",
              extensions: { synthetic: { keep: true } },
              entries: [
                {
                  id: 7,
                  keys: ["harbour"],
                  content: "The tide is low.",
                  comment: "Tides",
                  enabled: true,
                  insertion_order: 23,
                  extensions: { synthetic: "retained", sticky: 3 },
                  future_entry: "preserved"
                },
                { id: 42, keys: ["lamp"], content: "The lamp is lit.", comment: "Lamp", enabled: true, extensions: {} }
              ]
            }
          }
        })
      )
    })
    expect(response.status()).toBe(200)
    const {
      library: { ref }
    } = await response.json()
    await page.goto(`${server().url}/library/${ref.id}`)
    const entry = page.getByRole("group", { name: "Lorebook entry 7", exact: true })
    await expectTextBox(entry.getByRole("textbox", { name: "Entry content" }), "The tide is low.")
    // Other entries stay compact until opened; large books do not mount every text editor.
    await expect(page.getByRole("group", { name: /^Lorebook entry/ })).toHaveCount(1)
    const lamp = page.locator("summary").filter({ hasText: /^Lamp$/ })
    await lamp.click()
    await expectTextBox(
      page
        .getByRole("group", { name: "Lorebook entry 42", exact: true })
        .getByRole("textbox", { name: "Entry content" }),
      "The lamp is lit."
    )
    await lamp.click()
    await expect(page.getByRole("group", { name: /^Lorebook entry/ })).toHaveCount(1)
    await entry.getByRole("textbox", { name: "Entry title" }).fill("Harbour tides")
    await entry.getByRole("textbox", { name: "Primary keys" }).fill("harbour\n/tide,a/iu")
    await entry.getByRole("textbox", { name: "Entry content" }).fill("The tide turns at dawn.")
    await entry.getByRole("textbox", { name: "Primary keys" }).blur()
    await expect
      .poll(
        async () =>
          (await admin((api) => api.OpenEditor({ refId: ref.id }))).drafts.filter((d) => d.status === "active").length
      )
      .toBe(3)
    await page.reload()
    await expectTextBox(entry.getByRole("textbox", { name: "Entry content" }), "The tide turns at dawn.")
    await expect(entry.getByRole("textbox", { name: "Primary keys" })).toHaveValue("harbour\n/tide,a/iu")
    await entry.getByRole("button", { name: "Revert Entry content", exact: true }).click()
    await expectTextBox(entry.getByRole("textbox", { name: "Entry content" }), "The tide is low.")
    await entry.getByRole("textbox", { name: "Entry content" }).fill("The tide turns at dawn.")
    await entry.locator("..").getByText("Matching and placement", { exact: true }).click()
    await entry.getByRole("switch", { name: "Use secondary keys", exact: true }).click()
    await entry.getByRole("textbox", { name: "Secondary keys" }).fill("storm\nwind")
    await entry.getByRole("combobox", { name: "Secondary key logic" }).click()
    await page.getByRole("option", { name: "Match none", exact: true }).click()
    await entry.getByRole("combobox", { name: "Case sensitive", exact: true }).click()
    await page.getByRole("option", { name: "Off", exact: true }).click()
    await expect(page.getByRole("option", { name: "Off", exact: true })).toHaveCount(0)
    await page.getByRole("combobox", { name: "Recursive scanning", exact: true }).click()
    await page.getByRole("option", { name: "On", exact: true }).click()
    await save(page)
    const firstRevision = (await admin((api) => api.OpenEditor({ refId: ref.id }))).ref.headRevisionId
    const book = async () => (await admin((api) => api.OpenEditor({ refId: ref.id }))).doc.character_book as LorebookDoc
    expect((await book()).entries[0]).toMatchObject({
      uid: 7,
      selective: true,
      secondary_keys: ["storm", "wind"],
      selective_logic: "not_any",
      case_sensitive: false,
      comment: "Harbour tides",
      keys: ["harbour", "/tide,a/iu"],
      content: "The tide turns at dawn.",
      sticky: 3,
      extensions: { synthetic: "retained" },
      unknown_fields: { future_entry: "preserved" }
    })
    expect((await book()).recursive_scanning).toBe(true)
    expect((await book()).extensions).toEqual({ synthetic: { keep: true } })

    // Deleting an entry with a live text draft keeps the other entry's identity and text.
    await entry.getByRole("textbox", { name: "Entry content" }).fill("Text before removal.")
    await entry.getByRole("button", { name: "Remove entry", exact: true }).click()
    await expect(entry).toHaveCount(0)
    await page.getByRole("button", { name: "Add lorebook entry", exact: true }).click()
    const added = page.getByRole("group", { name: /^Lorebook entry/ }).last()
    await added.getByRole("textbox", { name: "Entry title" }).fill("Gulls")
    await added.getByRole("textbox", { name: "Primary keys" }).fill("gull")
    await added.getByRole("textbox", { name: "Entry content" }).fill("Gulls gather on the quay.")
    await added.getByRole("switch", { name: /^Always include/ }).click()
    await added.locator("..").getByText("Matching and placement", { exact: true }).click()
    await added.getByRole("spinbutton", { name: "Insertion order" }).fill("37")
    await added.getByRole("spinbutton", { name: "Insertion order" }).blur()
    await save(page)
    await page.reload()
    expect((await book()).entries.map((e) => e.comment)).toEqual(["Lamp", "Gulls"])
    expect((await book()).entries[1]).toMatchObject({
      content: "Gulls gather on the quay.",
      constant: true,
      enabled: true,
      order: 37
    })
    // Export uses the saved card revision, including the edited embedded book.
    const exported = await page.request.post(`${server().url}/library/export`, {
      headers: { origin: server().url },
      data: { refId: ref.id, format: "card-v2-json" }
    })
    expect(exported.status()).toBe(200)
    const file = await exported.json()
    expect(file.data.character_book.entries.map((e: { comment: string }) => e.comment)).toEqual(["Lamp", "Gulls"])
    expect(file.data.character_book.extensions).toEqual({ synthetic: { keep: true } })

    // An earlier revision restores the deleted entry, without destroying later history.
    await admin((api) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: ref.id })
        yield* api.RestoreRevision({
          refId: ref.id,
          revisionId: firstRevision,
          expectedRowVersion: opened.ref.rowVersion
        })
      })
    )
    await page.reload()
    await expectTextBox(entry.getByRole("textbox", { name: "Entry content" }), "The tide turns at dawn.")
    await entry.locator("..").getByText("Matching and placement", { exact: true }).click()
    const dir = process.env.SCREENSHOT_DIR
    if (dir) {
      await mkdir(dir, { recursive: true })
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme })
        const section = page
          .locator("section")
          .filter({ has: page.getByRole("heading", { name: "Embedded lorebook", exact: true }) })
        await section.evaluate((element) => {
          element.scrollIntoView({ block: "start" })
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
              parent.scrollTop -= 180
              break
            }
          }
        })
        await page.screenshot({
          animations: "disabled",
          path: join(dir, `embedded-lorebook-${width}-${colorScheme}.png`)
        })
        await entry.getByRole("textbox", { name: "Entry content" }).scrollIntoViewIfNeeded()
        await page.screenshot({ animations: "disabled", path: join(dir, `embedded-entry-${width}-${colorScheme}.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      }
    }
  })
}

test("an absent embedded book can be authored, including an empty book after removing its first entry", async ({
  page
}) => {
  const card = await admin((api) => api.CreateCard({ label: "New lore", name: "New lore" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  await expect(page.getByText("This card has no embedded lorebook.")).toBeVisible()
  await page.getByRole("button", { name: "Add lorebook entry" }).click()
  await page.getByRole("textbox", { name: "Lorebook name", exact: true }).fill("New book")
  const entry = page.getByRole("group", { name: /^Lorebook entry/ })
  await entry.getByRole("textbox", { name: "Entry content" }).fill("Never lose this text.")
  await entry.getByRole("button", { name: "Remove entry", exact: true }).click()
  await save(page)
  await page.reload()
  await expect(page.getByText("No entries yet.")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Lorebook name", exact: true })).toHaveValue("New book")
  const opened = await admin((api) => api.OpenEditor({ refId: card.id }))
  expect((opened.doc.character_book as LorebookDoc).entries).toEqual([])
})

for (const target of ["book", "entry"] as const) {
  for (const action of ["Revert", "Undo"] as const) {
    test(`${action} a new ${target} recovers its field drafts and permits later card saves`, async ({ page }) => {
      const name = `${action} lore ${target}`
      const card = await admin((api) => api.CreateCard({ label: name, name }))
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library/${card.id}`)
      await page.getByRole("button", { name: "Add lorebook entry" }).click()
      await page.getByRole("textbox", { name: "Lorebook name", exact: true }).fill("Draft book")
      if (target === "entry") {
        await page.getByRole("button", { name: "Remove entry", exact: true }).click()
        await save(page)
        await page.getByRole("button", { name: "Add lorebook entry" }).click()
      }
      const text = `Recover this lore: ${name}`
      await page.getByRole("textbox", { name: "Entry content", exact: true }).fill(text)
      await page
        .getByRole("button", {
          name: `${action} ${target === "book" ? "Embedded lorebook" : "Untitled entry"}`,
          exact: true
        })
        .click()
      await expect(
        page.getByText(target === "book" ? "This card has no embedded lorebook." : "No entries yet.")
      ).toBeVisible()
      await expect
        .poll(async () =>
          (await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))).some((r) => r.content === text)
        )
        .toBe(true)
      await page.getByRole("textbox", { name: "Creator", exact: true }).fill("Synthetic creator")
      await save(page)
      await page.reload()
      const opened = await admin((api) => api.OpenEditor({ refId: card.id }))
      if (target === "book") expect(opened.doc.character_book).toBeUndefined()
      else expect((opened.doc.character_book as LorebookDoc).entries).toEqual([])
      expect(opened.doc.creator).toBe("Synthetic creator")
      expect(opened.drafts.filter((draft) => draft.status === "active")).toEqual([])
    })
  }
}

test("card search and replace includes embedded lore and keys in closed entries", async ({ page }) => {
  const card = await admin((api) => api.CreateCard({ label: "Search lore", name: "Search lore" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  await page.getByRole("button", { name: "Add lorebook entry" }).click()
  await page.getByRole("textbox", { name: "Lorebook name", exact: true }).fill("Harbour")
  await page.getByRole("textbox", { name: "Lorebook description", exact: true }).fill("Harbour guide")
  await page.getByRole("textbox", { name: "Entry title", exact: true }).fill("Harbour tides")
  await page.getByRole("textbox", { name: "Entry content", exact: true }).fill("Harbour tide")
  await page.getByRole("textbox", { name: "Primary keys", exact: true }).fill("harbour\n/harbour,a/iu")
  await page
    .locator("summary")
    .filter({ hasText: /^Harbour tides$/ })
    .click()
  await page.getByRole("button", { name: "Search", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Search and replace" })
  await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("harbour")
  await dialog.getByRole("textbox", { name: "Replace with", exact: true }).fill("port")
  await dialog.getByRole("button", { name: "Find", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("6 matches.")
  await dialog.getByRole("button", { name: /Go to Lorebook entry .*: Content$/ }).click()
  const content = page.getByRole("textbox", { name: "Entry content", exact: true })
  await expect(content).toBeFocused()
  await expect
    .poll(() =>
      content.evaluate((e) =>
        (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null }).getSelection()?.toString()
      )
    )
    .toBe("Harbour")
  await page
    .locator("summary")
    .filter({ hasText: /^Harbour tides$/ })
    .click()
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("harbour")
  await dialog.getByRole("button", { name: "Find", exact: true }).click()
  await dialog.getByRole("button", { name: /Go to Lorebook entry .*: Primary key 2$/ }).click()
  const keys = page.getByRole("textbox", { name: "Primary keys", exact: true })
  await expect(keys).toBeFocused()
  await expect
    .poll(() =>
      keys.evaluate((e) => {
        const input = e as HTMLTextAreaElement
        return { text: input.value.slice(input.selectionStart, input.selectionEnd), start: input.selectionStart }
      })
    )
    .toEqual({ text: "harbour", start: 9 })
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("harbour")
  await dialog.getByRole("textbox", { name: "Replace with", exact: true }).fill("port")
  await dialog.getByRole("button", { name: "Find", exact: true }).click()
  await dialog.getByRole("button", { name: "Replace all", exact: true }).click()
  await expect(dialog.getByRole("status")).toHaveText("No matches.")
  await dialog.press("Escape")
  await save(page)
  await page.reload()
  const opened = await admin((api) => api.OpenEditor({ refId: card.id }))
  expect(opened.doc.character_book).toMatchObject({
    name: "port",
    description: "port guide",
    entries: [{ comment: "port tides", content: "port tide", keys: ["port", "/port,a/iu"] }]
  })
})

test("typing after a key search visit keeps the new caret position", async ({ page }) => {
  const card = await admin((api) => api.CreateCard({ label: "Key caret", name: "Key caret" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  await page.getByRole("button", { name: "Add lorebook entry" }).click()
  const keys = page.getByRole("textbox", { name: "Primary keys", exact: true })
  await keys.fill("first\nharbour")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Search and replace" })
  await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("harbour")
  await dialog.getByRole("button", { name: "Find", exact: true }).click()
  await dialog.getByRole("button", { name: /Go to Lorebook entry .*: Primary key 2$/ }).click()
  await expect(keys).toBeFocused()
  await keys.press("p")
  // Wait for the controlled field to settle before continuing the user's edit.
  await expect(keys).toHaveValue("first\np")
  await expect.poll(() => keys.evaluate((e) => (e as HTMLTextAreaElement).selectionStart)).toBe(7)
  await keys.press("o")
  await expect(keys).toHaveValue("first\npo")
})
