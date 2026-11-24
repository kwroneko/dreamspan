// The editors' header switchers at scale (owner, 2026-11-06: the plain select was "unusable
// with any large number of them"): 300 prompt presets, 300 lorebooks and 2,000 cards, all made
// up here. Each switcher opens its kind's complete picker with only the rows in view mounted,
// filters as you type, and chooses by keyboard (Down, Enter) and by mouse; the preset editor's
// header and the side panel's Prompt preset tab open the same picker. Sorts are the account's,
// card rows have portraits, and kinds with a way to make one end with a New row.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const PRESETS = 300
const LOREBOOKS = 300
const CARDS = 2000
const pad = (i: number) => String(i).padStart(4, "0")

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

interface Fixtures {
  readonly presets: ReadonlyArray<RefId>
  readonly books: ReadonlyArray<RefId>
  readonly cards: ReadonlyArray<RefId>
  readonly personas: ReadonlyArray<RefId>
  readonly notes: ReadonlyArray<RefId>
  readonly snippets: ReadonlyArray<RefId>
  readonly chat: string
}
let fixtures: Fixtures

test.beforeAll(async () => {
  test.setTimeout(900_000)
  const presets = await admin((api) =>
    Effect.forEach(
      Array.from({ length: PRESETS }, (_, i) => i),
      (i) => api.CreatePreset({ label: `Preset ${pad(i)}` }).pipe(Effect.map((ref) => ref.id))
    )
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const books: Array<RefId> = []
  for (let i = 0; i < LOREBOOKS; i++) {
    const name = `Book ${pad(i)}`
    const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
      method: "POST",
      body: JSON.stringify({ name, entries: { 0: { uid: 0, key: ["harbor"], content: "Made-up lore.", order: 10 } } }),
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" }
    })
    expect(response.status).toBe(200)
    books.push(((await response.json()) as { library: { ref: { id: RefId } } }).library.ref.id)
  }
  fixtures = await admin((api) =>
    Effect.gen(function* () {
      const cards = yield* Effect.forEach(
        Array.from({ length: CARDS }, (_, i) => i),
        (i) => api.CreateCard({ label: `Card ${pad(i)}`, name: `Card ${pad(i)}` }).pipe(Effect.map((ref) => ref.id))
      )
      const personas: Array<RefId> = []
      for (const name of ["Persona Wren", "Persona Moss"]) {
        const persona = yield* api.CreateCard({ label: name, name })
        yield* api.SetPersona({ entityId: persona.entityId, persona: true })
        personas.push(persona.id)
      }
      const notes: Array<RefId> = []
      for (const title of ["Note harbor", "Note lantern", "Note river"])
        notes.push((yield* api.CreateSharedNote({ title, content: "Made-up note." })).id)
      const snippets: Array<RefId> = []
      for (const title of ["Snippet harbor", "Snippet lantern", "Snippet river"])
        snippets.push((yield* api.CreateSnippet({ chatId: null, title, content: "Made-up snippet." })).ref.id)
      const chat = yield* api.CreateChat({ title: "Switcher chat" })
      return { presets, books, cards, personas, notes, snippets, chat: chat.id }
    })
  )
})

interface Kind {
  readonly name: string
  readonly path: (f: Fixtures) => string
  readonly trigger: string
  readonly dialog: string
  readonly search: string
  /** Typed into the filter: it leaves exactly `target`. */
  readonly query: string
  readonly target: (f: Fixtures) => RefId
  readonly targetName: string
  /** A second choice, made with the mouse. */
  readonly mouseQuery: string
  readonly mouseTarget: (f: Fixtures) => RefId
  readonly mouseName: string
}

const KINDS: ReadonlyArray<Kind> = [
  {
    name: "preset",
    path: (f) => `/library/${f.presets[0]}`,
    trigger: "Switch preset",
    dialog: "Prompt preset",
    search: "Find a prompt preset",
    query: "preset 0137",
    target: (f) => f.presets[137]!,
    targetName: "Preset 0137",
    mouseQuery: "0299",
    mouseTarget: (f) => f.presets[299]!,
    mouseName: "Preset 0299"
  },
  {
    name: "lorebook",
    path: (f) => `/library/${f.books[0]}`,
    trigger: "Switch lorebook",
    dialog: "Lorebook",
    search: "Find a lorebook",
    query: "book 0211",
    target: (f) => f.books[211]!,
    targetName: "Book 0211",
    mouseQuery: "0042",
    mouseTarget: (f) => f.books[42]!,
    mouseName: "Book 0042"
  },
  {
    name: "card",
    path: (f) => `/library/${f.cards[0]}`,
    trigger: "Switch card",
    dialog: "Card",
    search: "Find a card",
    query: "card 1873",
    target: (f) => f.cards[1873]!,
    targetName: "Card 1873",
    mouseQuery: "0999",
    mouseTarget: (f) => f.cards[999]!,
    mouseName: "Card 0999"
  },
  {
    name: "persona",
    path: (f) => `/library/${f.personas[0]}`,
    trigger: "Switch persona",
    dialog: "Persona",
    search: "Find a card",
    query: "moss",
    target: (f) => f.personas[1]!,
    targetName: "Persona Moss",
    mouseQuery: "wren",
    mouseTarget: (f) => f.personas[0]!,
    mouseName: "Persona Wren"
  },
  {
    name: "note",
    path: (f) => `/library/${f.notes[0]}`,
    trigger: "Switch note",
    dialog: "Note",
    search: "Find a note",
    query: "note lantern",
    target: (f) => f.notes[1]!,
    targetName: "Note lantern",
    mouseQuery: "note river",
    mouseTarget: (f) => f.notes[2]!,
    mouseName: "Note river"
  },
  {
    name: "snippet",
    path: (f) => `/library/${f.snippets[0]}?focus=snippet`,
    trigger: "Switch snippet",
    dialog: "Snippet",
    search: "Find a snippet",
    query: "snippet lantern",
    target: (f) => f.snippets[1]!,
    targetName: "Snippet lantern",
    mouseQuery: "snippet river",
    mouseTarget: (f) => f.snippets[2]!,
    mouseName: "Snippet river"
  }
]

const settle = async (page: Page) =>
  expect(page.getByRole("status").filter({ hasText: /^(Loading|Opening)/ })).toHaveCount(0)

const trigger = (page: Page, kind: Kind) => page.getByRole("button", { name: kind.trigger, exact: true })

/** Opens the switcher; returns how long until its filter has focus and its rows show. */
const openSwitcher = async (page: Page, kind: Kind) => {
  await expect(trigger(page, kind)).toBeVisible()
  const started = Date.now()
  await trigger(page, kind).click()
  const dialog = page.getByRole("dialog", { name: kind.dialog, exact: true })
  await expect(dialog.getByRole("searchbox", { name: kind.search })).toBeFocused()
  await expect(dialog.getByRole("radio").first()).toBeVisible()
  return { dialog, ms: Date.now() - started }
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`header switchers at scale at ${width}, ${theme}`, async ({ page }, info) => {
      test.setTimeout(300_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const timings: Array<{ kind: string; ms: number; mounted: number }> = []
      for (const kind of KINDS) {
        await page.goto(`${server().url}${kind.path(fixtures)}`)
        await settle(page)
        const { dialog, ms } = await openSwitcher(page, kind)
        // Only the rows in view (and a few more) are in the page, however many there are.
        const mounted = await dialog.locator("[data-picker-row]").count()
        expect(mounted).toBeLessThanOrEqual(60)
        // Creation stays at the list's end, including the windowed lorebook list.
        if (["lorebook", "note", "persona"].includes(kind.name)) {
          const create = dialog.getByRole("button").last()
          await expect(create).toHaveAccessibleName(`New ${kind.name}…`)
          expect(
            await create.evaluate((button) => {
              const list = button.closest('[role="dialog"]')!.querySelector('[role="radiogroup"]')!
              return Boolean(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)
            })
          ).toBe(true)
        }
        timings.push({ kind: kind.name, ms, mounted })
        expect(ms).toBeLessThan(3000)
        await page.mouse.move(0, 899)
        await page.screenshot({ path: info.outputPath(`${kind.name}-${width}-${theme}.png`) })
        if (process.env.LAYOUT_AUDIT) {
          await expectLayout(page, info, `switcher-${kind.name}-${width}-${theme}`, { scope: '[role="dialog"]' })
          await expectLayout(page, info, `switcher-header-${kind.name}-${width}-${theme}`, {
            scope: "[data-center-header]"
          })
        }
        // Filters as you type; Down goes to the first row, Enter takes it.
        const search = dialog.getByRole("searchbox", { name: kind.search })
        await search.pressSequentially(kind.query)
        await expect(dialog.getByRole("radio")).toHaveCount(1)
        await expect(dialog.getByRole("radio", { name: kind.targetName, exact: true })).toBeVisible()
        await search.press("ArrowDown")
        await expect(dialog.getByRole("radio", { name: kind.targetName, exact: true })).toBeFocused()
        await page.keyboard.press("Enter")
        await expect(page).toHaveURL(new RegExp(kind.target(fixtures)))
        await expect(trigger(page, kind)).toContainText(kind.targetName)
        await settle(page)
        // The mouse: filter, then click the row.
        const again = await openSwitcher(page, kind)
        await again.dialog.getByRole("searchbox", { name: kind.search }).fill(kind.mouseQuery)
        await again.dialog.getByRole("radio", { name: kind.mouseName, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(kind.mouseTarget(fixtures)))
        await expect(trigger(page, kind)).toContainText(kind.mouseName)
      }
      const folder = process.env.LAYOUT_AUDIT_WORK ?? info.outputDir
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `switcher-timings-${width}-${theme}.json`), JSON.stringify(timings, null, 2))
    })

test("arrow keys walk a long list and the preset editor's picker is the side panel's", async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const preset = KINDS[0]!
  await page.goto(`${server().url}/library/${fixtures.presets[0]}`)
  await settle(page)
  let { dialog } = await openSwitcher(page, preset)
  // Down from the filter lands on the preset shown, then walks on past the rows first mounted.
  await page.keyboard.press("ArrowDown")
  await expect(dialog.getByRole("radio", { name: "Preset 0000", exact: true })).toBeFocused()
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown")
  await expect(dialog.getByRole("radio", { name: "Preset 0040", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(dialog.getByRole("radio", { name: "Preset 0039", exact: true })).toBeFocused()
  const header = await dialog
    .getByRole("group", { name: "Show presets", exact: true })
    .getByRole("button")
    .allTextContents()
  expect(header).toEqual(["Name", "Modified", "Used", "Archived"])
  // Archive from the header's picker: the row leaves for Archived, nothing chosen or closed.
  await dialog.getByRole("button", { name: "Archive Preset 0039", exact: true }).click()
  await expect(dialog.getByRole("status")).toContainText("Archived “Preset 0039”")
  await expect(dialog.getByRole("radio", { name: "Preset 0039", exact: true })).toHaveCount(0)
  await dialog
    .getByRole("group", { name: "Show presets", exact: true })
    .getByRole("button", { name: /^Archived/ })
    .click()
  await expect(dialog.getByRole("radio", { name: "Preset 0039", exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Unarchive Preset 0039", exact: true }).click()
  await expect(dialog.getByRole("radio", { name: "Preset 0039", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(new RegExp(fixtures.presets[0]!))

  // The chat's Prompt preset tab: the same picker, with the same views.
  await page.goto(`${server().url}/chats/${fixtures.chat}`)
  await openPanel(page, "Prompt preset")
  await page.getByRole("button", { name: /^Prompt preset for the next reply/ }).click()
  dialog = page.getByRole("dialog", { name: "Prompt preset", exact: true })
  await expect(dialog.getByRole("searchbox", { name: "Find a prompt preset" })).toBeFocused()
  expect(
    await dialog.getByRole("group", { name: "Show presets", exact: true }).getByRole("button").allTextContents()
  ).toEqual(header)
  expect(await dialog.locator("[data-picker-row]").count()).toBeLessThanOrEqual(60)
})

test("preset keyboard targets use the entire sorted list from the middle", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${fixtures.presets[150]}`)
  const { dialog } = await openSwitcher(page, KINDS[0]!)
  const search = dialog.getByRole("searchbox", { name: "Find a prompt preset" })
  const row = (name: string) => dialog.getByRole("radio", { name, exact: true })
  await search.press("ArrowDown")
  await expect(row("Preset 0150")).toBeFocused()
  await page.keyboard.press("End")
  await expect(row("Preset 0299")).toBeFocused()
  await page.keyboard.press("Home")
  await expect(row("Preset 0000")).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(search).toBeFocused()
  await search.press("ArrowDown")
  await expect(row("Preset 0150")).toBeFocused()
  await page.keyboard.press("End")
  await expect(row("Preset 0000")).toHaveCount(0)
  await search.press("Enter")
  await expect(page).toHaveURL(new RegExp(fixtures.presets[0]!))
})

test("sorts follow the account, card rows show portraits, and New rows make and open one", async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const [, lorebook, card, , , snippet] = KINDS as [Kind, Kind, Kind, Kind, Kind, Kind]

  // A lorebook switcher's sort is the account's, kept on the server, not in this browser.
  await page.goto(`${server().url}/library/${fixtures.books[0]}`)
  await settle(page)
  let { dialog } = await openSwitcher(page, lorebook)
  const sorts = dialog.getByRole("group", { name: "Sort lorebooks", exact: true })
  await sorts.getByRole("button", { name: "Modified", exact: true }).click()
  await expect(sorts.getByRole("button", { name: "Modified", exact: true })).toHaveAttribute("aria-pressed", "true")
  // Lorebooks now share their creation dialog with the Library and attachment pickers.
  await expect(dialog.getByRole("button", { name: "New lorebook…", exact: true })).toBeVisible()
  await expect
    .poll(() => admin((api) => api.GetDisplayPrefs({}).pipe(Effect.map((prefs) => prefs.lorebookSort))))
    .toBe("modified")
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await settle(page)
  ;({ dialog } = await openSwitcher(page, lorebook))
  await expect(
    dialog.getByRole("group", { name: "Sort lorebooks", exact: true }).getByRole("button", { name: "Modified" })
  ).toHaveAttribute("aria-pressed", "true")
  await admin((api) => api.SetDisplayPrefs({ prefs: { lorebookSort: "name" } }))

  // The card switcher's sort comes from the account too; each row has the card's portrait.
  await admin((api) =>
    api.SetDisplayPrefs({ prefs: { cardSwitcher: { sort: "name", reversed: true, withPersonas: false } } })
  )
  await page.goto(`${server().url}/library/${fixtures.cards[0]}`)
  await settle(page)
  ;({ dialog } = await openSwitcher(page, card))
  // Name, Z to A: it opens at the card shown (Card 0000, last), so filter to the top of the list.
  await expect(dialog.getByRole("radio", { name: "Card 0000", exact: true })).toBeVisible()
  await dialog.getByRole("searchbox", { name: card.search }).fill("card 199")
  await expect(dialog.getByRole("radio").first()).toHaveAccessibleName("Card 1999")
  await expect(dialog.getByRole("radio").last()).toHaveAccessibleName("Card 1990")
  await dialog.getByRole("searchbox", { name: card.search }).fill("")
  const rows = dialog.locator("[data-picker-row]")
  expect(await rows.count()).toBeLessThanOrEqual(60)
  expect(await rows.locator("[data-portrait]").count()).toBe(await rows.count())
  await admin((api) =>
    api.SetDisplayPrefs({ prefs: { cardSwitcher: { sort: "recent", reversed: false, withPersonas: false } } })
  )

  // New card…: the library's form, then the card opens in this editor.
  await dialog.getByRole("button", { name: "New card…", exact: true }).click()
  const form = page.getByRole("dialog", { name: "New card", exact: true })
  await form.getByRole("textbox", { name: "Display name" }).fill("Card made here")
  await form.getByRole("button", { name: "Create", exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(page).not.toHaveURL(new RegExp(fixtures.cards[0]!))
  await expect(trigger(page, card)).toContainText("Card made here")

  // New snippet: an empty one, opened in this editor.
  await page.goto(`${server().url}${snippet.path(fixtures)}`)
  await settle(page)
  ;({ dialog } = await openSwitcher(page, snippet))
  await dialog.getByRole("button", { name: "New snippet", exact: true }).click()
  await expect(page).not.toHaveURL(new RegExp(fixtures.snippets[0]!))
  await expect(trigger(page, snippet)).toContainText("Untitled snippet")

  // Over a chat, New note: a note for this chat, on, opened in the large editor.
  const wren = await admin((api) => api.CreateCard({ label: "Switcher Wren", name: "Wren" }))
  const { chat } = await admin((api) =>
    api.StartChat({
      cards: [wren.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "A made-up harbour at dawn.", speakerEntityId: null }
    })
  )
  await admin((api) => api.CreateChatNote({ chatId: chat.id, title: "Tide table" }))
  await page.goto(`${server().url}/chats/${chat.id}`)
  const notes = await openPanel(page, "Notes")
  await notes.getByRole("button", { name: "Actions for Tide table", exact: true }).click()
  await page.getByRole("menuitem", { name: "Large editor", exact: true }).click()
  const overlay = page.getByRole("region", { name: "Note editor" })
  await expect(overlay).toBeVisible()
  const noteSwitch = overlay.getByRole("button", { name: "Switch note", exact: true })
  await noteSwitch.click()
  dialog = page.getByRole("dialog", { name: "Note", exact: true })
  await dialog.getByRole("button", { name: "New note", exact: true }).click()
  await expect(noteSwitch).toContainText("Note")
  await expect(noteSwitch).not.toContainText("Tide table")
  await expect(notes.getByRole("switch", { name: "Note: on in this chat" })).toBeChecked()
})
