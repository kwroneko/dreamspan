// The composer's text as a server draft (DESIGN §6.2): it survives a reload and shows in
// another tab, a send ends it, it can be undone from the server's history, and text typed just
// before the page goes leaves with it, or stays in this browser when it's too long to send.
// Then the races: a request held on its way to the server while the user goes on, each time
// text has to stay where it was typed (ARCHITECTURE §3.10).
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { typeInto } from "./support/composer.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "40" })

/** One login for the file: the server allows an address 50 in 15 minutes. */
let adminCookie: Promise<string> | null = null
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => {
  adminCookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)
  return adminCookie.then((cookie) => withCookie(server(), cookie, use))
}

const box = (page: Page) => page.getByLabel("Message", { exact: true })

/** A new chat, open, and its id. */
const newChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat" }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(box(page)).toBeEditable()
  return page.url().split("/chats/")[1]!.split("?")[0]! as ChatId
}

/** The composer's text on the server at a tip. */
const onServer = (chatId: ChatId, tipSlotId: SlotId | null) =>
  admin((api) => api.OpenComposer({ chatId, tipSlotId })).then((draft) =>
    draft.status === "active" ? draft.content : ""
  )

const leaf = (chatId: ChatId) => admin((api) => api.GetChat({ chatId })).then((chat) => chat.activeLeafSlotId)

test("the composer's text is on the server: a reload and another tab show it, and sending ends it", async ({
  page,
  context
}) => {
  const chatId = await newChat(page, "Harbor")
  await box(page).fill("Half a thought about the harbor")
  await expect.poll(() => onServer(chatId, null)).toBe("Half a thought about the harbor")
  await page.reload()
  await expect(box(page)).toHaveValue("Half a thought about the harbor")

  const other = await context.newPage()
  await other.goto(page.url())
  await expect(box(other)).toHaveValue("Half a thought about the harbor")
  await other.close()

  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByRole("article", { name: "Your message" })).toHaveText(/Half a thought/)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
  // Typed while the reply came: it moves on with the chat, and stays after a reload.
  await box(page).fill("And then")
  await expect.poll(async () => onServer(chatId, await leaf(chatId))).toBe("And then")
  await page.reload()
  await expect(box(page)).toHaveValue("And then")
  await box(page).fill("")
  await expect.poll(async () => onServer(chatId, await leaf(chatId))).toBe("")
  await page.reload()
  await expect(box(page)).toHaveValue("")
})

test("an earlier text comes back from the server's history", async ({ page }) => {
  const chatId = await newChat(page, "History")
  const long = "A long paragraph about the lighthouse keeper and the storm. ".repeat(5).trim()
  await box(page).fill(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
  // Select-all and a stray key.
  await box(page).fill("x")
  await expect.poll(() => onServer(chatId, null)).toBe("x")
  await page.getByRole("button", { name: "Earlier text of this message" }).click()
  await page
    .getByRole("dialog", { name: "Earlier text" })
    .getByRole("button")
    .filter({ hasText: `${long.length} characters` })
    .click()
  await expect(box(page)).toHaveValue(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
})

/** Records each request to /library/drafts: whether it was sent with `keepalive`. */
const recordBeacons = (page: Page) =>
  page.evaluate(() => {
    const original = window.fetch
    const sent: Array<boolean> = []
    Object.assign(window, { __beacons: sent })
    window.fetch = (input, init) => {
      if (input === "/library/drafts") sent.push(init?.keepalive === true)
      return original(input, init)
    }
  })

const beacons = (page: Page) => page.evaluate(() => (window as unknown as { __beacons: Array<boolean> }).__beacons)

test("text typed just before closing the tab leaves with it, after a warning", async ({ page }) => {
  const chatId = await newChat(page, "Closing")
  await recordBeacons(page)
  await box(page).fill("Typed in the last moment.")
  const warned = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(warned).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  expect(await beacons(page)).toEqual([true])
  await page.close()
  await expect.poll(() => onServer(chatId, null)).toBe("Typed in the last moment.")
})

test("text too long to send as the page goes comes back from this browser on a reload", async ({ page }) => {
  // The server never hears of the text before the page goes (a connection gone bad, say).
  let blocked = false
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (!(blocked && typeof data === "string" && data.includes('"SaveComposer"'))) upstream.send(data)
    })
  })
  const chatId = await newChat(page, "Long")
  page.on("dialog", (dialog) => void dialog.accept())
  const long = "y".repeat(70_000)
  blocked = true
  await box(page).fill(long)
  await page.waitForTimeout(1000)
  expect(await onServer(chatId, null)).toBe("")
  blocked = false
  await page.reload()
  await expect(page.getByText("Text this browser kept")).toBeVisible()
  await expect(box(page)).toHaveValue(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
})

// --- Races

/** Sends `content` under `parent` (a branch when it isn't the leaf), and returns its slot. */
const send = (api: Client, chatId: ChatId, parent: SlotId | null, content: string, branch = false) =>
  Effect.map(api.SendMessage({ chatId, parentSlotId: parent, branch, content }), (result: SendResult) => {
    if (result._tag !== "Posted") throw new Error("expected it to post")
    return result.entry.slotId
  })

/**
 * Holds the first `tag` request the page sends once armed (and `when` its payload), until
 * released. Set up before the page opens.
 */
const holdRequest = async (
  page: Page,
  tag: string,
  when: (payload: Record<string, unknown>) => boolean = () => true
) => {
  let armed = false
  let held: (() => void) | null = null
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (armed && held === null && typeof data === "string") {
        const message = JSON.parse(data) as { tag?: string; payload?: Record<string, unknown> }
        if (message.tag === tag && when(message.payload ?? {})) {
          held = () => upstream.send(data)
          return
        }
      }
      upstream.send(data)
    })
  })
  return {
    arm: () => void (armed = true),
    held: () => held !== null,
    release: () => held!()
  }
}

const message = (page: Page, text: string) =>
  page.getByRole("article", { name: "Your message" }).filter({ hasText: text })

const replied = (page: Page) =>
  expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })

test("a send takes the text as it was at the click; typing while it's saved is the next message", async ({ page }) => {
  const save = await holdRequest(page, "SaveComposer")
  const chatId = await newChat(page, "Typing on")
  const long = "This is the message as it was when Send was clicked. ".repeat(10).trim()
  await box(page).fill(long)
  save.arm()
  await page.getByRole("button", { name: "Send" }).click()
  await expect.poll(save.held).toBe(true)
  await box(page).fill("x")
  save.release()
  await expect(message(page, "This is the message")).toContainText(long)
  await replied(page)
  await expect(box(page)).toHaveValue("x")
  await expect.poll(async () => onServer(chatId, await leaf(chatId))).toBe("x")
})

test("a send whose branch changed before it went isn't sent, and stays in that branch's composer", async ({ page }) => {
  const setup = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Switched" })
      const root = yield* send(api, chat.id, null, "root")
      const a = yield* send(api, chat.id, root, "branch A")
      const b = yield* send(api, chat.id, root, "branch B", true)
      yield* typeInto(api, chat.id, a, "saved draft A")
      yield* typeInto(api, chat.id, b, "saved draft B")
      return { chatId: chat.id, a, b }
    })
  )
  const save = await holdRequest(page, "SaveComposer")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${setup.chatId}`)
  await expect(box(page)).toHaveValue("saved draft B")
  save.arm()
  await box(page).fill("new typing for B")
  await page.getByRole("button", { name: "Send" }).click()
  await expect.poll(save.held).toBe(true)
  await page.getByRole("button", { name: "Previous branch" }).click()
  await expect(message(page, "branch A")).toBeVisible()
  save.release()
  await expect(page.getByRole("alert")).toContainText("The branch changed before this was sent")
  await expect(box(page)).toHaveValue("saved draft A")
  await expect.poll(() => onServer(setup.chatId, setup.b)).toBe("new typing for B")
  expect(await onServer(setup.chatId, setup.a)).toBe("saved draft A")
  await expect(message(page, "new typing for B")).toHaveCount(0)
})

test("a tab that typed nothing takes another tab's newer text when the leaf moves on", async ({ page }) => {
  const setup = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Idle" })
      const root = yield* send(api, chat.id, null, "root")
      return { chatId: chat.id, root, draft: yield* typeInto(api, chat.id, root, "alpha") }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${setup.chatId}`)
  await expect(box(page)).toHaveValue("alpha")
  const appended = await admin((api) =>
    Effect.gen(function* () {
      yield* typeInto(api, setup.chatId, setup.root, "alpha plus", setup.draft)
      return yield* send(api, setup.chatId, setup.root, "from the other tab")
    })
  )
  await expect(message(page, "from the other tab")).toBeVisible()
  await expect(box(page)).toHaveValue("alpha plus")
  await page.waitForTimeout(1000)
  expect(await onServer(setup.chatId, appended)).toBe("alpha plus")
})

test("going through branches quickly saves each text on the branch it was typed on", async ({ page }) => {
  const setup = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Quick" })
      const root = yield* send(api, chat.id, null, "common root")
      const a = yield* send(api, chat.id, root, "branch A")
      const b = yield* send(api, chat.id, root, "branch B", true)
      const c = yield* send(api, chat.id, root, "branch C", true)
      yield* api.SwitchBranch({ chatId: chat.id, slotId: c, index: 0 })
      return { chatId: chat.id, a, b }
    })
  )
  const open = await holdRequest(page, "OpenComposer", (payload) => payload.tipSlotId === setup.b)
  open.arm()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${setup.chatId}`)
  await expect(box(page)).toBeEditable()
  await box(page).fill("unsaved typing for A")
  await page.getByRole("button", { name: "Next branch" }).click()
  await expect.poll(open.held).toBe(true)
  await expect(page.getByText("branch 2 of 3")).toBeVisible()
  await page.getByRole("button", { name: "Next branch" }).click()
  await expect(page.getByText("branch 3 of 3")).toBeVisible()
  open.release()
  await expect(box(page)).toBeEditable()
  await expect(box(page)).toHaveValue("")
  expect(await onServer(setup.chatId, setup.a)).toBe("unsaved typing for A")
  expect(await onServer(setup.chatId, setup.b)).toBe("")
})

test("a send that another tab typed past keeps that tab's text in the composer", async ({ page }) => {
  const sending = await holdRequest(page, "SendMessage")
  const chatId = await newChat(page, "Past")
  await box(page).fill("text sent from this tab")
  await expect.poll(() => onServer(chatId, null)).toBe("text sent from this tab")
  sending.arm()
  await page.getByRole("button", { name: "Send" }).click()
  await expect.poll(sending.held).toBe(true)
  const newer = "newer text typed in another tab"
  await admin((api) => typeInto(api, chatId, null, newer))
  sending.release()
  await expect(message(page, "text sent from this tab")).toBeVisible()
  await replied(page)
  await expect(box(page)).toHaveValue(newer)
  await page.waitForTimeout(1000)
  expect(await onServer(chatId, await leaf(chatId))).toBe(newer)
})

test("text typed while an earlier text is being restored stays, on top of it", async ({ page }) => {
  const restore = await holdRequest(page, "RestoreComposer")
  const chatId = await newChat(page, "Restoring")
  const long = "A long paragraph about the lighthouse keeper and the storm. ".repeat(5).trim()
  await box(page).fill(long)
  await expect.poll(() => onServer(chatId, null)).toBe(long)
  await box(page).fill("x")
  await expect.poll(() => onServer(chatId, null)).toBe("x")
  restore.arm()
  await page.getByRole("button", { name: "Earlier text of this message" }).click()
  await page
    .getByRole("dialog", { name: "Earlier text" })
    .getByRole("button")
    .filter({ hasText: `${long.length} characters` })
    .click()
  await expect.poll(restore.held).toBe(true)
  await box(page).fill("x, and typed on")
  restore.release()
  await expect.poll(() => onServer(chatId, null)).toBe("x, and typed on")
  await expect(box(page)).toHaveValue("x, and typed on")
})

test("going back to a branch's tip shows its own composer, not the one typed in on the way", async ({ page }) => {
  const chatId = await newChat(page, "Back")
  await box(page).fill("a message made in this tab")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(message(page, "a message made in this tab")).toBeVisible()
  await replied(page)
  await box(page).fill("draft at the tip")
  await expect.poll(async () => onServer(chatId, await leaf(chatId))).toBe("draft at the tip")
  await message(page, "a message made in this tab").getByRole("link", { name: "Branch from here" }).click()
  await expect(box(page)).toBeEditable()
  await box(page).fill("draft for a branch from the first message")
  await page.getByRole("link", { name: "Back to the latest branch" }).click()
  await expect(box(page)).toBeEditable()
  await expect(box(page)).toHaveValue("draft at the tip")
})

test("starting a branch copies the composer into it", async ({ page }) => {
  const setup = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Copied" })
      const root = yield* send(api, chat.id, null, "root to branch from")
      const tip = yield* send(api, chat.id, root, "the current end")
      yield* typeInto(api, chat.id, tip, "half typed continuation")
      return { chatId: chat.id, root, tip }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${setup.chatId}`)
  await expect(box(page)).toHaveValue("half typed continuation")
  await message(page, "root to branch from").getByRole("link", { name: "Branch from here" }).click()
  await expect(box(page)).toBeEditable()
  await expect(box(page)).toHaveValue("half typed continuation")
  expect(await onServer(setup.chatId, setup.root)).toBe("half typed continuation")
  // A copy: the branch it came from keeps its own.
  expect(await onServer(setup.chatId, setup.tip)).toBe("half typed continuation")
})

test("closing while a send is out keeps what was typed after it", async ({ page }) => {
  // Once the send leaves, nothing more comes back from the server before the page goes.
  let armed = false
  let cut = false
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (armed && typeof data === "string" && (JSON.parse(data) as { tag?: string }).tag === "SendMessage") cut = true
      upstream.send(data)
    })
    upstream.onMessage((data) => {
      if (!cut) socket.send(data)
    })
  })
  const chatId = await newChat(page, "Closing mid-send")
  await box(page).fill("the first message")
  await expect.poll(() => onServer(chatId, null)).toBe("the first message")
  armed = true
  await page.getByRole("button", { name: "Send" }).click()
  await expect.poll(() => cut).toBe(true)
  await box(page).fill("the next message")
  await expect.poll(() => leaf(chatId)).not.toBeNull()
  // Without this browser's copy, as on another device: the request sent as the page goes keeps it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("rp-editor-copies", 1)
        request.onsuccess = () => {
          const transaction = request.result.transaction("copies", "readwrite")
          transaction.objectStore("copies").clear()
          transaction.oncomplete = () => resolve()
        }
      })
  )
  page.on("dialog", (dialog) => void dialog.accept())
  armed = false
  cut = false
  await page.reload()
  await expect(box(page)).toHaveValue("the next message")
  expect(await onServer(chatId, await leaf(chatId))).toBe("the next message")
})

test("a copy this browser kept of another chat's composer is saved when a composer opens", async ({ page }) => {
  const setup = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Elsewhere" })
      return { chatId: chat.id, draft: yield* typeInto(api, chat.id, null, "on the server"), user: yield* api.Whoami() }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  const { draft } = setup
  await page.evaluate(
    (copy) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("rp-editor-copies", 1)
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("copies", { keyPath: "key" })
          store.createIndex("userId", "userId")
          store.createIndex("ref", ["userId", "refId"])
        }
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction("copies", "readwrite")
          transaction.objectStore("copies").put({ ...copy, key: `${copy.userId}\n${copy.refId}\n${copy.field}` })
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    {
      userId: setup.user.id,
      refId: `composer:${setup.chatId}`,
      field: draft.id,
      content: JSON.stringify({
        text: "kept in this browser",
        rowVersion: draft.rowVersion,
        session: draft.session,
        next: false
      }),
      // From a page closed a while ago, before the server had it.
      at: Date.now() - 60_000
    }
  )
  await newChat(page, "Somewhere else")
  await expect.poll(() => onServer(setup.chatId, null)).toBe("kept in this browser")
})
