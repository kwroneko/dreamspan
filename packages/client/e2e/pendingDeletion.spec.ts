// Two independent devices, with a deliberately fast clock and an unsent browser copy.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test("deletion on another device defeats old browser text; a new keystroke after it survives reload", async ({
  browser
}) => {
  const card = await admin((api) => api.CreateCard({ label: "Deletion fixture", name: "Deletion fixture" }))
  const ownerId = await admin((api) => Effect.map(api.Whoami(), (user) => user.id))
  const targetId = `pending-chat:${card.entityId}`
  const address = { ownerId, targetId, field: "First message" }
  await admin((api) =>
    api.SaveUserDraft({
      ...address,
      content: "Text to delete",
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null
    })
  )
  const deviceA = await browser.newContext()
  const deviceB = await browser.newContext()
  try {
    let hold = true
    await deviceA.route("**/library/drafts", (route) => route.abort())
    await deviceA.routeWebSocket("**/rpc", (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((message) => {
        if (!hold || !String(message).includes('"tag":"SaveUserDraft"')) upstream.send(message)
      })
      upstream.onMessage((message) => socket.send(message))
    })
    const first = await deviceA.newPage()
    await apiLogin(first.request, server(), ADMIN.handle, ADMIN.password)
    const url = `${server().url}/cards/${card.entityId}/chat`
    await first.goto(url)
    await expect(first.getByLabel("Message", { exact: true })).toHaveValue("Text to delete")
    await first.getByLabel("Message", { exact: true }).fill("Old text left on device A")
    // An arbitrarily fast device clock must not beat a server deletion.
    const kept = await first.evaluate(() => {
      let count = 0
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith("rp.pendingTyped:")) continue
        const copy = JSON.parse(localStorage.getItem(key)!)
        copy.key = `synthetic-stale:${copy.key}`
        copy.at = Date.now() + 365 * 24 * 60 * 60 * 1000
        localStorage.setItem(key, JSON.stringify(copy))
        count++
      }
      return count
    })
    expect(kept).toBe(1)
    await first.close()
    const second = await deviceB.newPage()
    await apiLogin(second.request, server(), ADMIN.handle, ADMIN.password)
    await second.goto(url)
    await expect(second.getByLabel("Message", { exact: true })).toHaveValue(
      /^(Text to delete|Old text left on device A)$/
    )
    await second.getByLabel("Message", { exact: true }).fill("")
    await expect
      .poll(() => admin((api) => api.GetUserDraft(address)).then((draft) => draft?.clearedVersion ?? 0))
      .toBeGreaterThan(0)
    await second.close()

    const reopened = await deviceA.newPage()
    await reopened.goto(url)
    await expect(reopened.getByLabel("Message", { exact: true })).toHaveValue("")
    // This copy observes the deletion's version. No server save or async backup is
    // required to finish before reloading immediately after its final keystroke.
    await reopened.getByLabel("Message", { exact: true }).fill("A new thought after deleting")
    hold = false
    await reopened.reload()
    await expect(reopened.getByLabel("Message", { exact: true })).toHaveValue("A new thought after deleting")
    await expect
      .poll(() => admin((api) => api.GetUserDraft(address)).then((draft) => draft?.content))
      .toBe("A new thought after deleting")
  } finally {
    await deviceA.close()
    await deviceB.close()
  }
})

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
          const opening = indexedDB.open("rp-editor-copies", 1)
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
