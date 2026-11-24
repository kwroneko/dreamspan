// A card field in its own tab (owner, 2026-11-23): the field's expand button opens it as a tab
// titled "<card> · <field>", its box filling the tab with its scrollbar inside; it's the same
// text and draft as the field in the editor, live both ways and after a reload; the button's
// right-click menu opens it beside; a second field opens where a field is showing. On a phone
// it's a full page and Back returns. A card on a card source, not added, opens in the full
// editor for reading only, its fields openable in tabs, with Add to my cards. A chat's summary and
// its own note open as tabs the same way. Synthetic cards
// only; the archive is the fake one, so nothing reaches cardex.
import { createServer } from "node:net"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, startServer, withAdmin } from "./support/server.ts"
import { noteText } from "./support/notes.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { level1 } from "./support/summaries.ts"
import { textBoxValue } from "./support/textbox.ts"

test.setTimeout(180_000)

const server = serverPerFile(withAdmin)
const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, run)

const LONG = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: the harbour at dusk.`).join("\n")
// Each item carries its hover text after the label.
const MENU = [/^Open(?! beside| in)/, /^Open beside/, /^Open in a new browser tab/]

const append = async (box: Locator, text: string) => {
  await expect(box).toBeEditable()
  await box.click()
  await box.press("ControlOrMeta+End")
  await box.page().keyboard.insertText(text)
}

/** The tab's own box: as tall as the tab leaves it, scrolling inside, nothing around it scrolling. */
const expectFillsAndScrollsInside = async (frame: Locator) => {
  const measured = await frame.locator("[data-field-tab]").evaluate((tab) => {
    const host = [...tab.querySelectorAll("div")].find((element) => element.shadowRoot)!
    const scroller = host.shadowRoot!.querySelector(".cm-scroller") as HTMLElement
    const frame = tab.closest("[data-frame]")!
    const scrolling: Array<string> = []
    for (let at: Element | null = tab; at && at !== frame; at = at.parentElement)
      if (at.scrollHeight > at.clientHeight + 1 && getComputedStyle(at).overflowY !== "visible")
        scrolling.push(at.className)
    return {
      inner: scroller.scrollHeight - scroller.clientHeight,
      gap: frame.getBoundingClientRect().bottom - tab.getBoundingClientRect().bottom,
      height: tab.getBoundingClientRect().height,
      scrolling
    }
  })
  expect(measured.inner).toBeGreaterThan(200)
  expect(measured.scrolling).toEqual([])
  expect(measured.gap).toBeGreaterThanOrEqual(0)
  expect(measured.gap).toBeLessThan(40)
  expect(measured.height).toBeGreaterThan(300)
}

const openCard = async (page: Page, name: string) => {
  const card = await admin((api) => api.CreateCard({ label: name, name }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  return card
}

test("a reused card field preview binds to the new card's store", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { chat, a, b } = await admin((api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Preview Alpha", name: "Preview Alpha" })
      const b = yield* api.CreateCard({ label: "Preview Beta", name: "Preview Beta" })
      const chat = yield* api.CreateChat({ title: "Card previews" })
      for (const card of [a, b])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      return { chat, a, b }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}?panel=card:${a.entityId}`)
  const panel = page.getByRole("tabpanel", { name: "Definition", exact: true })
  const link = panel.getByRole("link", { name: "Open Description in a tab", exact: true })
  await link.click()
  const frame = page.locator("[data-frame]")
  const preview = frame.locator("[data-tab][data-preview]")
  await expect(preview).toContainText("Preview Alpha · Description")
  const tabId = (await preview.getAttribute("data-tab"))!

  await panelTab(page, "Preview Beta")
  await link.click()
  await expect(preview).toHaveAttribute("data-tab", tabId)
  await expect(preview).toContainText("Preview Beta · Description")
  await expect(page).toHaveURL(new RegExp(`/library/${b.id}/field`))
  const field = frame.getByRole("textbox", { name: "Description", exact: true })
  await field.fill("Written only to Beta.")
  await expect
    .poll(() => textBoxValue(panel.getByRole("textbox", { name: "Description", exact: true })))
    .toBe("Written only to Beta.")
  await panelTab(page, "Preview Alpha")
  await expect.poll(() => textBoxValue(panel.getByRole("textbox", { name: "Description", exact: true }))).toBe("")
})

test("1440: the expand button opens the field as a tab beside, the same text live both ways and after a reload", async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const card = await openCard(page, "Tabbed")
  const frames = page.locator("[data-frame]")
  const inline = page.getByRole("textbox", { name: "Description", exact: true })
  await inline.fill(LONG)
  const expand = page.getByRole("link", { name: "Open Description in a tab", exact: true })
  await inline.click()
  await expand.hover()
  await expect(page.getByText("Opens Description in its own tab.", { exact: true })).toBeVisible()
  // The shared open menu, as the request inspector's links have it.
  await expand.click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Actions for Open Description in a tab", exact: true })
  await expect(menu.getByRole("menuitem")).toHaveText(MENU)
  await expectLayout(page, info, "field-link-menu-1440", { scope: '[role="menu"]' })
  await menu.getByRole("menuitem", { name: "Open beside", exact: true }).click()

  await expect(frames).toHaveCount(2)
  const editor = frames.nth(0)
  const fields = frames.nth(1)
  const own = fields.getByRole("textbox", { name: "Description", exact: true })
  await expect(own).toBeVisible()
  await expect(fields.locator("[data-tab]")).toHaveCount(1)
  await expect(fields.locator("[data-tab]")).toContainText("Tabbed · Description")
  await expect(page.getByRole("heading", { name: "Tabbed · Description", exact: true })).toBeVisible()
  await expectFillsAndScrollsInside(fields)
  await expectLayout(page, info, "field-tab-1440", { scope: "[data-field-tab]" })

  // One text: typed in either, shown in the other at once.
  const inlineHere = editor.getByRole("textbox", { name: "Description", exact: true })
  await append(own, " Typed in its tab.")
  await expect.poll(() => textBoxValue(inlineHere)).toContain("Typed in its tab.")
  await append(inlineHere, " Typed in the editor.")
  await expect.poll(() => textBoxValue(own)).toContain("Typed in the editor.")

  // A second field opens where a field is showing: the editor's frame keeps its one tab.
  const scenario = editor.getByRole("textbox", { name: "Scenario", exact: true })
  await scenario.click()
  await editor.getByRole("link", { name: "Open Scenario in a tab", exact: true }).click()
  await expect(fields.locator("[data-tab]")).toHaveCount(2)
  await expect(fields.getByRole("textbox", { name: "Scenario", exact: true })).toBeVisible()
  await expect(editor.locator("[data-tab]")).toHaveCount(1)
  await expect(frames).toHaveCount(2)
  await expectLayout(page, info, "field-tabs-strip-1440", { scope: "[data-tab-strip]" })

  // On the server, then back after a reload: the tabs and the text.
  await expect
    .poll(
      () =>
        admin((api) =>
          Effect.map(
            api.OpenEditor({ refId: card.id }),
            (snapshot) => snapshot.drafts.find((draft) => draft.key.field === '["description"]')?.content ?? ""
          )
        ),
      { timeout: 15_000 }
    )
    .toContain("Typed in the editor.")
  await page.reload()
  await expect(frames).toHaveCount(2)
  await frames.nth(1).locator("[data-tab]").filter({ hasText: "Description" }).click()
  const again = frames.nth(1).getByRole("textbox", { name: "Description", exact: true })
  await expect.poll(() => textBoxValue(again)).toContain("Typed in its tab. Typed in the editor.")
  await expectFillsAndScrollsInside(frames.nth(1))
})

test("390: the field's tab is a full page, and Back returns to the editor", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const card = await openCard(page, "Phone tab")
  const inline = page.getByRole("textbox", { name: "Description", exact: true })
  await inline.fill(LONG)
  await inline.click()
  await page.getByRole("link", { name: "Open Description in a tab", exact: true }).click()
  await expect(page).toHaveURL(/\/library\/[^/]+\/field\?/)
  const frame = page.locator("[data-frame]")
  await expect(frame).toHaveCount(1)
  const own = frame.getByRole("textbox", { name: "Description", exact: true })
  await expect(own).toBeVisible()
  await expectFillsAndScrollsInside(frame)
  await expectLayout(page, info, "field-tab-390", { scope: "[data-field-tab]" })
  await append(own, " On the phone.")
  await page.goBack()
  // The field stays a tab of the workbench (its wb list); the page is the editor again.
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/library/${card.id}`)
  await expect
    .poll(() => textBoxValue(page.getByRole("textbox", { name: "Description", exact: true })))
    .toContain("On the phone.")
})

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

for (const width of [1440, 390])
  test(`${width}: a card on the archive opens in the full editor for reading, its fields in tabs, until it's added`, async ({
    page
  }, info) => {
    const port = await freePort()
    const own = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
    try {
      const listed = (await (await fetch(`http://127.0.0.1:${port}/api/v1/search?limit=5&sort=name`)).json()) as {
        items: ReadonlyArray<{ slug: string; name: string }>
      }
      const card = listed.items[0]!
      await apiLogin(page.request, own, ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${own.url}/sources/cardex/cards/${encodeURIComponent(card.slug)}`)
      const open = page.getByRole("link", { name: "Open in the editor", exact: true })
      await open.hover()
      await expect(
        page.getByText("Shows every field in the editor, for reading. Add it to your cards to edit it.", {
          exact: true
        })
      ).toBeVisible()
      await open.click()
      await expect(page).toHaveURL(/\/library\/src%3Acardex%3A/)
      const editor = page.locator("[data-read-only-card]")
      await expect(editor.getByRole("heading", { name: card.name, exact: true })).toBeVisible()
      await expect(editor.getByRole("button", { name: "Add to my cards", exact: true })).toBeVisible()
      // Nothing to save, and nothing typed is taken.
      await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0)
      const description = editor.getByRole("textbox", { name: "Description", exact: true })
      await expect.poll(() => textBoxValue(description)).toContain("a synthetic character made for testing")
      const before = await textBoxValue(description)
      await expect(description).not.toBeEditable()
      await description.click()
      await page.keyboard.insertText("typed")
      expect(await textBoxValue(description)).toBe(before)
      await expect(editor.getByRole("tab", { name: "Notes", exact: true })).toHaveCount(0)
      await expectLayout(page, info, `source-card-editor-${width}`, { scope: "[data-read-only-card]" })

      // Each field opens in its own tab, also for reading.
      await description.click()
      await editor.getByRole("link", { name: "Open Description in a tab", exact: true }).click()
      const tab = page.locator("[data-field-tab]")
      const text = tab.getByRole("textbox", { name: "Description", exact: true })
      await expect.poll(() => textBoxValue(text)).toBe(before)
      await expect(text).not.toBeEditable()
      await expect(page.getByRole("heading", { name: `${card.name} · Description`, exact: true })).toBeVisible()
      await expectLayout(page, info, `source-card-field-${width}`, { scope: "[data-field-tab]" })

      // Added: the tab shows the user's own card, which edits.
      await page.goBack()
      await page.locator("[data-read-only-card]").getByRole("button", { name: "Add to my cards", exact: true }).click()
      await expect(page).not.toHaveURL(/src%3Acardex/)
      await expect(page.locator("[data-read-only-card]")).toHaveCount(0)
      await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeEditable()
    } finally {
      await own.stop()
    }
  })

// A chat's own texts keep their expand as tabs too (owner, 2026-11-23): a summary's text and a
// chat's own note, each the same draft as its box in the chat panel.
const summarizedChat = async (page: Page, title: string) => {
  const fixture = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A harbor." })
      if (sent._tag !== "Posted") throw new Error("Expected a posted message")
      return { chatId: chat.id, entry: sent.entry }
    })
  )
  await level1(server().dataDir, fixture.chatId, [fixture.entry], "Original summary.")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${fixture.chatId}`)
  await page.locator("article[data-slot]").first().waitFor()
  return fixture.chatId
}

const SUMMARY_BOX = /^Text of the summary of message 1$/
const SUMMARY_LINK = "Open Text of the summary of message 1 in a tab"

const editSummary = async (page: Page) => {
  const panel = await openPanel(page, "Summaries")
  const box = panel.getByRole("textbox", { name: SUMMARY_BOX })
  if ((await box.count()) === 0) await panel.getByRole("button", { name: /Edit the summary/ }).click()
  await expect(box).toBeEditable()
  return { panel, box }
}

const ownNote = async (page: Page) => {
  const panel = await openPanel(page, "Notes")
  const own = panel.getByRole("region", { name: "This chat's notes" })
  if ((await panel.getByRole("region", { name: "Note Note" }).count()) === 0)
    await own.getByRole("button", { name: "Add note", exact: true }).click()
  const box = await noteText(panel, "Note")
  await expect(box).toBeEditable()
  return { panel, box }
}

test("1440: a summary's text and a chat's own note open beside the chat, live both ways and after a reload", async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const chatId = await summarizedChat(page, "Harbour log")
  const frames = page.locator("[data-frame]")
  const summary = await editSummary(page)
  await summary.box.fill(LONG)
  await summary.box.click()
  const link = summary.panel.getByRole("link", { name: SUMMARY_LINK, exact: true })
  await link.hover()
  await expect(page.getByText("Opens Text of the summary of message 1 in its own tab.", { exact: true })).toBeVisible()
  await link.click({ button: "right" })
  const menu = page.getByRole("menu", { name: `Actions for ${SUMMARY_LINK}`, exact: true })
  await expect(menu.getByRole("menuitem")).toHaveText(MENU)
  await menu.getByRole("menuitem", { name: "Open beside", exact: true }).click()

  await expect(frames).toHaveCount(2)
  const chat = frames.nth(0)
  const texts = frames.nth(1)
  await expect(texts.locator("[data-tab]")).toContainText("Summary of message 1")
  const own = texts.locator("[data-field-tab]").getByRole("textbox", { name: SUMMARY_BOX })
  await expect(own).toBeEditable()
  // The tab focused is the page's URL: the summary's, under its chat.
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/chats/${chatId}/summaries/[^/]+/text$`))
  await expectFillsAndScrollsInside(texts)
  await expectLayout(page, info, "summary-tab-1440", { scope: "[data-field-tab]" })
  await append(own, " Typed in its tab.")
  // The chat panel is its own column beside the frames.
  const inPanel = summary.panel.getByRole("textbox", { name: SUMMARY_BOX })
  await expect.poll(() => textBoxValue(inPanel)).toContain("Typed in its tab.")
  await append(inPanel, " Typed in the panel.")
  await expect.poll(() => textBoxValue(own)).toContain("Typed in the panel.")

  // The chat's own note: a plain click opens it where the summary's tab is, the chat keeping its frame.
  const note = await ownNote(page)
  await note.box.fill(LONG)
  await note.box.click()
  await note.panel.getByRole("link", { name: "Open Text of Note in a tab", exact: true }).click()
  await expect(frames).toHaveCount(2)
  await expect(chat.locator("[data-tab]")).toHaveCount(1)
  await expect(texts.locator("[data-tab]")).toHaveCount(2)
  const noteTab = texts.locator("[data-field-tab]").getByRole("textbox", { name: "Text of Note", exact: true })
  await expect(noteTab).toBeEditable()
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/chats/${chatId}/notes/[^/]+/field$`))
  await expectFillsAndScrollsInside(texts)
  await expectLayout(page, info, "chat-note-tab-1440", { scope: "[data-field-tab]" })
  await append(noteTab, " Noted in its tab.")
  const noteInPanel = note.panel.getByRole("textbox", { name: "Text of Note", exact: true })
  await expect.poll(() => textBoxValue(noteInPanel)).toContain("Noted in its tab.")
  await append(noteInPanel, " Noted in the panel.")
  await expect.poll(() => textBoxValue(noteTab)).toContain("Noted in the panel.")
  await expectLayout(page, info, "chat-text-tabs-strip-1440", { scope: "[data-tab-strip]" })

  // Kept, then back after a reload: both tabs and their text.
  await page.waitForTimeout(2500)
  await page.reload()
  await expect(frames).toHaveCount(2)
  await expect
    .poll(() => textBoxValue(frames.nth(1).locator("[data-field-tab]").getByRole("textbox").first()))
    .toContain("Noted in its tab. Noted in the panel.")
  await frames.nth(1).locator("[data-tab]").filter({ hasText: "Summary of message 1" }).click()
  await expect
    .poll(() => textBoxValue(frames.nth(1).locator("[data-field-tab]").getByRole("textbox", { name: SUMMARY_BOX })))
    .toContain("Typed in its tab. Typed in the panel.")
})

test("390: a summary's text and a chat's own note are full pages, and Back returns to the chat", async ({
  page
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const chatId = await summarizedChat(page, "Phone log")
  const frame = page.locator("[data-frame]")

  const summary = await editSummary(page)
  await summary.box.fill(LONG)
  await summary.box.click()
  await summary.panel.getByRole("link", { name: SUMMARY_LINK, exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/chats/${chatId}/summaries/[^/]+/text$`))
  await expect(frame).toHaveCount(1)
  const own = page.locator("[data-field-tab]").getByRole("textbox", { name: SUMMARY_BOX })
  await expect(own).toBeEditable()
  await expectFillsAndScrollsInside(frame)
  await expectLayout(page, info, "summary-tab-390", { scope: "[data-field-tab]" })
  await append(own, " On the phone.")
  await page.goBack()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/chats/${chatId}`)
  const back = await editSummary(page)
  await expect.poll(() => textBoxValue(back.box)).toContain("On the phone.")

  const note = await ownNote(page)
  await note.box.fill(LONG)
  await note.box.click()
  await note.panel.getByRole("link", { name: "Open Text of Note in a tab", exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/chats/${chatId}/notes/[^/]+/field$`))
  await expect(frame).toHaveCount(1)
  const noteTab = page.locator("[data-field-tab]").getByRole("textbox", { name: "Text of Note", exact: true })
  await expect(noteTab).toBeEditable()
  await expectFillsAndScrollsInside(frame)
  await expectLayout(page, info, "chat-note-tab-390", { scope: "[data-field-tab]" })
  await append(noteTab, " Noted on the phone.")
  await page.goBack()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/chats/${chatId}`)
  const noteBack = await ownNote(page)
  await expect.poll(() => textBoxValue(noteBack.box)).toContain("Noted on the phone.")
})
