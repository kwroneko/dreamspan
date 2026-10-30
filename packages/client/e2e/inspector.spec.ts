import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import type { WireContext } from "../../server/src/assembler/types.ts"
// The request inspector and the cache-warmth indicator (DESIGN §5.5, §7.4), against the
// production server, which generates through the context assembler and the provider
// layer, here a fake OpenAI-compatible provider on loopback. The card is made up.
import { join } from "node:path"
import type { ChatId, EntityId, VersionId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, REPLY, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let chat: { readonly id: ChatId; readonly reply: VersionId }

/** Imports a file into the library as the admin, as the import screen does; returns its ref. */
const importFile = async (name: string, file: unknown): Promise<RefId> => {
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  const imported = await fetch(`${server().url}/library/import?name=${name}`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify(file)
  })
  expect(imported.status).toBe(200)
  return ((await imported.json()) as { library: { ref: { id: RefId } } }).library.ref.id
}

test.beforeAll(async () => {
  provider = await startProvider()
  await importFile("Mira.json", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Mira", description: "{{char}} keeps the harbor ledger.", first_mes: "*Mira looks up.*" }
  })
  chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-inspector-test-key-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The road flooded.", speakerEntityId: null }
      })
      const reply = yield* api.Generate({ chatId: started.chat.id, parentSlotId: started.entry.slotId, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { id: started.chat.id, reply: reply.entry.version.id }
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const violations: Array<string> = []
test.beforeEach(({ page }) => {
  violations.length = 0
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
})
test.afterEach(() => expect(violations).toEqual([]))

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
}

const reply = (page: Page) => page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })

test("usage headers fit without clipping on a 390px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  const usage = page.getByLabel("Usage by attempt")
  const labels = usage.locator("dt")
  await expect(labels).toHaveText(["Attempt", "Input", "Cache read", "Cache write", "Output", "Cost"])
  const values = usage.locator("dd")
  const wrapping = await values.evaluateAll((nodes) =>
    nodes.map((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const text = range.getBoundingClientRect()
      const cell = node.getBoundingClientRect()
      return { lines: range.getClientRects().length, fits: text.right <= cell.right + 1 }
    })
  )
  expect(wrapping.every(({ lines, fits }) => lines === 1 && fits)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await shoot(page, "inspector-phone")
})

test("a reply's context opens from the reply, with its sources and the cache breakpoints", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(reply(page)).toContainText(REPLY)
  await messageMenu(reply(page), "Context it was generated from")
  await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}/context/${chat.reply}\\?fork=[^&]+$`))
  const messages = page.getByRole("region", { name: "Messages" })
  await expect(messages.getByText("Card “Mira”: description")).toBeVisible()
  await expect(messages.getByText("Preset prompt “Main Prompt”")).toBeVisible()
  await expect(messages.getByText("Cache breakpoint: the end of the preset's part")).toBeVisible()
  await expect(messages.getByText("Cache breakpoint: the end of the history the next request repeats")).toBeVisible()
  await expect(page.getByText("fake-small on Local model server (openai-chat)")).toBeVisible()
  // What the provider reported: 100 tokens read from its cache, 6 written.
  await expect(page.getByRole("row", { name: /complete/ })).toContainText("100")
  // A short context opens with every turn's text showing, each part in a box naming its source.
  const card = messages.getByRole("region", { name: "Card “Mira”: description" })
  await expect(card.getByText("Mira keeps the harbor ledger.", { exact: true })).toBeVisible()
  await expect(card.getByRole("link", { name: "Card “Mira”: description" })).toHaveAttribute("href", /\/library\//)
  await shoot(page, "inspector")
  // The message sources link back to the chat.
  await messages.getByRole("link", { name: "Message 2" }).click()
  // The viewed fork rides along; the chat drops it from the URL once it's the current one.
  await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}\\?(fork=[^&]+&)?slot=`))
})

test("an earlier reply and a swipe each open their own request from the message's button", async ({ page }) => {
  const made = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The bell rang twice.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      /** Waits for the latest reply to finish, so the next message isn't queued behind it. */
      const settled = Effect.gen(function* () {
        for (;;) {
          const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          if (path.entries.at(-1)!.version.status !== "generating") return
          yield* Effect.sleep(50)
        }
      })
      const first = yield* api.Generate({ chatId, parentSlotId: started.entry.slotId, branch: false })
      if (first._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      yield* settled
      const sent = yield* api.SendMessage({
        chatId,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "Nobody answered."
      })
      if (sent._tag !== "Posted") return yield* Effect.die(new Error("the message was queued"))
      const second = yield* api.Generate({ chatId, parentSlotId: sent.entry.slotId, branch: false })
      if (second._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      yield* settled
      const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const last = path.entries.at(-1)!
      const swipe = yield* api.Regenerate({ slotId: last.slotId, expectedRowVersion: last.rowVersion })
      return { id: chatId, first: first.entry.version.id, swipe: swipe.version.id }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${made.id}`)
  const replies = page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })
  await expect(replies).toHaveCount(2)
  // The swipe, the second version of the last reply.
  await showActions(replies.last())
  await replies.last().getByRole("link", { name: "Request it was generated from" }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${made.id}/context/${made.swipe}\\?fork=[^&]+$`))
  await expect(page.getByText(/^swipe, /)).toBeVisible()
  const messages = page.getByRole("region", { name: "Messages" })
  // The earlier reply is in its history, by message and version.
  await expect(messages.getByRole("link", { name: "Message 3, version 1" })).toBeVisible()
  await page.getByRole("link", { name: "← Back to the reply" }).click()
  // The earlier reply opens its own request.
  await showActions(replies.first())
  await replies.first().getByRole("link", { name: "Request it was generated from" }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${made.id}/context/${made.first}\\?fork=[^&]+$`))
  await expect(page.getByText(/^normal, /)).toBeVisible()
  await expect(messages.getByText("The bell rang twice.", { exact: true })).toBeVisible()
})

test("the cache indicator is warm after a reply, and cold once an earlier message is edited", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const estimate = page.getByRole("region", { name: "Cache estimate" })
  await expect(estimate).toContainText("Cache warm (estimate)")
  await expect(estimate).toContainText("The provider reported using its cache")
  await expect(estimate).toContainText(/\d:\d\d left/)
  await estimate.getByRole("button", { name: "Hide countdown" }).click()
  await expect(estimate).not.toContainText("left")
  await estimate.getByRole("button", { name: "Show countdown" }).click()
  await shoot(page, "cache-warm")

  const mine = page.getByRole("article", { name: "Your message" })
  await showActions(mine)
  await mine.getByRole("button", { name: "Edit" }).click()
  await mine.getByLabel("Message text").fill("The road washed out.")
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(estimate).toContainText("Cache cold (estimate)")
  await expect(estimate).toContainText("Message 2 was")
  await expect(estimate).toContainText(/Next send rewrites ~[\d,]+ tokens/)
  await shoot(page, "cache-cold")
})

test("the inspector fits a phone's width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  await expect(page.getByRole("region", { name: "Messages" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

/** About 2,000 characters: 500 tokens. */
const entry = (i: number) => `Entry ${i}: ${"the tide came in and went out again. ".repeat(54)}`

test("a long context opens collapsed: 200 messages, about 100,000 tokens", async ({ page }) => {
  const preset = await importFile("Long.json", { openai_max_context: 200_000, openai_max_tokens: 300 })
  const long = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const [connection] = yield* api.ListConnections()
      const model = yield* api.AddUserModel({
        connectionId: connection!.id,
        key: "fake-large",
        overrides: { context: 200_000 }
      })
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "The tide log begins.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      // New chats summarize; this one measures 200 raw messages.
      yield* api.SetLcmEnabled({ chatId, enabled: false })
      yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Preset", ref: preset } })
      yield* api.ChangeCast({
        chatId,
        slotId: null,
        change: { _tag: "Model", connection: connection!.id, model: model.id }
      })
      let parent = started.entry.slotId
      for (let i = 0; i < 200; i++) {
        const sent = yield* api.SendMessage({
          chatId,
          parentSlotId: parent,
          branch: false,
          content: entry(i)
        })
        if (sent._tag !== "Posted") return yield* Effect.die(new Error("a message was queued"))
        parent = sent.entry.slotId
      }
      const reply = yield* api.Generate({ chatId, parentSlotId: parent, branch: false })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { id: chatId, reply: reply.entry.version.id }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${long.id}`)
  await expect(reply(page)).toBeVisible()
  await page.goto(`${server().url}/chats/${long.id}/context/${long.reply}`)
  const messages = page.getByRole("region", { name: "Messages" })
  expect(await messages.getByRole("listitem").count()).toBeLessThan(30)
  await expect(page.getByText(/about 10\d,\d{3} tokens/)).toBeVisible()
  // Only visible rows and their previews are mounted.
  expect(await page.evaluate(() => document.body.textContent.length)).toBeLessThan(80_000)
  // A later row can be scrolled to and expanded.
  await messages.getByRole("list").evaluate((el) => {
    el.scrollTop = 152 * 120
  })
  const target = messages.getByText("#153", { exact: true })
  await expect
    .poll(async () => {
      if (await target.count()) return true
      await messages.getByRole("list").evaluate((el) => {
        const first = Number(el.querySelector("[data-index]")?.getAttribute("data-index"))
        el.scrollTop += first > 152 ? -el.clientHeight / 2 : el.clientHeight / 2
      })
      return false
    })
    .toBe(true)
  await target.scrollIntoViewIfNeeded()
  await messages.getByText("#153", { exact: true }).click()
  await expect(messages.locator("p", { hasText: "Entry 147:" })).toHaveText(entry(147).trim())
})

test("a version opened under another chat redirects to its canonical route", async ({ page }) => {
  const other = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateChat({ title: "Other synthetic chat" })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(reply(page)).toBeVisible()
  await page.goto(`${server().url}/chats/${other.id}/context/${chat.reply}`)
  await expect(page).toHaveURL(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  await expect(page.getByRole("link", { name: "← Back to the reply" })).toHaveAttribute(
    "href",
    new RegExp(`/chats/${chat.id}\\?slot=`)
  )
})

// Two forks share a reply but show different versions of it: the inspector, opened from the
// fork the user is viewing, leads back to that fork, not to the chat's current one (ux Annoying 1).
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the inspector returns to the fork it was opened from, at ${width}, ${theme}`, async ({ page }) => {
      const EDITED = "The bridge holds, but Mira keeps the ledger."
      const made = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
          const started = yield* api.StartChat({
            cards: [mira.entityId as EntityId],
            persona: null,
            greeting: 0,
            first: { _tag: "Send", content: "The tide turned.", speakerEntityId: null }
          })
          const chatId = started.chat.id
          const generated = yield* api.Generate({ chatId, parentSlotId: started.entry.slotId, branch: false })
          if (generated._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
          const generating = started.chat.currentForkId!
          // Dark cases view an inheriting fork: the captured reply was generated in a different one.
          const original =
            theme === "dark"
              ? (yield* api.CreateFork({ chatId, fromForkId: generating, atSlotId: generated.entry.slotId })).fork.id
              : generating
          const child = yield* api.CreateFork({ chatId, fromForkId: original, atSlotId: generated.entry.slotId })
          const path = yield* api.ReadPath({
            chatId,
            forkId: child.fork.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          const shared = path.entries.find((entry) => entry.slotId === generated.entry.slotId)!
          yield* api.EditVersion({
            slotId: shared.slotId,
            forkId: child.fork.id,
            sourceVersionId: shared.version.id,
            expectedRowVersion: shared.rowVersion,
            content: EDITED
          })
          return { chatId, original, slot: shared.slotId }
        })
      )
      await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      // The child is the current fork and shows the edit; the original still shows the reply.
      await page.goto(`${server().url}/chats/${made.chatId}`)
      await expect(page.getByRole("article", { name: "Reply" }).filter({ hasText: EDITED })).toBeVisible()
      await page.goto(`${server().url}/chats/${made.chatId}?fork=${made.original}`)
      const original = page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })
      await expect(original).toBeVisible()
      await messageMenu(original, "Context it was generated from")
      await expect(page).toHaveURL(new RegExp(`\\?fork=${made.original}$`))
      // The history sources link to the viewed fork too.
      const messages = page.getByRole("region", { name: "Messages" })
      await expect(messages.getByRole("link", { name: "Message 2" })).toHaveAttribute(
        "href",
        new RegExp(`/chats/${made.chatId}\\?fork=${made.original}&slot=`)
      )
      await shoot(page, `inspector-viewed-fork-${width}-${theme}`)
      await page.getByRole("link", { name: "← Back to the reply" }).click()
      await expect(page).toHaveURL(new RegExp(`/chats/${made.chatId}\\?fork=${made.original}&slot=${made.slot}$`))
      await expect(page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })).toBeVisible()
      // (The chat list's preview shows the current fork's last message; the messages don't.)
      await expect(page.getByRole("article").filter({ hasText: EDITED })).toHaveCount(0)
      await shoot(page, `inspector-viewed-fork-back-${width}-${theme}`)
    })

const denseContext = async (page: Page, explanations = false) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(reply(page)).toBeVisible()
  let replaced = false
  await page.routeWebSocket("**/rpc", (ws) => {
    const upstream = ws.connectToServer()
    upstream.onMessage((message) => {
      const rewrite = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        const object = value as Record<string, unknown>
        if (Array.isArray(object.messages) && object.samplers && object.builtAt) {
          object.messages = Array.from({ length: 10000 }, (_, i) => ({
            role: "user",
            name: null,
            content: `Short synthetic sentence ${i}.`,
            tokens: 10,
            sources: [
              { id: `message:${i}`, kind: "message", label: `Message ${i + 1}`, slotId: null, activation: null }
            ],
            breakpoint: null
          }))
          if (explanations) {
            ;(object.messages as Array<{ sources: unknown }>)[0]!.sources = [
              {
                id: "book-a",
                kind: "lorebook",
                label: "Lorebook Harbor: entry 0",
                slotId: null,
                activation: { kind: "lorebook", status: "activated", step: 0, why: { kind: "constant" } }
              },
              {
                id: "book-b",
                kind: "lorebook",
                label: "Lorebook Harbor: entry 0",
                slotId: null,
                activation: {
                  kind: "lorebook",
                  status: "activated",
                  step: 1,
                  why: { kind: "keys", primaryKey: "[redacted]", secondaryKeys: ["road"], logic: "and_all" }
                }
              },
              {
                id: "note-a",
                kind: "note",
                label: "Note Interval",
                slotId: null,
                activation: { kind: "note", activation: "explicit", interval: 2, userMessages: 20, due: true }
              },
              {
                id: "note-b",
                kind: "note",
                label: "Note Default",
                slotId: null,
                activation: { kind: "note", activation: "default", interval: null, userMessages: null, due: true }
              }
            ]
          }
          replaced = true
          return
        }
        for (const child of Object.values(object)) rewrite(child)
      }
      const data: unknown = JSON.parse(String(message))
      rewrite(data)
      ws.send(JSON.stringify(data))
    })
  })
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  const messages = page.getByRole("region", { name: "Messages" })
  await expect(page.getByText(/10000 messages, about 100,000 tokens/)).toBeVisible()
  expect(replaced).toBe(true)
  return messages
}

test("10,000 short messages mount only visible rows and scroll to the last source", async ({ page }) => {
  const messages = await denseContext(page)
  expect(await messages.getByRole("listitem").count()).toBeLessThan(80)
  const scroll = messages.getByRole("list")
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(messages.getByText("#10000", { exact: true })).toBeVisible()
  await messages.getByText("#10000", { exact: true }).click()
  await expect(messages.locator("p", { hasText: "Short synthetic sentence 9999." })).toBeVisible()
  expect(await messages.getByRole("listitem").count()).toBeLessThan(80)
})

test("virtualized messages retain keyboard focus and expose their list positions", async ({ page }) => {
  const messages = await denseContext(page)
  const first = messages.locator("summary").first()
  await first.focus()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("PageDown")
    await page.waitForTimeout(80)
  }
  await expect(first).toBeFocused()
  await messages.getByRole("list").evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const last = messages.getByRole("listitem").filter({ hasText: "#10000" })
  await expect(last).toBeVisible()
  await expect(first).toBeFocused()
  await expect(last).toHaveAttribute("aria-posinset", "10000")
  await expect(last).toHaveAttribute("aria-setsize", "10000")
  expect(await messages.getByRole("listitem").count()).toBeLessThan(80)
})

test("expanded messages survive unmounting and scrolling back", async ({ page }) => {
  const messages = await denseContext(page)
  await messages.getByText("#1", { exact: true }).click()
  // Move focus out so this row can unmount independently of focus retention.
  await page.getByRole("link", { name: "← Back to the reply" }).focus()
  const scroll = messages.getByRole("list")
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(messages.getByText("#10000", { exact: true })).toBeVisible()
  await expect(messages.getByText("#1", { exact: true })).toHaveCount(0)
  await scroll.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(messages.getByText("#1", { exact: true })).toBeVisible()
  await expect(messages.locator("details").first()).toHaveAttribute("open", "")
  await expect(messages.locator("p", { hasText: "Short synthetic sentence 0." })).toBeVisible()
})

test("source explanations retain distinct equal labels and show historical activation decisions", async ({ page }) => {
  const messages = await denseContext(page, true)
  await expect(messages.getByText("Lorebook Harbor: entry 0", { exact: true })).toHaveCount(2)
  await expect(messages.getByText("Activated at step 0: constant entry.", { exact: true })).toBeVisible()
  await expect(
    messages.getByText("Activated at step 1: keyword “[redacted]”; and_all: “road”.", { exact: true })
  ).toBeVisible()
  await expect(
    messages.getByText("Activated by this chat; every 2 user messages; counted 20; due this turn.", { exact: true })
  ).toBeVisible()
  await expect(messages.getByText("On in every chat; every turn; due this turn.", { exact: true })).toBeVisible()
})

test("a held branch reply says waiting for the cache, including after reload", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  provider.hold()
  const held = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      const parent = path.entries[0]!
      const parentSlotId = parent.slotId
      // The earlier, longer request already covers this branch's old prefix. Make
      // the shared prefix cold explicitly before testing the waiting state.
      yield* api.EditVersion({
        slotId: parentSlotId,
        sourceVersionId: parent.version.id,
        expectedRowVersion: parent.rowVersion,
        content: "Mira opens a new, uncached harbor ledger."
      })
      const leader = yield* api.Generate({ chatId: chat.id, parentSlotId, branch: true })
      if (leader._tag !== "Posted") return yield* Effect.die(new Error("leader queued"))
      // The two branches format the same reusable prefix.
      const follower = yield* api.Generate({ chatId: chat.id, parentSlotId, branch: true })
      if (follower._tag !== "Posted") return yield* Effect.die(new Error("follower queued"))
      return follower.chat.currentForkId!
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}?fork=${held}`)
  await expect(page.getByText("Waiting for the cache…", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Waiting for the cache…", { exact: true })).toBeVisible()
  provider.release()
  await expect(page.getByText("Waiting for the cache…", { exact: true })).toHaveCount(0)
  await expect(reply(page)).toBeVisible()
})

// The worker integration test exercises registration and capture; this pins the generic UI contract.
test("a namespaced provenance source renders its title and library link", async ({ page }) => {
  const [rows] = await Effect.runPromise(
    fixtureSql(
      server().dataDir,
      [
        {
          sql: "SELECT p.rollout_id, p.sent_context_json FROM rollout_payloads p JOIN versions v ON v.rollout_id = p.rollout_id WHERE v.id = ?",
          params: [chat.reply]
        }
      ],
      { readOnly: true }
    )
  )
  const row = rows![0]!
  const original = row.sent_context_json as string
  const wire = JSON.parse(original) as WireContext
  const source = wire.messages.flatMap((message) => message.sources ?? []).find((source) => source.ref)!
  const ref = source.ref!
  const changed = {
    ...wire,
    messages: wire.messages.map((message) => ({
      ...message,
      sources: message.sources?.map((candidate) =>
        candidate.id === source.id
          ? { ...candidate, kind: "synthetic/scene", label: "Plugin scene reference" }
          : candidate
      )
    }))
  }
  const save = (json: string) =>
    Effect.runPromise(
      fixtureSql(server().dataDir, [
        {
          sql: "UPDATE rollout_payloads SET sent_context_json = ? WHERE rollout_id = ?",
          params: [json, row!.rollout_id as string]
        }
      ])
    )
  try {
    await save(JSON.stringify(changed))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
        const link = page.getByRole("link", { name: "Plugin scene reference", exact: true }).first()
        await expect(link).toBeVisible()
        await expect(link).toHaveAttribute("href", `/library/${ref}`)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await link.scrollIntoViewIfNeeded()
        await shoot(page, `custom-source-${width}-${theme}`)
      }
  } finally {
    await save(original)
  }
})

// A provider transform rewrote a piece after assembly: its text keeps a box naming its source,
// marked rewritten, rather than reading as the assembler's own text (inv A1). The worker
// integration test (`inspectorCapture.test.ts`) covers locating it; this pins the UI.
test("a rewritten piece shows in its source's box, labelled rewritten", async ({ page }) => {
  const [rows] = await Effect.runPromise(
    fixtureSql(
      server().dataDir,
      [
        {
          sql: "SELECT p.rollout_id, p.sent_context_json FROM rollout_payloads p JOIN versions v ON v.rollout_id = p.rollout_id WHERE v.id = ?",
          params: [chat.reply]
        }
      ],
      { readOnly: true }
    )
  )
  const row = rows![0]!
  const original = row.sent_context_json as string
  const wire = JSON.parse(original) as WireContext
  const before = "Mira keeps the harbor ledger."
  // The same length, so the recorded offsets still hold.
  const after = "Mira minds the harbor ledger."
  const changed = {
    ...wire,
    messages: wire.messages.map((message) => {
      const at = message.content.indexOf(before)
      if (at === -1) return message
      return {
        ...message,
        content: message.content.replace(before, after),
        parts: message.parts?.map((part) =>
          part.start <= at && part.end >= at + before.length ? { ...part, rewritten: true as const } : part
        )
      }
    })
  }
  const save = (json: string) =>
    Effect.runPromise(
      fixtureSql(server().dataDir, [
        {
          sql: "UPDATE rollout_payloads SET sent_context_json = ? WHERE rollout_id = ?",
          params: [json, row.rollout_id as string]
        }
      ])
    )
  try {
    await save(JSON.stringify(changed))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
        const messages = page.getByRole("region", { name: "Messages" })
        const box = messages.getByRole("region", { name: "Card “Mira”: description (rewritten)" })
        await expect(box.getByText(after, { exact: true })).toBeVisible()
        await expect(box.getByRole("link", { name: "Card “Mira”: description (rewritten)" })).toBeVisible()
        await expect(messages.getByText("Added by the assembler").filter({ hasText: after })).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await box.scrollIntoViewIfNeeded()
        await shoot(page, `inspector-rewritten-${width}-${theme}`)
      }
  } finally {
    await save(original)
  }
})
