import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { Writer, layer as databaseLayer } from "../../server/src/db/Database.ts"
import type { WireContext } from "../../server/src/assembler/types.ts"
// The request inspector and the cache-warmth indicator (DESIGN §5.5, §7.4), against the
// production server, which generates through the context assembler and the provider
// layer, here a fake OpenAI-compatible provider on loopback. The card is made up.
import { join } from "node:path"
import type { ChatId, EntityId, VersionId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, REPLY, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { messageMenu, showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cacheChip } from "./support/strip.ts"
import { expectOneScroller, scrollPane, scrollUntil } from "./support/scrollPane.ts"
import { expectLayout } from "./support/layoutAudit.ts"

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
  // The first test restarts this server; keep the shared reply's reported usage first.
  await expect
    .poll(
      () =>
        asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          api.GetRunContext({ versionId: chat.reply }).pipe(
            Effect.map((run) => run.requests.some((request) => request.usageSource === "reported")),
            Effect.orElseSucceed(() => false)
          )
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
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

test("inserted history keeps its displayed numbers in the inspector at desktop and phone sizes", async ({ page }) => {
  const seeded = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = (yield* api.ListCards()).find((card) => card.label === "Mira")!
      const started = yield* api.StartChat({
        cards: [mira.entityId as EntityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "A synthetic tide report.", speakerEntityId: null }
      })
      return { started, userId: (yield* api.Whoami()).id, speaker: mira.entityId as EntityId }
    })
  )
  // Unit 4 has no insertion RPC yet. Stop the server to respect its instance lock,
  // seed through the real worker operation, then reopen it for generation and display.
  await server().pause()
  const inserted = await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* Writer
      return yield* writer.InsertMessage({
        userId: seeded.userId,
        chatId: seeded.started.chat.id,
        forkId: seeded.started.chat.currentForkId!,
        anchorSlotId: seeded.started.entry.slotId,
        expectedRowVersion: seeded.started.entry.rowVersion,
        body: { _tag: "Write", speaker: seeded.speaker, content: "A lantern marks the inserted turn." }
      })
    }).pipe(
      Effect.provide(databaseLayer({ dataDir: server().dataDir, readers: 1, allowNetworkFs: false, workers: "source" }))
    )
  )
  await server().restart()
  const made = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const generated = yield* api.Generate({
        chatId: seeded.started.chat.id,
        forkId: seeded.started.chat.currentForkId!,
        parentSlotId: seeded.started.entry.slotId,
        branch: false
      })
      if (generated._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      return { chatId: seeded.started.chat.id, version: generated.entry.version.id, inserted: inserted.slotId }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/chats/${made.chatId}/context/${made.version}`)
      const messages = page.getByRole("region", { name: "Messages" })
      // The messages follow the request's facts, below a phone's first screen.
      await scrollUntil(messages, messages.getByRole("link", { name: /^Message 3(?:,|$)/ }))
      await expect(messages.getByRole("link", { name: /^Message 3(?:,|$)/ })).toHaveAttribute(
        "href",
        new RegExp(`slot=${made.inserted}`)
      )
      await expect(messages.getByText("A lantern marks the inserted turn.", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await shoot(page, `inspector-inserted-${width}-${theme}`)
      await messages.getByRole("region", { name: "Message 3", exact: true }).scrollIntoViewIfNeeded()
      await shoot(page, `inspector-inserted-message-${width}-${theme}`)
    }
})

test("usage headers fit without clipping on a 390px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}/context/${chat.reply}`)
  const usage = page.getByLabel("Usage by attempt")
  const labels = usage.locator("dt")
  await expect(labels).toHaveText([
    "Attempt",
    "Input",
    "Cache read",
    "Cache write",
    "Output",
    "Cost",
    "Time",
    "First token",
    "Tokens/s"
  ])
  await expect(usage.locator("dd").nth(1)).toContainText(/120 \(~[\d,]+\)/)
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
  await messageMenu(reply(page), "Open request inspector")
  await expect(page).toHaveURL(new RegExp(`/chats/${chat.id}/context/${chat.reply}\\?fork=[^&]+(&wb=[^&]*)?$`))
  const messages = page.getByRole("region", { name: "Messages" })
  await expect(messages.getByText("Card “Mira”: description")).toBeVisible()
  await expect(messages.getByText("Preset prompt “Main Prompt”")).toBeVisible()
  await expect(messages.getByText("Above this line: reused by every reply")).toBeVisible()
  await expect(messages.getByText("Above this line: reused until old messages drop out")).toBeVisible()
  await messages.getByText("Above this line: reused by every reply").scrollIntoViewIfNeeded()
  await shoot(page, "inspector-reuse-lines")
  await expect(page.getByText("fake-small on Local model server (openai-chat)")).toBeVisible()
  // What the provider reported: 100 tokens read from its cache, 6 written.
  // The attempt reads "1: finished" since smallfixes3.
  await expect(page.getByRole("row", { name: /^1: finished/ })).toContainText("100")
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
      yield* settled
      return { id: chatId, first: first.entry.version.id, firstSlot: first.entry.slotId, swipe: swipe.version.id }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${made.id}`)
  const replies = page.getByRole("article", { name: "Reply" }).filter({ hasText: REPLY })
  await expect(replies).toHaveCount(2)
  // The swipe, the second version of the last reply.
  await messageMenu(replies.last(), "Open request inspector")
  await expect(page).toHaveURL(new RegExp(`/chats/${made.id}/context/${made.swipe}\\?fork=[^&]+(&wb=[^&]*)?$`))
  await expect(page.getByText(/^swipe, /)).toBeVisible()
  const messages = page.getByRole("region", { name: "Messages" })
  // The earlier reply is in its history, by message and version.
  await scrollUntil(messages, messages.getByRole("link", { name: "Message 3, swipe 1" }))
  await expect(messages.getByRole("link", { name: "Message 3, swipe 1" })).toBeVisible()
  await page.getByRole("link", { name: "← Back to the reply" }).click()
  // Back opens the linked swipe. Scroll to the earlier reply before opening its action.
  const timeline = page.getByTestId("messages")
  await timeline.hover()
  await page.mouse.wheel(0, -600)
  const earlier = timeline.locator(`article[data-slot="${made.firstSlot}"]`)
  await expect(earlier).toBeInViewport()
  await messageMenu(earlier, "Open request inspector")
  await expect(page).toHaveURL(new RegExp(`/chats/${made.id}/context/${made.first}\\?fork=[^&]+(&wb=[^&]*)?$`))
  await expect(page.getByText(/^normal, /)).toBeVisible()
  await scrollUntil(messages, messages.getByText("The bell rang twice.", { exact: true }))
  await expect(messages.getByText("The bell rang twice.", { exact: true })).toBeVisible()
})

test("the cache indicator is warm after a reply, and cold once an earlier message is edited", async ({
  page
}, info) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const chip = cacheChip(page)
  await expect(chip).toHaveAccessibleName(/^Cache warm, \d+:\d\d left\. Details$/)
  await expect(chip).toHaveText(/^Cache warm \d+:\d\d$/)
  await chip.click()
  const details = page.getByRole("dialog", { name: "Cache warm", exact: true })
  await expect(details).toContainText("The provider reported using its cache")
  await expect(details).toContainText(/if it's sent in the next \d+:\d\d/)
  await details.getByRole("button", { name: "Hide countdown" }).click()
  await expect(chip).toHaveText("Cache warm")
  await expect(chip).toHaveAccessibleName("Cache warm. Details")
  await expect(details).not.toContainText("in the next")
  await details.getByRole("button", { name: "Show countdown" }).click()
  await expect(chip).toHaveText(/^Cache warm \d+:\d\d$/)
  await shoot(page, "cache-warm")
  await page.keyboard.press("Escape")
  await expect(details).toHaveCount(0)

  const mine = page.getByRole("article", { name: "Your message" })
  await showActions(mine)
  await mine.getByRole("button", { name: "Edit" }).click()
  await mine.getByLabel("Message text").fill("The road washed out.")
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(chip).toHaveAccessibleName(/^Cache: [\d,]+ of [\d,]+ tokens uncached on the next reply/)
  await expect(chip).toHaveText(/^↻ [\d.]+k? of [\d.]+k? uncached$/)
  await chip.click()
  const cold = page.getByRole("dialog", { name: "Not cached", exact: true })
  await expect(cold).toContainText(/Your next reply re-sends about [\d,]+ of its [\d,]+ tokens at full price/)
  await expect(cold).toContainText("Why: Message 2 was")
  await shoot(page, "cache-cold")
  if (process.env.LAYOUT_AUDIT) {
    await page.keyboard.press("Escape")
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(chip).toHaveText(/^↻ [\d.]+k? of [\d.]+k? uncached$/)
      await expectLayout(page, info, `cache-cold-composer-${width}`, {
        scope: ".chat-column:has([data-composer-text])"
      })
    }
  }
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
  await expect(page.getByText(/^\d[\d,]* tokens: \d[\d,]* messages, 0 tools$/)).toBeVisible()
  // Only visible rows and their previews are mounted.
  expect(await page.evaluate(() => document.body.textContent.length)).toBeLessThan(80_000)
  // A later row can be scrolled to and expanded.
  await scrollPane(messages.getByRole("list"), { at: 152 * 120 })
  const target = messages.getByText("#153", { exact: true })
  await expect
    .poll(async () => {
      if (await target.count()) return true
      const first = Number(await messages.locator("[data-index]").first().getAttribute("data-index"))
      await scrollPane(messages.getByRole("list"), { by: first > 152 ? -0.5 : 0.5 })
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
      await messageMenu(original, "Open request inspector")
      await expect(page).toHaveURL(new RegExp(`\\?fork=${made.original}(&wb=[^&]*)?$`))
      // The history sources link to the viewed fork too.
      const messages = page.getByRole("region", { name: "Messages" })
      await expect(messages.getByRole("link", { name: "Message 2" })).toHaveAttribute(
        "href",
        new RegExp(`/chats/${made.chatId}\\?fork=${made.original}&slot=`)
      )
      await shoot(page, `inspector-viewed-fork-${width}-${theme}`)
      // The link itself carries the place only; the chat then writes its pane's own view params
      // (timeline, rail) back into the URL, so the URL is checked by its place params.
      const back = page.getByRole("link", { name: "← Back to the reply" })
      await expect(back).toHaveAttribute(
        "href",
        new RegExp(`/chats/${made.chatId}\\?fork=${made.original}&slot=${made.slot}$`)
      )
      await back.click()
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/chats/${made.chatId}` &&
          url.searchParams.get("fork") === made.original &&
          url.searchParams.get("slot") === made.slot
      )
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
          object.messageTokens = 100_000
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
  await expect(page.getByText("100,000 tokens: 100,000 messages, 0 tools", { exact: true })).toBeVisible()
  expect(replaced).toBe(true)
  return messages
}

test("10,000 short messages mount only visible rows and scroll to the last source", async ({ page }) => {
  const messages = await denseContext(page)
  expect(await messages.getByRole("listitem").count()).toBeLessThan(80)
  const scroll = messages.getByRole("list")
  await scrollPane(scroll, { to: "end" })
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
  await scrollPane(messages.getByRole("list"), { to: "end" })
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
  await scrollPane(scroll, { to: "end" })
  await expect(messages.getByText("#10000", { exact: true })).toBeVisible()
  await expect(messages.getByText("#1", { exact: true })).toHaveCount(0)
  await scrollPane(scroll, { to: "start" })
  await expect(messages.getByText("#1", { exact: true })).toBeVisible()
  await expect(messages.locator("details").first()).toHaveAttribute("open", "")
  await expect(messages.locator("p", { hasText: "Short synthetic sentence 0." })).toBeVisible()
})

// Owner, 2026-11-20: "It's ONE OR THE OTHER… No more scroll inside scroll." The request's facts
// come first; the sent messages follow in the page's flow, and the page's pane is the only
// thing that scrolls, in its own column and in a workbench frame alike.
for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a long request scrolls with its page alone, at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      const messages = await denseContext(page)
      const pane = messages.getByRole("list")
      // Everything that isn't the prompt is above it.
      const top = async (name: string) =>
        (await page.getByRole("heading", { name, exact: true }).boundingBox())?.y ?? Number.NaN
      const prompt = await top("Messages")
      expect(await top("Request")).toBeLessThan(prompt)
      expect(await top("Usage")).toBeLessThan(prompt)
      await expectOneScroller(pane, `top ${width} ${theme}`)
      await shoot(page, `inspector-scroll-top-${width}-${theme}`)
      await page.screenshot({ path: info.outputPath(`inspector-scroll-top-${width}-${theme}.png`) })
      // Partway down, with a few turns open: the rows are still the pane's own.
      await scrollPane(pane, { at: 40 * 120 })
      await expect(messages.locator("[data-index]").first()).toBeVisible()
      for (const row of await messages
        .locator("summary")
        .all()
        .then((rows) => rows.slice(1, 4)))
        await row.click()
      await expectOneScroller(pane, `middle ${width} ${theme}`)
      expect(await messages.getByRole("listitem").count()).toBeLessThan(80)
      await page.screenshot({ path: info.outputPath(`inspector-scroll-middle-${width}-${theme}.png`) })
      await shoot(page, `inspector-scroll-middle-${width}-${theme}`)
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `inspector-scroll-${width}-${theme}`)
      await scrollPane(pane, { to: "end" })
      await expect(messages.getByText("#10000", { exact: true })).toBeVisible()
      await expectOneScroller(pane, `end ${width} ${theme}`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    })

test("the inspector in a workbench frame scrolls with its frame alone", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const messages = await denseContext(page)
  const at = new URL(page.url()).pathname
  const wb = JSON.stringify(["r", [0.5, 0.5], [0, `/chats/${chat.id}`], [0, "="]])
  await page.goto(`${server().url}${at}?wb=${encodeURIComponent(wb)}`)
  await expect(page.getByText("100,000 tokens: 100,000 messages, 0 tools", { exact: true })).toBeVisible()
  await expectOneScroller(messages.getByRole("list"), "frame top")
  await scrollPane(messages.getByRole("list"), { to: "end" })
  await expect(messages.getByText("#10000", { exact: true })).toBeVisible()
  await expectOneScroller(messages.getByRole("list"), "frame end")
  await page.screenshot({ path: info.outputPath("inspector-scroll-frame-1440.png") })
  await shoot(page, "inspector-scroll-frame-1440")
  if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, "inspector-scroll-frame-1440")
})

// The page follows its frame's width, not the window's: at 1440 a half- or third-width frame is
// narrower than a phone's page, and the Usage table overflowed a half-width one (2026-11-23).
// The context is the shared reply's, with a second (retried, estimated) attempt, a long model
// id and a long note, so every part has text to wrap.
const widths = [
  { name: "half-1440", viewport: 1440, shares: [0.5, 0.5], table: false },
  { name: "third-1440", viewport: 1440, shares: [1 / 3, 1 / 3, 1 / 3], table: false },
  { name: "phone-390", viewport: 390, shares: [], table: false },
  { name: "page-1440", viewport: 1440, shares: [], table: true }
] as const
for (const { name, viewport, shares, table: wide } of widths)
  for (const theme of ["light", "dark"] as const)
    test(`the inspector fits its frame, ${name} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width: viewport, height: viewport < 640 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.routeWebSocket("**/rpc", (ws) => {
        const upstream = ws.connectToServer()
        upstream.onMessage((message) => {
          const rewrite = (value: unknown): void => {
            if (!value || typeof value !== "object") return
            const object = value as Record<string, unknown>
            if (Array.isArray(object.messages) && object.samplers && object.builtAt) {
              const requests = object.requests as Array<Record<string, unknown>>
              if (requests[0])
                object.requests = [{ ...requests[0], id: "retried", usageSource: "estimated" }, ...requests]
              const model = object.model as Record<string, unknown> | null
              if (model) model.model = "an-unusually-long-synthetic-model-identifier-with-no-spaces-2026-11-23"
              object.issues = [
                {
                  kind: "history_truncated",
                  message:
                    "History was cut to fit: 412 earlier messages weren't sent. A-very-long-unbroken-synthetic-token-that-must-wrap-inside-the-box."
                }
              ]
              return
            }
            for (const child of Object.values(object)) rewrite(child)
          }
          const data: unknown = JSON.parse(String(message))
          rewrite(data)
          ws.send(JSON.stringify(data))
        })
      })
      const at = `/chats/${chat.id}/context/${chat.reply}`
      const wb =
        shares.length > 0
          ? `?wb=${encodeURIComponent(JSON.stringify(["r", shares, ...shares.slice(1).map(() => [0, `/chats/${chat.id}`]), [0, "="]]))}`
          : ""
      await page.goto(`${server().url}${at}${wb}`)
      const usage = page.getByRole("heading", { name: "Usage", exact: true })
      await expect(usage).toBeVisible()
      await expect(page.getByText("Notes on this context")).toBeVisible()
      await expect(page.getByRole("region", { name: "Messages" }).locator("summary").first()).toBeVisible()
      await page.getByRole("region", { name: "Messages" }).locator("summary").first().click()
      // The frame the inspector is in, or the page's column on a phone.
      const frame =
        shares.length > 0
          ? page.locator("[data-frame-body]").filter({ has: usage })
          : page.locator("main").filter({ has: usage }).first()
      await expect(frame).toHaveCount(1)
      const outside = await frame.evaluate((root) => {
        const edge = root.getBoundingClientRect()
        const page = root.querySelector("[data-request-inspector]") ?? root
        const out: Array<string> = []
        for (const el of page.querySelectorAll<HTMLElement>("*")) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          if (r.right > edge.right + 1 || r.left < edge.left - 1)
            out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").slice(0, 40)}" ${r.left}–${r.right}`)
        }
        for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")])
          if (el.scrollWidth > el.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(el).overflowX))
            out.push(`${el.tagName.toLowerCase()} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`)
        return { out, width: edge.width }
      })
      expect(outside.out, `inside a ${Math.round(outside.width)} px frame`).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      // Both attempts: a table on the page's full column, label/value rows in anything narrower.
      const stacked = page.getByLabel("Usage by attempt")
      const table = page.locator("table").filter({ hasText: "Tokens/s" })
      if (wide) {
        await expect(table.locator("tbody tr")).toHaveCount(2)
        await expect(stacked).toBeHidden()
      } else {
        await expect(stacked.locator("dl")).toHaveCount(2)
        await expect(table).toBeHidden()
      }
      await shoot(page, `inspector-width-${name}-${theme}`)
      await expectLayout(page, info, `inspector-width-${name}-${theme}`, { scope: "[data-request-inspector]" })
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
// marked "changed before sending", rather than reading as the assembler's own text (inv A1). The worker
// integration test (`inspectorCapture.test.ts`) covers locating it; this pins the UI.
test("a rewritten piece shows in its source's box, labelled changed before sending", async ({ page }) => {
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
        const box = messages.getByRole("region", { name: "Card “Mira”: description (changed before sending)" })
        await expect(box.getByText(after, { exact: true })).toBeVisible()
        await expect(box.getByRole("link", { name: "Card “Mira”: description", exact: true })).toBeVisible()
        // The mark says what happened, and its hover says how.
        const mark = box.getByText("(changed before sending)", { exact: true })
        await mark.hover()
        await expect(
          page.getByText("This text was changed after the prompt was assembled", { exact: false })
        ).toBeVisible()
        await page.mouse.move(0, 0)
        await expect(messages.getByText("Added by the assembler").filter({ hasText: after })).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await box.scrollIntoViewIfNeeded()
        await shoot(page, `inspector-rewritten-${width}-${theme}`)
      }
  } finally {
    await save(original)
  }
})
