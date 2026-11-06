// The editors' header switchers at scale (owner, 2026-11-06: the plain select was "unusable
// with any large number of them"): 300 prompt presets, 300 lorebooks and 2,000 cards, all made
// up here. Each switcher opens its kind's complete picker with only the rows in view mounted,
// filters as you type, and chooses by keyboard (Down, Enter) and by mouse; the preset editor's
// header and the side panel's Prompt preset tab open the same picker.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RefId } from "@rp/shared/library.ts"
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
