import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const saved = (page: Page) => page.getByRole("status").filter({ hasText: /^Saved as revision \d+$/ })
const save = async (page: Page) => {
  await saveRevision(page)
  await expect(saved(page)).toBeVisible()
}
/** The labels of what the latest revision changed, in History's comparison with its parent. */
const latestChanges = async (page: Page) => {
  await page.getByRole("button", { name: "History", exact: true }).click()
  const history = page.getByRole("dialog", { name: "History", exact: true })
  await history
    .getByRole("list", { name: "Revisions" })
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /^Revision \d+ / })
    .click()
  return history
}

// A synthetic ST world info file; nothing here comes from a real book.
const worldInfo = (name: string) => ({
  name,
  entries: {
    0: { uid: 0, key: ["harbour", "quay"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 },
    1: { uid: 1, key: ["lamp", "lantern"], comment: "Lamp", content: "The lamp burns blue at night.", order: 20 },
    2: { uid: 2, key: ["fog"], comment: "Fog", content: "Fog rolls in at dusk.", order: 30, disable: true }
  }
})

for (const width of [1440, 390]) {
  test(`a standalone lorebook lists, filters, edits, saves, restores and exports its entries at ${width}`, async ({
    page
  }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const response = await page.request.post(`${server().url}/library/import?name=Saltmarsh ${width}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(JSON.stringify(worldInfo(`Saltmarsh ${width}`)))
    })
    expect(response.status()).toBe(200)
    const {
      library: { ref }
    } = await response.json()
    const chat = await admin((api) =>
      Effect.gen(function* () {
        const made = yield* api.CreateChat({ title: `Lorebook links ${width}` })
        yield* api.ChangeCast({
          chatId: made.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: ref.id, active: true }
        })
        return made
      })
    )
    // From the chat, Open shows the editor over the chat; the chat stays where it was.
    await page.goto(`${server().url}/chats/${chat.id}`)
    const panel = await openPanel(page, "Lorebooks")
    const inUse = panel.getByRole("list", { name: "Lorebooks in this chat" })
    await expect(inUse.getByRole("switch", { name: new RegExp(`^Saltmarsh ${width}`) })).toBeChecked()
    await inUse.getByRole("button", { name: `Open Saltmarsh ${width}`, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}`))
    await expect(
      page.getByRole("dialog", { name: "Lorebook editor" }).getByRole("list", { name: "Entries" })
    ).toBeVisible()
    // A lorebook isn't a preset: its way out says where it goes.
    await page.getByRole("button", { name: "Back to the chat", exact: true }).click()
    await expect(page.getByRole("list", { name: "Entries" })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}`))
    await page.goto(`${server().url}/library/${ref.id}`)
    await expect(page.getByRole("switch", { name: /Use in every chat/ })).toBeVisible()
    await expect(page.getByText("Added to 1 chat: what you change here is used there as you type.")).toBeVisible()
    await expect(page.getByRole("region", { name: "Where it's used" })).toContainText("3 entries")
    // One row per entry, highest order first, as ST's Priority sort; rows open to the whole entry.
    const titles = () =>
      page
        .getByRole("list", { name: "Entries" })
        .getByRole("textbox", { name: /^Title of / })
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    await expect.poll(titles).toEqual(["Fog", "Lamp", "Harbour"])
    await expect(page.getByRole("button", { name: /^Keys of Lamp: lamp, lantern/ })).toBeVisible()
    await expect(page.getByRole("switch", { name: "Fog enabled" })).not.toBeChecked()
    await expect(page.getByRole("group", { name: /^Lorebook entry/ })).toHaveCount(0)

    // The search narrows by title, key or text; the filter by enabled; the sort reorders.
    const search = page.getByRole("searchbox", { name: "Search titles, keys and content" })
    await search.fill("lantern")
    await expect.poll(titles).toEqual(["Lamp"])
    await expect(page.getByText("1 of 3 entries")).toBeVisible()
    await search.fill("")
    await page.getByRole("button", { name: "Disabled", exact: true }).click()
    await expect.poll(titles).toEqual(["Fog"])
    await page.getByRole("button", { name: "All", exact: true }).click()
    if (width === 1440) {
      await page.getByRole("combobox", { name: "Sort entries by" }).click()
      await page.getByRole("option", { name: "Title", exact: true }).click()
      await expect.poll(titles).toEqual(["Fog", "Harbour", "Lamp"])
    }

    // Edits in the row and in the opened entry are drafts that survive a reload, then a revision.
    const harbour = page.getByRole("group", { name: "Lorebook entry 0", exact: true })
    await page.getByRole("button", { name: "Open Harbour", exact: true }).click()
    await harbour.getByRole("textbox", { name: "Entry content" }).fill("Boats rock at the old quay.")
    await harbour.getByRole("textbox", { name: "Primary keys" }).fill("harbour\nquay\npier")
    await harbour.getByRole("textbox", { name: "Primary keys" }).blur()
    await page.getByRole("combobox", { name: "Position of Harbour" }).selectOption("at_depth:user")
    await page.getByRole("spinbutton", { name: "Depth of Harbour" }).fill("2")
    await page.getByRole("spinbutton", { name: "Trigger % of Harbour" }).fill("55")
    await page.getByRole("spinbutton", { name: "Trigger % of Harbour" }).blur()
    await expect
      .poll(
        async () =>
          (await admin((api) => api.OpenEditor({ refId: ref.id }))).drafts.filter((d) => d.status === "active").length
      )
      .toBe(6)
    await page.reload()
    await page.getByRole("button", { name: "Open Harbour", exact: true }).click()
    await expectTextBox(harbour.getByRole("textbox", { name: "Entry content" }), "Boats rock at the old quay.")
    // The opened entry's text has its edit history; settings like Trigger % have no controls of their own.
    await expect(harbour.getByRole("button", { name: "Edit history of Entry content", exact: true })).toBeVisible()
    await expect(harbour.getByRole("button", { name: /Trigger %$/ })).toHaveCount(0)
    await save(page)
    // History's comparison names the entry by its title.
    const history = await latestChanges(page)
    await expect(history.getByLabel("Revision changes")).toContainText("Entry “Harbour”")
    await history.getByRole("button", { name: "Close", exact: true }).click()
    const book = async () => (await admin((api) => api.OpenEditor({ refId: ref.id }))).doc as unknown as LorebookDoc
    expect((await book()).entries[0]).toMatchObject({
      uid: 0,
      content: "Boats rock at the old quay.",
      keys: ["harbour", "quay", "pier"],
      position: "at_depth",
      role: "user",
      depth: 2,
      probability: 55
    })
    const firstRevision = (await admin((api) => api.OpenEditor({ refId: ref.id }))).ref.headRevisionId

    // Delete one entry (restorable until saved), duplicate one, and add another.
    const more = async (title: string, action: string) => {
      await page.getByRole("button", { name: `More for ${title}`, exact: true }).click()
      await page.getByRole("menuitem", { name: action }).click()
    }
    await more("Fog", "Delete")
    await expect(page.getByText("Deleted, until you save:")).toBeVisible()
    await page.getByRole("button", { name: "Restore Fog", exact: true }).click()
    await expect(page.getByText("Deleted, until you save:")).toHaveCount(0)
    await expect
      .poll(async () =>
        (await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))).map((r) => r.content)
      )
      .not.toContain("null")
    await more("Harbour", "Delete")
    await more("Lamp", "Duplicate")
    await expect(page.getByRole("textbox", { name: "Title of Lamp (copy)", exact: true })).toBeFocused()
    await page.getByRole("button", { name: "Add entry", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Title of Untitled entry", exact: true })).toBeFocused()
    await page.keyboard.type("Gulls")
    const added = page.getByRole("group", { name: /^Lorebook entry/ }).first()
    await added.getByRole("textbox", { name: "Primary keys" }).fill("gull")
    await added.getByRole("textbox", { name: "Entry content" }).fill("Gulls gather on the roofs.")
    await save(page)
    expect((await book()).entries.map((e) => e.comment)).toEqual(["Lamp", "Fog", "Lamp (copy)", "Gulls"])

    // Copy an entry into another lorebook: saved there at once, that book's own drafts untouched.
    const other = await page.request.post(`${server().url}/library/import?name=Other ${width}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(JSON.stringify({ name: `Other ${width}`, entries: {} }))
    })
    const otherRef = (await other.json()).library.ref
    await more("Gulls", "Copy to another lorebook…")
    const copy = page.getByRole("dialog", { name: "Copy “Gulls” to another lorebook" })
    await copy.getByRole("button", { name: `Other ${width}` }).click()
    await copy.getByRole("button", { name: `Copy to Other ${width}` }).click()
    await expect(copy).toHaveCount(0)
    const otherBook = (await admin((api) => api.OpenEditor({ refId: otherRef.id }))).doc as unknown as LorebookDoc
    expect(otherBook.entries.map((e) => [e.comment, e.content])).toEqual([["Gulls", "Gulls gather on the roofs."]])
    await expect(saved(page)).toBeVisible()

    // Search and replace reaches closed entries and their keys.
    await page.getByRole("button", { name: "Search", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Search and replace" })
    await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("lamp")
    await dialog.getByRole("textbox", { name: "Replace with", exact: true }).fill("torch")
    await dialog.getByRole("button", { name: "Find", exact: true }).click()
    await expect(dialog.getByRole("status")).toHaveText("6 matches.")
    await dialog.getByRole("button", { name: "Replace all", exact: true }).click()
    await dialog.press("Escape")
    await save(page)
    expect((await book()).entries[0]).toMatchObject({ comment: "torch", keys: ["torch", "lantern"] })
    expect((await book()).entries[2]).toMatchObject({ comment: "torch (copy)" })

    // Export keeps working from the saved revision.
    const exported = await page.request.post(`${server().url}/library/export`, {
      headers: { origin: server().url },
      data: { refId: ref.id, format: "st-world-info" }
    })
    expect(exported.status()).toBe(200)
    expect(JSON.stringify(await exported.json())).toContain("Gulls gather on the roofs.")

    // An earlier revision brings the removed entry back.
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
    await page.getByRole("button", { name: "Open Harbour", exact: true }).click()
    await expectTextBox(harbour.getByRole("textbox", { name: "Entry content" }), "Boats rock at the old quay.")

    const dir = process.env.SCREENSHOT_DIR
    if (dir) {
      await mkdir(dir, { recursive: true })
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme })
        await page.screenshot({ animations: "disabled", path: join(dir, `lorebook-${width}-${colorScheme}.png`) })
        await harbour.getByRole("textbox", { name: "Primary keys" }).scrollIntoViewIfNeeded()
        await page.screenshot({ animations: "disabled", path: join(dir, `lorebook-list-${width}-${colorScheme}.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      }
    }
  })
}

test("find results go to a standalone entry's text and keys, even past the entry filter", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const response = await page.request.post(`${server().url}/library/import?name=Saltmarsh find.json`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(JSON.stringify(worldInfo("Saltmarsh find")))
  })
  expect(response.status()).toBe(200)
  const {
    library: { ref }
  } = await response.json()
  await page.goto(`${server().url}/library/${ref.id}`)
  // Hide the Lamp entry; going to its match must show it again, open.
  const search = page.getByRole("searchbox", { name: "Search titles, keys and content" })
  await search.fill("fog")
  await expect(page.getByRole("textbox", { name: "Title of Lamp" })).toHaveCount(0)
  const dialog = page.getByRole("dialog", { name: "Search and replace" })
  const find = async (text: string, target: RegExp) => {
    await page.getByRole("button", { name: "Search", exact: true }).click()
    await dialog.getByRole("textbox", { name: "Find", exact: true }).fill(text)
    await dialog.getByRole("button", { name: "Find", exact: true }).click()
    await dialog.getByRole("button", { name: target }).click()
  }
  await find("blue", /^Go to .*: Content$/)
  const content = page
    .getByRole("group", { name: "Lorebook entry 1" })
    .getByRole("textbox", { name: "Entry content", exact: true })
  await expect(content).toBeFocused()
  await expect
    .poll(() =>
      content.evaluate((e) =>
        (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null }).getSelection()?.toString()
      )
    )
    .toBe("blue")
  await search.fill("fog")
  await find("lantern", /^Go to .*: Primary key 2$/)
  const keys = page.getByRole("group", { name: "Lorebook entry 1" }).getByRole("textbox", { name: "Primary keys" })
  await expect(keys).toBeFocused()
  await expect
    .poll(() =>
      keys.evaluate((e) => {
        const input = e as HTMLTextAreaElement
        return { text: input.value.slice(input.selectionStart, input.selectionEnd), start: input.selectionStart }
      })
    )
    .toEqual({ text: "lantern", start: 5 })
})

test("a 400-entry book: rows virtualized, cells edited in place, new entries kept in view, a move, the diff by title", async ({
  page
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // A synthetic book of 400 entries, as ST's world info file holds them.
  const entries = Object.fromEntries(
    Array.from({ length: 400 }, (_, uid) => [
      uid,
      { uid, key: [`key${uid}`], comment: `Place ${uid}`, content: `Text of place ${uid}.`, order: uid }
    ])
  )
  const imported = async (name: string, book: object) => {
    const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(JSON.stringify({ name, ...book }))
    })
    expect(response.status()).toBe(200)
    return (await response.json()).library.ref as { id: string }
  }
  const ref = await imported("Big book", { entries })
  const other = await imported("Second book", { entries: {} })
  await page.goto(`${server().url}/library/${ref.id}`)
  const list = page.getByRole("list", { name: "Entries" })
  await expect(list.getByRole("textbox", { name: "Title of Place 399", exact: true })).toBeVisible()
  // Only the rows near the view are in the page.
  expect(await list.getByRole("listitem").count()).toBeLessThan(60)
  await expect(page.getByText("Not added to any chat yet.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Where it's used" })).toContainText("400 entries")

  // Find an entry, then change its strategy, position, depth, order and trigger % in its row.
  await page.getByRole("searchbox", { name: "Search titles, keys and content" }).fill("key123")
  await expect(page.getByText("1 of 400 entries")).toBeVisible()
  await page.getByRole("combobox", { name: "Strategy of Place 123" }).selectOption("constant")
  await page.getByRole("combobox", { name: "Position of Place 123" }).selectOption("at_depth:assistant")
  await page.getByRole("spinbutton", { name: "Depth of Place 123" }).fill("6")
  await page.getByRole("spinbutton", { name: "Order of Place 123" }).fill("900")
  await page.getByRole("spinbutton", { name: "Trigger % of Place 123" }).fill("40")
  await page.getByRole("spinbutton", { name: "Trigger % of Place 123" }).blur()
  // The entry's text opens large, over the page, as a card's fields do.
  await page.getByRole("button", { name: "Open Place 123", exact: true }).click()
  await page
    .getByRole("group", { name: "Lorebook entry 123", exact: true })
    .getByRole("button", { name: "Open Entry content large", exact: true })
    .click()
  const large = page.getByRole("dialog", { name: "Entry content", exact: true })
  await large.getByRole("textbox").click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(" The bridge is out.")
  await large.getByRole("button", { name: "Done", exact: true }).click()
  await expect(
    page.getByRole("group", { name: "Lorebook entry 123", exact: true }).getByRole("textbox", { name: "Entry content" })
  ).toHaveValue("Text of place 123. The bridge is out.")
  await page.getByRole("button", { name: "Close Place 123", exact: true }).click()

  // A new entry and then a copy of it both lead the table, the newest first.
  await page.getByRole("searchbox", { name: "Search titles, keys and content" }).fill("")
  await page.getByRole("button", { name: "Add entry", exact: true }).click()
  await page.keyboard.type("Lighthouse")
  await page.getByRole("button", { name: "More for Lighthouse", exact: true }).click()
  await page.getByRole("menuitem", { name: "Duplicate" }).click()
  const titles = () =>
    list
      .getByRole("textbox", { name: /^Title of / })
      .evaluateAll((inputs) => inputs.slice(0, 3).map((input) => (input as HTMLInputElement).value))
  await expect.poll(titles).toEqual(["Lighthouse (copy)", "Lighthouse", "Place 123"])

  // Move an entry to another book: saved there at once; here its removal waits for Save.
  await page.getByRole("button", { name: "More for Place 398", exact: true }).click()
  await page.getByRole("menuitem", { name: "Move to another lorebook…" }).click()
  const move = page.getByRole("dialog", { name: "Move “Place 398” to another lorebook" })
  await move.getByRole("button", { name: "Second book" }).click()
  await move.getByRole("button", { name: "Move to Second book" }).click()
  await expect(move).toHaveCount(0)
  const doc = async (id: string) =>
    (await admin((api) => api.OpenEditor({ refId: id as never }))).doc as unknown as LorebookDoc
  expect((await doc(other.id)).entries.map((e) => e.comment)).toEqual(["Place 398"])
  await expect(page.getByRole("status").filter({ hasText: "Deleted, until you save:" })).toContainText("Place 398")

  // Save asks nothing; History's comparison names entries by title, the removed one too, and
  // the fields as the table does.
  await save(page)
  const history = await latestChanges(page)
  const labels = history.getByLabel("Revision changes").locator("summary")
  await expect
    .poll(() => labels.allTextContents())
    .toEqual(
      expect.arrayContaining([
        "Entry “Lighthouse”",
        "Entry “Lighthouse (copy)”",
        "Entry “Place 123”: Strategy (constant)",
        "Entry “Place 123”: Position",
        "Entry “Place 123”: Position (role)",
        "Entry “Place 123”: Depth",
        "Entry “Place 123”: Order",
        "Entry “Place 123”: Trigger %",
        "Entry “Place 123”: Content"
      ])
    )
  // History names a removed entry by its title, from the revision before.
  expect(await labels.allTextContents()).toContain("Entry “Place 398”")
  await history.getByRole("button", { name: "Close", exact: true }).click()
  const book = await doc(ref.id)
  expect(book.entries).toHaveLength(401)
  expect(book.entries.find((e) => e.uid === 123)).toMatchObject({
    constant: true,
    position: "at_depth",
    role: "assistant",
    depth: 6,
    order: 900,
    probability: 40,
    content: "Text of place 123. The bridge is out."
  })
  expect(book.entries.some((e) => e.comment === "Place 398")).toBe(false)
})
