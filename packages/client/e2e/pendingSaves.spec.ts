import { expect, type Page, test } from "@playwright/test"
import { textField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | null = null
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => {
  cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)
  return cookie.then((value) => withCookie(server(), value, use))
}

interface StoredCopy {
  key: string
  content: string
  save: { payload: { content: string } }
}
const copies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<StoredCopy>>((resolve) => {
        const request = indexedDB.open("rp-editor-copies", 1)
        request.onsuccess = () => {
          const db = request.result
          const all = db.transaction("copies").objectStore("copies").getAll()
          all.onsuccess = () => {
            db.close()
            resolve(all.result as Array<StoredCopy>)
          }
        }
      })
  )
const text = (copy: StoredCopy) => copy.save.payload.content
const message = (page: Page) => page.getByLabel("Message", { exact: true })
const offlineBeacon = (page: Page) =>
  page.evaluate(() => {
    const fetch = window.fetch
    window.fetch = (url, init) =>
      url === "/library/drafts" ? Promise.reject(new Error("synthetic offline")) : fetch(url, init)
  })

for (const kind of ["card", "preset"] as const) {
  test(`${kind} backup replays its original base and preserves the other tab's text`, async ({ page }) => {
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    let refId
    if (kind === "card") refId = (await admin((api) => api.CreateCard({ label: "Backup", name: "Synthetic" }))).id
    else {
      const bytes = await readFile(new URL("../../server/test/fixtures/presets/default.json", import.meta.url))
      const response = await page.request.post(`${server().url}/library/import?name=synthetic.json`, {
        headers: { "content-type": "application/octet-stream", origin: server().url },
        data: bytes
      })
      expect(response.status()).toBe(200)
      refId = ((await response.json()) as { library: { ref: { id: typeof refId } } }).library.ref.id
    }
    const field = kind === "card" ? textField(["description"]) : textField(["prompts", "identifier=main", "content"])
    const ref = await admin((api) => api.OpenEditor({ refId: refId! }))
    const first = await admin((api) =>
      api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: refId!,
        field,
        content: "hello",
        expectedRowVersion: null,
        baseRevisionId: ref.ref.headRevisionId
      })
    )
    let block = true
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (block && typeof data === "string" && JSON.parse(data).tag === "SaveEditorDraft") return
        upstream.send(data)
      })
    })
    await page.goto(`${server().url}/library/${refId}`)
    const box = () => page.getByRole("textbox", { name: kind === "card" ? /^Description/ : /^Prompt/ })
    if (kind === "preset") await page.getByRole("button", { name: "Edit Main Prompt", exact: true }).click()
    await expect(box()).toHaveValue("hello")
    await offlineBeacon(page)
    await box().fill("hello A")
    await expect.poll(async () => (await copies(page)).map(text)).toContain("hello A")
    await admin((api) =>
      api.SaveEditorDraft({
        draftId: first.id,
        refId: refId!,
        field,
        content: "hello B",
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevisionId: null
      })
    )
    page.on("dialog", (dialog) => void dialog.accept())
    block = false
    await page.reload()
    if (kind === "preset") await page.getByRole("button", { name: "Edit Main Prompt", exact: true }).click()
    await expect(box()).toHaveValue("hello A")
    await expect
      .poll(
        async () =>
          (await admin((api) => api.OpenEditor({ refId: refId! }))).drafts.find((d) => d.key.field === field)?.content
      )
      .toBe("hello A")
    const recovered = await admin((api) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: refId! })
        yield* api.CommitEditorDrafts({
          refId: refId!,
          expectedRowVersion: opened.ref.rowVersion,
          fields: opened.drafts.map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
          message: null
        })
        return yield* api.ListRecoveredTexts({ limit: 100, before: null })
      })
    )
    expect(recovered.map((r) => r.content)).toContain("hello B")
    await expect.poll(() => copies(page)).toEqual([])
  })
}

test("two offline composer tabs retain independent pending copies and acknowledge both", async ({ page, context }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Offline tabs" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const other = await context.newPage()
  for (const tab of [page, other]) {
    await tab.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string" && JSON.parse(data).tag === "SaveComposer") return
        upstream.send(data)
      })
    })
    await tab.goto(`${server().url}/chats/${chat.id}`)
    await expect(message(tab)).toBeEditable()
    await offlineBeacon(tab)
  }
  await message(page).fill("UNSAVED FROM A")
  await expect.poll(async () => (await copies(page)).map(text)).toContain("UNSAVED FROM A")
  await message(other).fill("UNSAVED FROM B")
  await expect.poll(async () => (await copies(page)).map(text).sort()).toEqual(["UNSAVED FROM A", "UNSAVED FROM B"])
  await other.close()
  await page.close()
  const opened = await context.newPage()
  await opened.goto(`${server().url}/chats/${chat.id}`)
  await expect(message(opened)).toHaveValue("UNSAVED FROM B")
  await expect.poll(() => copies(opened)).toEqual([])
  const recovered = await admin((api) =>
    Effect.gen(function* () {
      const draft = yield* api.OpenComposer({ chatId: chat.id, tipSlotId: null })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: draft.content,
        composer: { draftId: draft.id, session: draft.session }
      })
      return yield* api.ListRecoveredTexts({ limit: 100, before: null })
    })
  )
  expect(recovered.map((r) => r.content)).toContain("UNSAVED FROM A")
})

test("a stale active editor meets the conflict picker after another tab commits", async ({ page }) => {
  const { ref, draft, field } = await admin((api) =>
    Effect.gen(function* () {
      const ref = yield* api.CreateCard({ label: "Commit boundary", name: "Synthetic" })
      const field = textField(["description"])
      const draft = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: ref.id,
        field,
        content: "hello",
        expectedRowVersion: null,
        baseRevisionId: ref.headRevisionId
      })
      return { ref, draft, field }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${ref.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  await expect(box).toHaveValue("hello")
  await admin((api) =>
    Effect.gen(function* () {
      const b = yield* api.SaveEditorDraft({
        draftId: draft.id,
        refId: ref.id,
        field,
        content: "hello B",
        expectedRowVersion: draft.rowVersion,
        expectedSession: draft.session,
        baseRevisionId: null
      })
      yield* api.CommitEditorDrafts({
        refId: ref.id,
        expectedRowVersion: ref.rowVersion,
        fields: [{ field, draftId: b.id, expectedRowVersion: b.rowVersion }],
        message: null
      })
    })
  )
  await box.fill("hello A")
  await expect
    .poll(async () => (await admin((api) => api.OpenEditor({ refId: ref.id }))).drafts[0]?.content)
    .toBe("hello A")
  await page.getByRole("button", { name: "Save (1)", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Save a revision" })
  await dialog.getByRole("button", { name: "Save revision", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await dialog.getByRole("button", { name: "Save revision", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Changed meanwhile" })).toBeVisible()
})

test("typing during a save deletes exactly the acknowledged copy and never recovers sent text", async ({ page }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Acknowledgement" }))
  let block = false
  const waiting: Array<() => void> = []
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    upstream.onMessage((data) => {
      if (block) waiting.push(() => socket.send(data))
      else socket.send(data)
    })
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(message(page)).toBeEditable()
  block = true
  await message(page).fill("hello")
  await expect
    .poll(async () => (await admin((api) => api.OpenComposer({ chatId: chat.id, tipSlotId: null }))).content)
    .toBe("hello")
  await message(page).fill("hello plus")
  await expect.poll(async () => (await copies(page)).map(text)).toContain("hello plus")
  block = false
  for (const send of waiting.splice(0)) send()
  await expect
    .poll(async () => (await admin((api) => api.OpenComposer({ chatId: chat.id, tipSlotId: null }))).content)
    .toBe("hello plus")
  await expect.poll(() => copies(page)).toEqual([])
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("hello plus")
  await expect(message(page)).toHaveValue("")
  await page.reload()
  await expect(message(page)).toBeEditable()
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))
  expect(recovered.map((r) => r.content)).not.toContain("hello plus")
})

test("a keepalive and its later live save acknowledge the same pending operation", async ({ page }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Keepalive acknowledgement" }))
  const ids: Array<string> = []
  let release: (() => void) | null = null
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (typeof data === "string") {
        const request = JSON.parse(data) as { tag: string; payload?: { operationId?: string } }
        if (request.tag === "SaveComposer") {
          ids.push(request.payload!.operationId!)
          release = () => upstream.send(data)
          return
        }
      }
      upstream.send(data)
    })
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(message(page)).toBeEditable()
  await message(page).fill("kept once")
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  await expect
    .poll(async () => (await admin((api) => api.OpenComposer({ chatId: chat.id, tipSlotId: null }))).content)
    .toBe("kept once")
  await expect.poll(() => copies(page)).toEqual([])
  await expect.poll(() => ids.length).toBe(1)
  const kept = await admin((api) => api.OpenComposer({ chatId: chat.id, tipSlotId: null }))
  await admin((api) =>
    api.SendMessage({
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      content: "kept once",
      composer: { draftId: kept.id, session: kept.session }
    })
  )
  release!()
  await expect(message(page)).toHaveValue("")
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))
  expect(recovered.map((r) => r.content)).not.toContain("kept once")
})

// Stream N's fourth review: each a way text was lost, held to the invariants of ARCHITECTURE
// §3.10. The model test (server test/protocol) checks them over random interleavings.

/** Holds the client's RPC messages with `tag` until released, in order. */
const holdRpc = async (page: Page, tag: string) => {
  const held: Array<() => void> = []
  let holding = true
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (holding && typeof data === "string" && JSON.parse(data).tag === tag) held.push(() => upstream.send(data))
      else upstream.send(data)
    })
  })
  return {
    held: () => held.length,
    release: () => {
      holding = false
      for (const send of held.splice(0)) send()
    }
  }
}

test("a send of text a replayed save answered for keeps another tab's newer text in the composer", async ({ page }) => {
  const chat = await admin((api) => api.CreateChat({ title: "Replayed save" }))
  const hold = await holdRpc(page, "SaveComposer")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(message(page)).toBeEditable()
  await message(page).fill("alpha")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(hold.held).toBe(1)
  // The page closing delivers that same save while the socket's copy waits.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  await expect
    .poll(async () => (await admin((api) => api.OpenComposer({ chatId: chat.id, tipSlotId: null }))).content)
    .toBe("alpha")
  const newer = "alpha and the other tab's unsent rest"
  await admin((api) =>
    Effect.gen(function* () {
      const draft = yield* api.OpenComposer({ chatId: chat.id, tipSlotId: null })
      yield* api.SaveComposer({
        next: false,
        operationId: crypto.randomUUID(),
        chatId: chat.id,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        content: newer
      })
    })
  )
  hold.release()
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("alpha")
  await expect(message(page)).toHaveValue(newer)
  const chatNow = await admin((api) => api.GetChat({ chatId: chat.id }))
  const draft = await admin((api) => api.OpenComposer({ chatId: chat.id, tipSlotId: chatNow.activeLeafSlotId }))
  expect([draft.status, draft.content]).toEqual(["active", newer])
})

test("typing on another branch keeps the copy of a branch's text the server refused", async ({ page }) => {
  const seeded = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Refused save" })
      const root = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "root" })
      const parent = root._tag === "Posted" ? root.entry.slotId : null
      const a = yield* api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: false, content: "branch A" })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: true, content: "branch B" })
      return { chat, a: a._tag === "Posted" ? a.entry.slotId : null }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${seeded.chat.id}`)
  await expect(message(page)).toBeEditable()
  // Past the drafts' cap: the server refuses it, and only this browser has it.
  const huge = `Unsent branch B text 842017 ${"z".repeat(1_000_001)}`
  await message(page).fill(huge)
  await expect(page.getByRole("alert")).toBeVisible()
  await page.getByRole("button", { name: "Previous branch", exact: true }).click()
  await expect(message(page)).toHaveValue("")
  await message(page).fill("new text on branch A")
  await expect
    .poll(async () => (await admin((api) => api.OpenComposer({ chatId: seeded.chat.id, tipSlotId: seeded.a }))).content)
    .toBe("new text on branch A")
  expect((await copies(page)).some((copy) => text(copy) === huge)).toBe(true)
  // Back on branch B, the text is in the box again.
  await page.getByRole("button", { name: "Next branch", exact: true }).click()
  await expect(message(page)).toHaveValue(huge)
})

test("text typed while an editor's Undo is on its way stays, saved on top of the earlier text", async ({ page }) => {
  const original = "Original paragraph before an accidental wipe. ".repeat(10)
  const card = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Undo race", name: "Undo race" })
      const field = textField(["description"])
      const first = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: card.id,
        field,
        content: original,
        expectedRowVersion: null,
        baseRevisionId: card.headRevisionId
      })
      yield* api.SaveEditorDraft({
        refId: card.id,
        field,
        draftId: first.id,
        content: "x",
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevisionId: card.headRevisionId
      })
      return card
    })
  )
  const hold = await holdRpc(page, "RestoreEditorDraft")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  await expect(box).toHaveValue("x")
  await page.getByRole("button", { name: "Undo Description", exact: true }).click()
  await expect.poll(hold.held).toBe(1)
  const typed = "Unique keystrokes during undo 847261"
  await box.fill(typed)
  hold.release()
  // The restore lands, and what was typed meanwhile stays on top of it.
  await expect
    .poll(async () =>
      (
        await admin((api) => api.EditorDraftHistory({ refId: card.id, field: textField(["description"]), limit: 10 }))
      ).map((state) => state.kind)
    )
    .toContain("restore")
  await expect(box).toHaveValue(typed)
  await expect
    .poll(async () => (await admin((api) => api.OpenEditor({ refId: card.id }))).drafts[0]!.content)
    .toBe(typed)
})

test("a change that can't reach the server survives its note going to the bin and back", async ({ page }) => {
  const seeded = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Offline card", name: "Offline card" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Offline note" })
      return { card, note }
    })
  )
  const hold = await holdRpc(page, "SaveEditorDraft")
  await page.route("**/library/drafts", (route) => route.abort())
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${seeded.note.id}`)
  const box = page.getByRole("textbox", { name: /^Content/ })
  await expect(box).toBeEditable()
  const unsent = "Unsent offline note text 73519"
  await box.fill(unsent)
  await expect.poll(async () => (await copies(page)).map(text)).toContain(unsent)
  const item = await admin((api) => api.DeleteNote({ noteRefId: seeded.note.id }))
  // In the bin, the note can't be opened, and its copy waits.
  await page.reload()
  await expect(page.getByRole("alert")).toBeVisible()
  expect((await copies(page)).map(text)).toContain(unsent)
  hold.release()
  await page.unroute("**/library/drafts")
  await admin((api) => api.RestoreBinItem({ itemId: item.id }))
  await page.reload()
  await expect(box).toHaveValue(unsent)
  await expect.poll(() => copies(page)).toEqual([])
})

test("text a revision's save sent to the recovered texts is pointed to from the editor", async ({ page }) => {
  const card = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Recovery notice", name: "Recovery notice" })
      yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: card.id,
        field: textField(["description"]),
        content: "hello",
        expectedRowVersion: null,
        baseRevisionId: card.headRevisionId
      })
      return card
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  await expect(box).toHaveValue("hello")
  // Another tab saves the field; this one hasn't seen it, and its save goes on top.
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId: card.id })
      const draft = opened.drafts[0]!
      yield* api.SaveEditorDraft({
        refId: card.id,
        field: draft.key.field,
        draftId: draft.id,
        content: "hello from another tab",
        expectedRowVersion: draft.rowVersion,
        expectedSession: draft.session,
        baseRevisionId: card.headRevisionId
      })
    })
  )
  await box.fill("hello from this tab")
  await expect(page.getByRole("status").filter({ hasText: "kept as drafts" })).toBeVisible()
  await page.getByRole("button", { name: "Save (1)", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Save a revision" })
    .getByRole("button", { name: "Save revision", exact: true })
    .click()
  await expect(page.getByText("Saved a revision.", { exact: true })).toBeVisible()
  await expect(page.getByText("Earlier text is in the bin")).toBeVisible()
  await page.getByRole("link", { name: "bin, under recovered text" }).click()
  await expect(page.getByRole("listitem", { name: /^Recovered from Recovery notice/ })).toContainText(
    "hello from another tab"
  )
})
