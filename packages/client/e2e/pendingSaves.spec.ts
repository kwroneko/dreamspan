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
  save?: { payload: { content: string } }
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
const text = (copy: StoredCopy) => {
  if (copy.save) return copy.save.payload.content
  try {
    return (JSON.parse(copy.content) as { text: string }).text
  } catch {
    return copy.content
  }
}
const message = (page: Page) => page.getByLabel("Message", { exact: true })
const offlineBeacon = (page: Page) =>
  page.evaluate(() => {
    const fetch = window.fetch
    window.fetch = (url, init) =>
      url === "/library/drafts" ? Promise.reject(new Error("synthetic offline")) : fetch(url, init)
  })

for (const { kind, legacy } of [
  { kind: "card", legacy: false },
  { kind: "preset", legacy: false },
  { kind: "card", legacy: true }
] as const) {
  test(`${legacy ? "legacy " : ""}${kind} backup replays its original base and preserves the other tab's text`, async ({
    page
  }) => {
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
    if (legacy)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const request = indexedDB.open("rp-editor-copies", 1)
            request.onsuccess = () => {
              const db = request.result
              const transaction = db.transaction("copies", "readwrite")
              const cursor = transaction.objectStore("copies").openCursor()
              cursor.onsuccess = () => {
                const row = cursor.result
                if (row === null) return
                row.update({ ...row.value, save: undefined })
                row.continue()
              }
              transaction.oncomplete = () => {
                db.close()
                resolve()
              }
            }
          })
      )
    await admin((api) =>
      api.SaveEditorDraft({
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
          fields: opened.drafts.map((d) => ({ field: d.key.field, expectedRowVersion: d.rowVersion })),
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
        composerRowVersion: draft.rowVersion
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
        fields: [{ field, expectedRowVersion: b.rowVersion }],
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
      composerRowVersion: kept.rowVersion
    })
  )
  release!()
  await expect(message(page)).toHaveValue("")
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))
  expect(recovered.map((r) => r.content)).not.toContain("kept once")
})
