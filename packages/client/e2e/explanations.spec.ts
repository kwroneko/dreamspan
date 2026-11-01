// Explanations on menu items and select options (`ui/Explanation.tsx`): with a mouse, beside
// the highlighted item, hovered or reached with the arrow keys, outside the list so it covers no
// row; on a phone, under each label in muted text. Either way it's the item's description, and
// never part of its name. A note's Position select and the Add note menu, at 1440 and 390, light
// and dark, with screenshots outside the repository (SCREENSHOT_DIR). The card is made up.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import { noteSettings } from "./support/notes.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-explain-screenshots"))
let chatId = ""
let provider: FakeProvider

const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async ({ playwright }) => {
  mkdirSync(shots, { recursive: true })
  provider = await startProvider()
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-explain-test-key-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const models = await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))
  const model = models.find((m) => m.key === "fake-small")!
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: model.id }, preset: null } })
  )
  const mira = await admin((api) => api.CreateCard({ label: "Mira", name: "Mira" }))
  await admin((api) => api.CreateCardNote({ cardRefId: mira.id as RefId, title: "Outfit" }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [mira.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "The river is rising.", speakerEntityId: null }
    })
  )
  chatId = started.chat.id
  // A book added to the chat, whose ⋯ offers "Remove from this chat".
  const request = await playwright.request.newContext()
  await apiLogin(request, server(), ADMIN.handle, ADMIN.password)
  const book = {
    entries: { 0: { uid: 0, key: ["lamp"], comment: "Lamp", content: "The lamp burns blue at night.", order: 10 } }
  }
  const response = await request.post(`${server().url}/library/import?name=Saltmarsh.json`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(JSON.stringify(book))
  })
  expect(response.status()).toBe(200)
  const {
    library: { ref }
  } = await response.json()
  await request.dispose()
  await admin((api) =>
    api.ChangeCast({ chatId: chatId as never, slotId: null, change: { _tag: "Lorebook", ref: ref.id, active: true } })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const explanation = (page: Page) => page.locator("[data-explanation]")

/** Neither box covers the other: the explanation sits beside the list. */
const beside = async (list: Locator, box: Locator) => {
  const a = (await list.boundingBox())!
  const b = (await box.boundingBox())!
  expect(b.x >= a.x + a.width || b.x + b.width <= a.x).toBe(true)
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(list.page().viewportSize()!.width)
}

const openOutfit = async (page: Page) => {
  const notes = page.getByRole("tabpanel", { name: "Notes" })
  const hers = notes.getByRole("region", { name: "Mira's notes" })
  return { notes, note: await noteSettings(hers, "Outfit") }
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}, with a mouse: beside the item hovered or reached with the keys`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await openPanel(page, "Notes")
    const { notes, note } = await openOutfit(page)

    await note.getByRole("combobox", { name: "Position" }).click()
    const list = page.getByRole("listbox")
    const start = page.getByRole("option", { name: "Start of context", exact: true })
    // The name stays the label; the explanation is the description.
    await expect(start).toHaveAccessibleDescription("The very first thing sent, before everything in the preset.")
    // Inline copies are for touch screens and narrow windows only.
    await expect(start.getByText("The very first thing sent")).toBeHidden()
    await start.hover()
    await expect(explanation(page)).toHaveText("The very first thing sent, before everything in the preset.")
    await beside(list, explanation(page))
    // The keyboard moves it: a card's note goes with the definitions inside its card's part.
    await page.keyboard.press("ArrowDown")
    await expect(explanation(page)).toHaveText(/this card's own part of the definitions/)
    await beside(list, explanation(page))
    // Level with the row it explains.
    const row = (await page.getByRole("option", { name: "With the definitions" }).boundingBox())!
    expect(Math.abs((await explanation(page).boundingBox())!.y - row.y)).toBeLessThan(2)
    await page.screenshot({ path: join(shots, `select-1440-${theme}.png`) })
    await page.keyboard.press("Escape")
    await expect(explanation(page)).toHaveCount(0)

    // A menu: the first item reached with the keys, then the next, then one hovered.
    await notes.getByRole("region", { name: "This chat's notes" }).getByRole("button", { name: "Add note" }).click()
    const menu = page.getByRole("menu", { name: "Add note" })
    await expect(menu).toBeVisible()
    await page.keyboard.press("ArrowDown")
    await expect(explanation(page)).toHaveText("An empty note of its own here.")
    await beside(menu, explanation(page))
    await page.keyboard.press("ArrowDown")
    await expect(explanation(page)).toHaveText(/shows a shared note's text/)
    await page.getByRole("menuitem", { name: "New note" }).hover()
    await expect(explanation(page)).toHaveText("An empty note of its own here.")
    await expect(page.getByRole("menuitem", { name: "Pick a shared note…" })).toHaveAccessibleDescription(
      /shows a shared note's text/
    )
    await page.screenshot({ path: join(shots, `menu-1440-${theme}.png`) })
    // Leaving the list puts it away.
    await page.mouse.move(5, 5)
    await expect(explanation(page)).toHaveCount(0)
    await page.keyboard.press("Escape")
    await context.close()
  })

  test(`${theme}, on a phone: under each label`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: theme
    })
    const page = await context.newPage()
    await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await page.getByRole("button", { name: "Chat panel" }).click()
    await panelTab(page, "Notes")
    const { notes, note } = await openOutfit(page)

    await note.getByRole("combobox", { name: "Position" }).tap()
    const start = page.getByRole("option", { name: "Start of context", exact: true })
    await expect(start.getByText("The very first thing sent, before everything in the preset.")).toBeVisible()
    await expect(
      page.getByRole("option", { name: "End of the tail" }).getByText(/Last of the preset's prompts/)
    ).toBeVisible()
    await expect(explanation(page)).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const list = (await page.getByRole("listbox").boundingBox())!
    expect(list.x).toBeGreaterThanOrEqual(0)
    expect(list.x + list.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: join(shots, `select-390-${theme}.png`) })
    await start.tap()

    await notes.getByRole("region", { name: "This chat's notes" }).getByRole("button", { name: "Add note" }).tap()
    await expect(
      page.getByRole("menuitem", { name: "New note" }).getByText("An empty note of its own here.")
    ).toBeVisible()
    await expect(
      page.getByRole("menuitem", { name: "Pick a shared note…" }).getByText(/shows a shared note's text/)
    ).toBeVisible()
    await page.screenshot({ path: join(shots, `menu-390-${theme}.png`) })
    await page.keyboard.press("Escape")

    // A choice: the chosen one's explanation under the row, as nothing hovers; a book's
    // switch and its ⋯ items say what they do.
    await panelTab(page, "Lorebooks")
    await expect(page.getByText(/^Off stops the book in this chat/)).toBeVisible()
    await page.getByRole("button", { name: "More for Saltmarsh" }).tap()
    await expect(
      page.getByRole("menuitem", { name: "Remove from this chat" }).getByText(/^Takes it off this chat's list/)
    ).toBeVisible()
    await page.screenshot({ path: join(shots, `lorebook-menu-390-${theme}.png`) })
    await page.keyboard.press("Escape")
    const where = page.getByRole("group", { name: "Where entries go" })
    await expect(where.locator("..").locator("p")).toHaveText(/one block just after the history/)
    await page.screenshot({ path: join(shots, `choice-390-${theme}.png`) })
    await context.close()
  })

  test(`${theme}, spot checks with a mouse: a panel tab, a choice, the chat menu, a button`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    const lore = await openPanel(page, "Lorebooks")
    // A panel tab says what it holds.
    await page.getByRole("tablist", { name: "Chat panel" }).getByRole("tab", { name: "Lorebooks" }).hover()
    await expect(
      page.getByText("The lorebooks this chat reads, each with its switch, and where their entries go.")
    ).toBeVisible()
    // A choice explains itself on hover, and to a screen reader.
    const below = lore
      .getByRole("group", { name: "Where entries go" })
      .getByRole("button", { name: "Below the history" })
    await expect(below).toHaveAccessibleDescription(/one block just after the history/)
    await below.hover()
    await expect(page.getByText(/one block just after the history, so the history stays cached/).last()).toBeVisible()
    await page.screenshot({ path: join(shots, `choice-1440-${theme}.png`) })

    // The owner's example: a book's ⋯ item and its switch say what they do.
    await lore.getByRole("button", { name: "More for Saltmarsh" }).click()
    await page.getByRole("menuitem", { name: "Remove from this chat" }).hover()
    await expect(explanation(page)).toHaveText(/^Takes it off this chat's list, from the latest message on/)
    await page.screenshot({ path: join(shots, `lorebook-menu-1440-${theme}.png`) })
    await page.keyboard.press("Escape")
    // The row's switch: its explanation as its description, and in a tooltip on hover.
    const book = lore.getByRole("switch", { name: /^Saltmarsh/ })
    await expect(book).toHaveAccessibleDescription(/^Off stops the book in this chat/)
    await book.hover()
    await expect(page.getByText(/^Off stops the book in this chat/).last()).toBeVisible()

    // The chat's menu: its commands, explained beside them.
    await page.getByRole("button", { name: "Chat actions" }).click()
    const menu = page.getByRole("menu")
    await page.getByRole("menuitem", { name: "Branches…" }).hover()
    await expect(explanation(page)).toHaveText("Switch to, rename or delete this chat's branches.")
    await beside(menu, explanation(page))
    await page.screenshot({ path: join(shots, `chat-menu-1440-${theme}.png`) })
    await page.keyboard.press("Escape")

    // A button: its hint on hover and as its description.
    await page.goto(`${server().url}/settings/keys`)
    const save = page.getByRole("button", { name: "Save a key" })
    await expect(save).toHaveAccessibleDescription("Saves a key once, for any number of connections to use.")
    await save.hover()
    await expect(page.getByText("Saves a key once, for any number of connections to use.").last()).toBeVisible()
    await page.screenshot({ path: join(shots, `button-1440-${theme}.png`) })
    await context.close()
  })
}
