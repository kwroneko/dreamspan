import { expectTextBox } from "./support/textbox.ts"
// What a message keeps whatever happens around it: the text typed into its editor across a
// reload, across a closed tab while the server was down, while its version is being saved and
// when replayed from this browser over text saved elsewhere, its version arrows on every
// reply, its speaker and side when the version it started with is deleted, the text
// streamed so far when it's copied, and, on a phone, the start of why it isn't sent when a
// tap reveals its actions.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { type Copy, makeCopy } from "../src/features/editor/backup.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser, type Client, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60", FAKE_GENERATOR_TOKENS: "600" })

const create = () => asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: "Drafts" }))

const open = async (page: Page, chatId: ChatId, search = "") => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}${search}`)
}

/** Sends a message and stops its reply before it's done: the chat's last reply, its own slot. */
const stoppedReply = async (page: Page, text: string) => {
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByText("generating", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Stop", exact: true }).last().click()
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
  const slot = await page.getByRole("article", { name: "Reply", exact: true }).last().getAttribute("data-slot")
  return page.locator(`article[data-slot="${slot}"]`)
}

test("the text of a version being written, and of an edit, survives a reload and opens again", async ({ page }) => {
  const chat = await create()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The original turn." })
  )
  await open(page, chat.id)
  const row = page.locator("article[data-slot]").first()
  await messageMenu(row, "Write your own swipe")
  await row.getByLabel("Your swipe", { exact: true }).fill("An irreplaceable draft assembled from several swipes.")
  await page.waitForTimeout(1000)
  await page.reload()
  // The editor is open again where it was, with its text.
  await expectTextBox(
    row.getByLabel("Your swipe", { exact: true }),
    "An irreplaceable draft assembled from several swipes."
  )
  await row.getByRole("button", { name: "Add as a new swipe" }).click()
  await expect(row.locator(".markdown")).toHaveText("An irreplaceable draft assembled from several swipes.")
  await page.reload()
  await expect(row.locator(".markdown")).toHaveText("An irreplaceable draft assembled from several swipes.")
  await expect(row.getByLabel("Your swipe", { exact: true })).toHaveCount(0)

  await showActions(row)
  await row.getByRole("button", { name: "Edit", exact: true }).click()
  await row.getByLabel("Message text", { exact: true }).fill("An edit half done.")
  await page.waitForTimeout(1000)
  await page.reload()
  await expectTextBox(row.getByLabel("Message text", { exact: true }), "An edit half done.")
  // Cancelling closes it: its text stays in the edit's history (owner, 2026-11-02), not back in the box.
  await row.getByRole("button", { name: "Cancel" }).click()
  await expect(row.getByLabel("Message text", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(row.locator(".markdown")).toHaveText("An irreplaceable draft assembled from several swipes.")
  await expect(row.getByLabel("Message text", { exact: true })).toHaveCount(0)
})

test("text typed into a message editor while the server is down survives closing the tab", async ({
  page,
  context
}) => {
  const chat = await create()
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The original turn." })
  )
  await open(page, chat.id)
  const row = page.locator("article[data-slot]").first()
  await messageMenu(row, "Write your own swipe")
  await row.getByLabel("Your swipe", { exact: true }).fill("Server-saved prefix.")
  await page.waitForTimeout(1000)
  // The server goes away with the tab still open; what's typed now never reaches it.
  await server().pause()
  const text = "Server-saved prefix. An irreplaceable paragraph written while the connection is down."
  await row.getByLabel("Your swipe", { exact: true }).fill(text)
  await page.waitForTimeout(1000)
  await page.close()
  await server().restart()

  // This browser kept a copy: opening the chat again sends it, and the editor has it all.
  const reopened = await context.newPage()
  await reopened.goto(`${server().url}/chats/${chat.id}`)
  const again = reopened.locator("article[data-slot]").first()
  await expectTextBox(again.getByLabel("Your swipe", { exact: true }), text)
  // On the server now: once the version is saved, a reload doesn't bring the editor back.
  await again.getByRole("button", { name: "Add as a new swipe" }).click()
  await expect(again.locator(".markdown")).toHaveText(text)
  await reopened.reload()
  await expect(again.locator(".markdown")).toHaveText(text)
  await expect(again.getByLabel("Your swipe", { exact: true })).toHaveCount(0)
})

const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)

/** This browser's copies of text not on the server yet (editor/backup.ts). */
const copies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<Copy>>((resolve) => {
        const request = indexedDB.open("dreamspan-editor-copies", 1)
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("copies", { keyPath: "key" })
          store.createIndex("userId", "userId")
          store.createIndex("ref", ["userId", "refId"])
        }
        request.onsuccess = () => {
          const db = request.result
          const all = db.transaction("copies").objectStore("copies").getAll()
          all.onsuccess = () => {
            db.close()
            resolve(all.result as Array<Copy>)
          }
        }
      })
  )
const contents = async (page: Page) => (await copies(page)).map((copy) => copy.content)

/** A chat with one message of the user's, and the user. */
const oneMessage = () =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Drafts" })
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "The turn." })
      if (sent._tag !== "Posted") return yield* Effect.die(new Error("the message was queued"))
      return { chat, entry: sent.entry, me: yield* api.Whoami() }
    })
  )

for (const kind of ["Write", "Edit"] as const) {
  test(`${kind}: text typed while the version is being saved stays in the editor`, async ({ page }) => {
    const { chat, entry } = await oneMessage()
    // The version's save waits until released; the box stays usable meanwhile.
    const commit = kind === "Write" ? "WriteVersion" : "AmendVersion"
    let release: (() => void) | null = null
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string" && JSON.parse(data).tag === commit) release = () => upstream.send(data)
        else upstream.send(data)
      })
    })
    await open(page, chat.id)
    const row = page.locator(`article[data-slot="${entry.slotId}"]`)
    if (kind === "Write") await messageMenu(row, "Write your own swipe")
    else {
      await showActions(row)
      await row.getByRole("button", { name: "Edit", exact: true }).click()
    }
    const box = row.getByLabel(kind === "Write" ? "Your swipe" : "Message text", { exact: true })
    const submitted = "The text saved as the version."
    const later = "The text saved as the version. More typed while it was being saved."
    await box.fill(submitted)
    await expect
      .poll(async () => (await admin((api) => api.MessageDrafts({ chatId: chat.id })))[0]?.content)
      .toBe(submitted)
    await row.getByRole("button", { name: kind === "Write" ? "Add as a new swipe" : "Save", exact: true }).click()
    await expect.poll(() => release !== null).toBe(true)
    await box.fill(later)
    await expect.poll(() => contents(page)).toContain(later)
    // Answered before the newer text's own save: the version holds what was submitted, and
    // the editor stays open with what was typed since, its copy kept until the server has it.
    release!()
    await expect
      .poll(async () => (await admin((api) => api.ListVersions({ slotId: entry.slotId }))).map((v) => v.content))
      .toContain(submitted)
    await expectTextBox(box, later)
    await expect
      .poll(async () => (await admin((api) => api.MessageDrafts({ chatId: chat.id })))[0]?.content)
      .toBe(later)
    await expect.poll(() => copies(page)).toEqual([])
    await page.reload()
    await expectTextBox(box, later)
  })
}

test("text replayed from this browser that the server refused is retried on the draft it was typed on", async ({
  page,
  context
}) => {
  const { chat, entry } = await oneMessage()
  const target = { _tag: "Write", slotId: entry.slotId } as const
  const first = await admin((api) =>
    api.SaveMessageDraft({
      target,
      draftId: null,
      content: "A shared prefix for a paragraph.",
      expectedRowVersion: null,
      expectedSession: null
    })
  )
  // Typed here while this browser can't reach the server, then the tab is closed.
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (typeof data === "string" && JSON.parse(data).tag === "SaveMessageDraft") return
      upstream.send(data)
    })
  })
  await open(page, chat.id)
  const offline = `${first.content} offline A`
  await page.getByLabel("Your swipe", { exact: true }).fill(offline)
  await expect.poll(() => contents(page)).toContain(offline)
  await page.close()
  // Another device saves a small change to the same draft.
  const elsewhere = `${first.content} other B`
  await admin((api) =>
    api.SaveMessageDraft({
      target,
      draftId: first.id,
      content: elsewhere,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session
    })
  )
  // Reopened, the replay fails once; the text is retried, with more typed, and saved as a version.
  const back = await context.newPage()
  const sent: Array<{ expectedRowVersion: number | null }> = []
  let fail = true
  await back.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request =
        typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string; payload?: never }) : null
      if (request?.tag === "SaveMessageDraft") {
        sent.push(request.payload!)
        if (fail) {
          fail = false
          const error = { _tag: "ServerError", message: "Synthetic transient failure" }
          const exit = { _tag: "Failure", cause: [{ _tag: "Fail", error }] }
          socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit }))
          return
        }
      }
      upstream.send(data)
    })
  })
  await back.goto(`${server().url}/chats/${chat.id}`)
  const box = back.getByLabel("Your swipe", { exact: true })
  await expectTextBox(box, offline)
  await expect(back.getByRole("alert")).toContainText("The text isn’t saved as a draft yet")
  await box.fill(`${offline}!`)
  await expect
    .poll(async () => (await admin((api) => api.MessageDrafts({ chatId: chat.id })))[0]?.content)
    .toBe(`${offline}!`)
  // Every attempt named the draft as this browser had it, not as the other device left it.
  expect(sent.map((payload) => payload.expectedRowVersion)).toEqual([first.rowVersion, first.rowVersion])
  // So the other device's text went one step back, and the editor says so.
  await expect(back.getByText("This browser's text replaced text saved elsewhere")).toBeVisible()
  await back.getByRole("button", { name: "Add as a new swipe" }).click()
  await expect(box).toHaveCount(0)
  // Saved as a version, the other device's text is in the recovered texts.
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))
  expect(recovered.map((text) => text.content)).toContain(elsewhere)
})

test("a replay from this browser that goes over text saved elsewhere says so until acknowledged", async ({ page }) => {
  const { chat, entry, me } = await oneMessage()
  const target = { _tag: "Write", slotId: entry.slotId } as const
  const first = await admin((api) =>
    api.SaveMessageDraft({
      target,
      draftId: null,
      content: "Shared prefix.",
      expectedRowVersion: null,
      expectedSession: null
    })
  )
  const elsewhere = "Shared prefix. Typed on the other device."
  await admin((api) =>
    api.SaveMessageDraft({
      target,
      draftId: first.id,
      content: elsewhere,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session
    })
  )
  // This browser kept text typed on the first save, which never reached the server.
  await open(page, chat.id)
  await expectTextBox(page.getByLabel("Your swipe", { exact: true }), elsewhere)
  const offline = "Shared prefix. Typed offline here."
  const copy = makeCopy(
    me.id,
    `messages:${chat.id}`,
    `write:${entry.slotId}`,
    {
      kind: "message",
      payload: {
        target,
        draftId: first.id,
        content: offline,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session
      }
    },
    Date.now()
  )
  await copies(page)
  await page.evaluate(
    (copy) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("dreamspan-editor-copies", 1)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction("copies", "readwrite")
          transaction.objectStore("copies").put(copy)
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    copy
  )
  await page.reload()
  const box = page.getByLabel("Your swipe", { exact: true })
  await expectTextBox(box, offline)
  await expect.poll(() => copies(page)).toEqual([])
  const notice = page.getByRole("status").filter({ hasText: "This browser's text replaced text saved elsewhere" })
  await expect(notice).toBeVisible()
  await notice.getByText("View the other text").click()
  await expect(notice.getByText(elsewhere, { exact: true })).toBeVisible()
  // Typing keeps it. Switching is explicit and can itself be undone from server history.
  await box.fill(`${offline} More.`)
  await expect(notice).toBeVisible()
  await notice.getByRole("button", { name: "Use the other text" }).click()
  await expect(notice).toHaveCount(0)
  await expectTextBox(box, elsewhere)
  await page.getByRole("button", { name: "History of this edit" }).click()
  await page.getByRole("menuitem", { name: "Earlier draft text…" }).click()
  const history = page.getByRole("dialog", { name: "Earlier draft text", exact: true })
  await history.getByRole("button", { name: "Restore draft text" }).first().click()
  await expectTextBox(box, `${offline} More.`)
  // Saved as a version, the other text is in the recovered texts.
  await page.getByRole("button", { name: "Add as a new swipe" }).click()
  await expect(box).toHaveCount(0)
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 100, before: null }))
  expect(recovered.map((text) => text.content)).toContain(elsewhere)
})

test("an older reply keeps its version arrows with one version", async ({ page }) => {
  const chat = await create()
  await open(page, chat.id)
  const first = await stoppedReply(page, "First turn.")
  await page.getByLabel("Message", { exact: true }).fill("Next turn.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(2)
  const versions = first.getByRole("group", { name: "Swipes", exact: true })
  await expect(versions).toBeVisible()
  await expect(versions.getByRole("button", { name: "Generate another swipe" })).toBeVisible()
})

test("copy text copies the text already shown while a version is streaming", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const chat = await create()
  await open(page, chat.id)
  await page.getByLabel("Message", { exact: true }).fill("A streaming reply.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await expect(reply.locator(".markdown")).toBeVisible()
  await page.waitForTimeout(500)
  await messageMenu(reply, "Copy text")
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.length).toBeGreaterThan(0)
  // The text's source (Markdown): its first words are the first the message shows.
  const words = (text: string) => (text.match(/[A-Za-z]+/g) ?? []).join(" ")
  expect(words(await reply.locator(".markdown").innerText())).toContain(words(copied).split(" ").slice(0, 4).join(" "))
})

test("a reply written by hand keeps its speaker and its generating › after the original is deleted", async ({
  page
}) => {
  const chat = await create()
  await open(page, chat.id)
  const row = await stoppedReply(page, "First turn.")
  await messageMenu(row, "Write your own swipe")
  await row.getByLabel("Your swipe", { exact: true }).fill("My assembled reply.")
  await row.getByRole("button", { name: "Add as a new swipe" }).click()
  await row.getByRole("button", { name: "Previous swipe", exact: true }).click()
  await showActions(row)
  await row.getByRole("button", { name: "Delete swipe", exact: true }).click()
  await expect(row.locator(".markdown")).toHaveText("My assembled reply.")
  await expect(row).toHaveAttribute("aria-label", "Reply")
  await expect(row.getByRole("button", { name: "Generate another swipe", exact: true })).toBeVisible()
})

test("on a phone, a tap on a long message out of the context shows the start of why", async ({ page }) => {
  // Budgets belong to the model (20c7164), so give the fixture an explicit small
  // context and response reserve instead of relying on model-less defaults.
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Out-of-context fixture",
          baseUrl: "http://127.0.0.1:5999/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "small-context",
        overrides: { settings: { samplers: { openai_max_context: 2500, openai_max_tokens: 300 } } }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return yield* api.StartStImport({ unsupported: [] })
    })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const upload = async (path: string, body: Uint8Array) => {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  // History fitting uses o200k now (53ff6407, DESIGN §4), so repeated x/b text
  // is smaller than chars/4. This budget keeps the short tail, but not depth 6.
  await upload("characters/Mira.png", card("Mira", "Hello.", {}, { description: "x".repeat(11_000) }))
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of a long turn. ${"b".repeat(80)}`).join("\n\n")
  await upload(
    "chats/Mira/Long turns.jsonl",
    jsonl([
      header({}),
      ...Array.from({ length: 12 }, (_, i) =>
        message({ name: i % 2 ? "Sam" : "Mira", user: i % 2 === 1, minute: i, mes: i === 6 ? long : `Turn ${i}.` })
      )
    ])
  )
  const { chatId, slotId, firstSent } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = (yield* api.ListChats({ limit: 10, before: null })).find((c) => c.title === "Long turns")!
      const { entries } = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      expect(next.assemblyError).toBeNull()
      expect(next.historyStart?.depth, JSON.stringify(next.budget)).toBeGreaterThan(6)
      expect(next.historyStart?.depth).toBeLessThan(12)
      return { chatId: chat.id, slotId: entries[6]!.slotId, firstSent: next.historyStart!.depth + 1 }
    })
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, chatId, `?slot=${slotId}`)
  const row = page.locator(`article[data-slot="${slotId}"]`)
  await expect(row).toHaveAttribute("data-out-of-context", "true")
  await row.locator(".markdown").click({ position: { x: 20, y: 20 } })
  await expect(row.getByRole("toolbar", { name: "Message actions" })).toBeVisible()
  const reason = row.getByText(new RegExp(`^Not sent to the model: the history sent starts at #${firstSent}\\b`))
  await expect(reason).toBeVisible()
  await expect
    .poll(async () => {
      const box = (await reason.boundingBox())!
      const list = (await page.getByTestId("messages").boundingBox())!
      return box.y >= list.y && box.y + box.height <= list.y + list.height
    })
    .toBe(true)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a long message's editor footer stays in view at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"A long synthetic turn. ".repeat(8)}`).join(
        "\n\n"
      )
      const { chat, entry } = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Long editor footer" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: long,
            reply: false
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return { chat, entry: sent.entry }
        })
      )
      await open(page, chat.id, `?slot=${entry.slotId}`)
      const row = page.locator(`article[data-slot="${entry.slotId}"]`)
      await messageMenu(row, "Edit")
      await expectTextBox(row.getByRole("textbox", { name: "Message text", exact: true }), long)
      const cancel = row.getByRole("button", { name: "Cancel", exact: true })
      await expect(cancel).toBeInViewport()
      await expectLayout(page, info, "long-message-editor-footer", { scope: '[data-testid="messages"]' })
      await expect(cancel).toBeInViewport()
    })
