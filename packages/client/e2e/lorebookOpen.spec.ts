// Open on each kind of row in a chat's Lorebooks tab shows that book's editor over the chat:
// a card's own book (part of the card document) opens the card on its lorebook alone, not on the
// card's definitions; an added or global book opens its own editor. All books are synthetic.
import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const importFile = async (page: Page, name: string, body: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}`, {
    headers: { "content-type": "application/octet-stream", origin: server().url },
    data: Buffer.from(JSON.stringify(body))
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: { id: RefId; entityId: EntityId } } }).library.ref
}

const world = (name: string, title: string) => ({
  name,
  entries: { 0: { uid: 0, key: ["lantern"], comment: title, content: `${title} text.`, order: 10 } }
})

for (const width of [1440, 390]) {
  test(`Open on a card's own, an added and a global book shows that book's editor at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    // A card with a long definition above its book: Open mustn't land on the definition.
    const card = await importFile(page, `Keeper ${width}.json`, {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: `Keeper ${width}`,
        description: "A synthetic keeper.\n".repeat(80),
        personality: "",
        scenario: "",
        first_mes: "Hello",
        mes_example: "",
        character_book: {
          name: `Harbour ${width}`,
          entries: [
            { id: 1, keys: ["tide"], content: "The tide is low.", comment: "Tides", enabled: true },
            { id: 2, keys: ["lamp"], content: "The lamp is lit.", comment: "Lamp", enabled: true }
          ]
        }
      }
    })
    const added = await importFile(page, `Lantern ${width}.json`, world(`Lantern ${width}`, "Lanterns"))
    const global = await importFile(page, `Moon ${width}.json`, world(`Moon ${width}`, "Moons"))
    const chat = await admin((api) =>
      Effect.gen(function* () {
        const made = yield* api.CreateChat({ title: `Book links ${width}` })
        yield* api.ChangeCast({ chatId: made.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        yield* api.ChangeCast({
          chatId: made.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: added.id, active: true }
        })
        yield* api.ChangeCast({
          chatId: made.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: global.id, active: true }
        })
        return made
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}`)
    const shots = process.env.SCREENSHOT_DIR
    if (shots) mkdirSync(shots, { recursive: true })
    const rows: ReadonlyArray<readonly [string, string]> = [
      [`Harbour ${width}`, "Tides"],
      [`Lantern ${width}`, "Lanterns"],
      [`Moon ${width}`, "Moons"]
    ]
    for (const [book, entry] of rows) {
      const tab = await openPanel(page, "Lorebooks")
      await tab
        .getByRole("list", { name: "Lorebooks in this chat" })
        .getByRole("button", { name: `Open ${book}`, exact: true })
        .click()
      const editor = page.getByRole("dialog", { name: "Lorebook editor", exact: true })
      // The book is what's in view: its name, and its entries, on screen without scrolling.
      await expect(editor.getByRole("heading", { level: 1, name: book })).toBeVisible()
      await expect(editor.getByRole("list", { name: "Entries" })).toBeVisible()
      await expect(editor.getByRole("button", { name: `Open ${entry}`, exact: true })).toBeInViewport()
      // Not the card's definition.
      await expect(editor.getByRole("textbox", { name: "Description", exact: true })).toHaveCount(0)
      await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}`))
      if (shots) await page.screenshot({ path: `${shots}/lorebook-open-${book.split(" ")[0]}-${width}.png` })
      await editor.getByRole("button", { name: "Back to the chat", exact: true }).click()
      await expect(editor).toHaveCount(0)
    }

    // The card's book on its own page: the rest of the card is one click away, the book kept in view.
    await page.goto(`${server().url}/library/${card.id}?focus=lorebook`)
    await expect(page.getByRole("heading", { level: 1, name: `Harbour ${width}` })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Tides", exact: true })).toBeInViewport()
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Show the whole card", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: `Keeper ${width}` })).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Open Tides", exact: true })).toBeInViewport()
  })
}
