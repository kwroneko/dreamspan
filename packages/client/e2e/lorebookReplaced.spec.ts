// A card's own book replaced by a world file (owner, DESIGN §1.3): the chat's Lorebooks tab says so
// for a file linked to the card (an import's link) and for a file named as the card's world. Made-up
// books and cards only, at 1440 and 390, light and dark.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { card, encode, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const world = (name: string) => ({
  name,
  entries: { 0: { uid: 0, key: ["harbour"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 } }
})
const ownBook = (name: string) => ({
  character_book: {
    name,
    entries: [{ keys: ["lens"], content: "The lens came from a wreck.", enabled: true, insertion_order: 1, id: 1 }]
  }
})

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`a card's own book replaced by a world file at ${width} ${scheme}`, async ({ page }) => {
      test.setTimeout(240_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), scheme)
      const tag = `${width}${scheme}`
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

      // By link: an import links the card to the world file it names.
      const linked = `Linked ${tag}`
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const run = await admin((api) => api.StartStImport({ unsupported: [] }))
      const files = new Map<string, Uint8Array>([
        [`characters/Wren ${tag}.png`, card(`Wren ${tag}`, "The lamp turns.", { world: linked }, ownBook(`Wren's notes ${tag}`))],
        [`worlds/${linked}.json`, encode(world(linked))],
        [
          `chats/Wren ${tag}/${linked}.jsonl`,
          jsonl([header({ world_info: linked }), message({ name: `Wren ${tag}`, mes: "The lamp turns.", minute: 1 })])
        ]
      ])
      for (const [path, body] of files) {
        const response = await fetch(
          `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
          { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: new Uint8Array(body) }
        )
        expect(response.status).toBe(200)
        expect((await response.json()).outcome).not.toBe("failed")
      }
      await admin((api) => api.FinishStImport({ importId: run.importId, notSent: [] }))
      const importedChat = await admin((api) =>
        Effect.gen(function* () {
          const chats = yield* api.ListChats({ limit: 100, before: null })
          return chats.find((c) => c.title === linked)!
        })
      )
      await page.goto(`${server().url}/chats/${importedChat.id}`)
      let panel = await openPanel(page, "Lorebooks")
      let rows = panel.getByRole("list", { name: "Lorebooks in this chat" })
      await expect(rows).toContainText(`replaced by ${linked}, linked to Wren ${tag}`, { timeout: 60_000 })
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "lorebooks-replaced-linked")

      // By name: a card naming a file as its world, the file added to a chat of its own.
      const named = `Named ${tag}`
      await upload(page, named, world(named))
      await upload(page, `Pip ${tag}`, {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name: `Pip ${tag}`, first_mes: "Hello.", extensions: { world: named }, ...ownBook(`Pip's notes ${tag}`) }
      })
      const chatId = await admin((api) =>
        Effect.gen(function* () {
          const book = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === named)!
          const pip = (yield* api.ListCards()).find((c) => c.name === `Pip ${tag}`)!
          const chat = yield* api.CreateChat({ title: `Named chat ${tag}` })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: pip.entityId } })
          return { chat, book }
        })
      )
      await page.goto(`${server().url}/chats/${chatId.chat.id}`)
      panel = await openPanel(page, "Lorebooks")
      rows = panel.getByRole("list", { name: "Lorebooks in this chat" })
      await expect(rows).toContainText(`Pip ${tag}'s own lorebook`, { timeout: 60_000 })
      // The file isn't read yet: the card's own book is.
      await expect(rows).not.toContainText("replaced by")
      await admin((api) =>
        api.ChangeCast({
          chatId: chatId.chat.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: chatId.book.id, active: true }
        })
      )
      await expect(rows).toContainText(`replaced by ${named}, linked to Pip ${tag}`, { timeout: 60_000 })
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "lorebooks-replaced-named")
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    })
  }
}
