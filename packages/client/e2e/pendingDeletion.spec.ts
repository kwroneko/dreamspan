import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
// Two independent devices, with a deliberately fast clock and an unsent browser copy.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test("an editor's stale browser copy cannot restore a field emptied on another device", async ({ browser }) => {
  const card = await admin((api) => api.CreateCard({ label: "Empty field fixture", name: "Empty field fixture" }))
  const field = JSON.stringify(["description"])
  const draft = await admin((api) =>
    api.SaveEditorDraft({
      refId: card.id,
      field,
      content: "Description to delete",
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: card.headRevisionId
    })
  )
  const ownerId = await admin((api) => Effect.map(api.Whoami(), (user) => user.id))
  const deviceA = await browser.newContext()
  const deviceB = await browser.newContext()
  try {
    const first = await deviceA.newPage()
    await apiLogin(first.request, server(), ADMIN.handle, ADMIN.password)
    const url = `${server().url}/library/${card.id}`
    await first.goto(url)
    const description = (page: typeof first) => page.getByRole("textbox", { name: /^Description/ })
    await expect(description(first)).toHaveText("Description to delete")
    // A synthetic unsent copy based on the field before its deletion, with a fast clock.
    await first.evaluate(
      async ({ ownerId, refId, draft, field, revision }) => {
        const copy = {
          key: "synthetic-editor-copy",
          userId: ownerId,
          refId,
          field,
          content: draft.content,
          at: Date.now() + 365 * 24 * 60 * 60 * 1000,
          ancestors: [],
          save: {
            kind: "editor",
            payload: {
              refId,
              field,
              draftId: draft.id,
              content: draft.content,
              expectedRowVersion: draft.rowVersion,
              expectedSession: draft.session,
              baseRevisionId: revision
            }
          }
        }
        await new Promise<void>((resolve, reject) => {
          const opening = indexedDB.open("dreamspan-editor-copies", 1)
          opening.onsuccess = () => {
            const db = opening.result
            const tx = db.transaction("copies", "readwrite")
            tx.objectStore("copies").put(copy)
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onerror = () => reject(tx.error)
          }
          opening.onerror = () => reject(opening.error)
        })
      },
      { ownerId, refId: card.id, draft, field, revision: card.headRevisionId }
    )
    await first.close()
    const second = await deviceB.newPage()
    await apiLogin(second.request, server(), ADMIN.handle, ADMIN.password)
    await second.goto(url)
    await expect(description(second)).toHaveText("Description to delete")
    await description(second).fill("")
    await expect
      .poll(() =>
        admin((api) => api.OpenEditor({ refId: card.id })).then(
          (snapshot) => snapshot.drafts.find((draft) => draft.key.field === field)?.clearedVersion ?? 0
        )
      )
      .toBeGreaterThan(0)
    const reopened = await deviceA.newPage()
    await reopened.goto(url)
    await expect(description(reopened)).toBeEmpty()
    await expect
      .poll(() =>
        admin((api) => api.OpenEditor({ refId: card.id })).then(
          (snapshot) => snapshot.drafts.find((draft) => draft.key.field === field)?.content
        )
      )
      .toBe("")
  } finally {
    await deviceA.close()
    await deviceB.close()
  }
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`fresh insertion typing after Cancel restores before autosave at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      const { chat, sent } = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Synthetic immediate insertion reload" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Synthetic anchor"
          })
          if (sent._tag !== "Posted") throw new Error("queued")
          const target = {
            _tag: "Insert" as const,
            chatId: chat.id,
            forkId: sent.chat.currentForkId!,
            anchor: sent.entry.slotId
          }
          const draft = yield* api.SaveMessageDraft({
            target,
            draftId: null,
            expectedRowVersion: null,
            expectedSession: null,
            content: "Cancelled insertion text"
          })
          yield* api.DiscardMessageDraft({ target, draftId: draft.id, expectedRowVersion: draft.rowVersion })
          return { chat, sent }
        })
      )
      let connection = 0
      let leaving = false
      await page.route("**/library/drafts", (route) => route.abort())
      await page.routeWebSocket("**/rpc", (socket) => {
        const original = ++connection === 1
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          const request = JSON.parse(String(data)) as { tag?: string }
          if (request.tag === "SaveMessageDraft" || (original && leaving && request.tag === "GetMessageDraft")) return
          upstream.send(data)
        })
        upstream.onMessage((data) => socket.send(data))
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      await messageMenu(page.locator(`article[data-slot="${sent.entry.slotId}"]`), "Insert message below")
      const box = page.getByTestId("insert-text")
      await expect(box).toBeEnabled()
      await page.clock.install()
      await page.clock.pauseAt(new Date(Date.now() + 100))
      await box.fill("fresh final keystroke after reopening")
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              new Promise<boolean>((resolve) => {
                const open = indexedDB.open("dreamspan-editor-copies", 1)
                open.onsuccess = () => {
                  const db = open.result
                  const all = db.transaction("copies").objectStore("copies").getAll()
                  all.onsuccess = () => {
                    resolve(all.result.some((copy) => copy.content === "fresh final keystroke after reopening"))
                    db.close()
                  }
                }
              })
          )
        )
        .toBe(true)
      leaving = true
      await page.reload()
      await page.clock.resume()
      await expect(box).toHaveValue("fresh final keystroke after reopening")
      await page.screenshot({ path: test.info().outputPath("restored-insertion.png") })
      if (process.env.LAYOUT_AUDIT === "1")
        await expectLayout(page, test.info(), `restored-insertion-${width}-${theme}`)
    })
