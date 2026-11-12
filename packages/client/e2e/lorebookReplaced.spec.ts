// A card's own book replaced by a world file (owner, DESIGN §1.3): the chat's Lorebooks tab says so
// for a file linked to the card (an import's link) and for a file named as the card's world. Made-up
// books and cards only, at 1440 and 390, light and dark.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { card, encode, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { openPanel } from "./support/panel.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let adminCookie: string
test.beforeAll(async () => {
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), adminCookie, use)

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
      const tooltip = page.locator('[data-layout-overlay="Tooltip floats above the page"]')
      const tag = `${width}${scheme}`
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)

      // By link: an import links the card to the world file it names.
      const linked = `Linked ${tag}`
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const run = await admin((api) => api.StartStImport({ unsupported: [] }))
      const files = new Map<string, Uint8Array>([
        [
          `characters/Wren ${tag}.png`,
          card(`Wren ${tag}`, "The lamp turns.", { world: linked }, ownBook(`Wren's notes ${tag}`))
        ],
        [`worlds/${linked}.json`, encode(world(linked))],
        [
          `chats/Wren ${tag}/${linked}.jsonl`,
          jsonl([
            header({ world_info: linked }),
            message({ name: `Wren ${tag}`, mes: "The lamp turns.", minute: 1 }),
            message({ name: "Visitor", user: true, mes: "I can see the harbour.", minute: 2 })
          ])
        ]
      ])
      for (const [path, body] of files) {
        const response = await fetch(
          `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
          {
            method: "POST",
            headers: { cookie, "content-type": "application/octet-stream" },
            body: new Uint8Array(body)
          }
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
      const linkedOwn = rows.getByRole("button").filter({ hasText: `Wren's notes ${tag}` })
      await linkedOwn.hover()
      await expect(tooltip).toContainText(`This chat reads ${linked} instead of Wren ${tag}’s own lorebook.`)
      await page.mouse.move(0, 0)
      await expect(tooltip).toBeHidden()
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "lorebooks-replaced-linked")

      // By name: a card naming a file as its world, the file added to a chat of its own.
      const named = `Named ${tag}`
      await upload(page, named, world(named))
      await upload(page, `Pip ${tag}`, {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name: `Pip ${tag}`, first_mes: "Hello.", extensions: { world: named }, ...ownBook(named) }
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
      await expect(rows).not.toContainText(`Also active as Pip ${tag}'s own lorebook`)
      const ownRow = rows.getByRole("listitem").filter({ hasText: `Pip ${tag}'s own lorebook` })
      const worldRow = rows
        .getByRole("listitem")
        .filter({ has: page.getByRole("button", { name: `More for ${named}`, exact: true }) })
      const names = await rows.getByRole("listitem").allTextContents()
      await worldRow.getByRole("switch").click()
      await expect(rows).not.toContainText("replaced by")
      await expect(rows.getByRole("listitem")).toHaveCount(names.length)
      await expect(ownRow.getByRole("switch")).toBeChecked()
      await worldRow.getByRole("switch").click()
      await expect(rows).toContainText(`replaced by ${named}, linked to Pip ${tag}`)
      await ownRow.getByRole("button").hover()
      await expect(tooltip).toContainText(`This chat reads ${named} instead of Pip ${tag}’s own lorebook.`)
      await page.mouse.move(0, 0)
      await expect(tooltip).toBeHidden()
      // Archiving hides a book from pickers, but a chat already reading it still uses it.
      await admin((api) => api.SetRefArchived({ refId: chatId.book.id, archived: true }))
      await expect(rows).toContainText(`replaced by ${named}, linked to Pip ${tag}`)
      await page.reload()
      panel = await openPanel(page, "Lorebooks")
      rows = panel.getByRole("list", { name: "Lorebooks in this chat" })
      await expect(rows).toContainText(`replaced by ${named}, linked to Pip ${tag}`)
      // A card fork keeps its world link; several group members resolve independently.
      await admin((api) =>
        Effect.gen(function* () {
          const pip = (yield* api.ListCards()).find((c) => c.name === `Pip ${tag}`)!
          return yield* api.ForkCardForChat({
            chatId: chatId.chat.id,
            slotId: null,
            entityId: pip.entityId,
            name: `Pip fork ${tag}`,
            nickname: "",
            characterVersion: ""
          })
        })
      )
      await expect(rows).toContainText(`replaced by ${named}, linked to Pip fork ${tag}`)
      for (const [label, file] of [
        ["Quill", named],
        ["Case", named.toLowerCase()],
        ["Space", ` ${named} `]
      ]) {
        await upload(page, `${label} ${tag}`, {
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: { name: `${label} ${tag}`, extensions: { world: file }, ...ownBook(`${label}'s notes ${tag}`) }
        })
        await admin((api) =>
          Effect.gen(function* () {
            const card = (yield* api.ListCards()).find((c) => c.name === `${label} ${tag}`)!
            yield* api.ChangeCast({
              chatId: chatId.chat.id,
              slotId: null,
              change: { _tag: "Join", entityId: card.entityId }
            })
          })
        )
      }
      await expect(rows.getByRole("listitem").filter({ hasText: `Quill's notes ${tag}` })).toContainText("replaced by")
      for (const label of ["Case", "Space"])
        await expect(rows.getByRole("listitem").filter({ hasText: `${label}'s notes ${tag}` })).not.toContainText(
          "replaced by"
        )
      // A display rename must not change a link resolved against the retained filename.
      const renamed = `Renamed ${tag}`
      await admin((api) =>
        Effect.gen(function* () {
          const { ref } = yield* api.OpenEditor({ refId: chatId.book.id })
          yield* api.RenameRef({ refId: ref.id, label: renamed, subtitle: "", expectedRowVersion: ref.rowVersion })
        })
      )
      // This write came from another RPC session; reload the tab's library metadata.
      await page.reload()
      panel = await openPanel(page, "Lorebooks")
      rows = panel.getByRole("list", { name: "Lorebooks in this chat" })
      await expect(rows).toContainText(`replaced by ${renamed}, linked to Pip fork ${tag}`)
      await expect(rows).toContainText(`replaced by ${renamed}, linked to Quill ${tag}`)
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "lorebooks-replaced-named")
      await page.screenshot({ path: test.info().outputPath(`lorebooks-${width}-${scheme}.png`) })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    })
  }
}
