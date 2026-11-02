// A card's chats and the chat list at scale (DESIGN §2.1, §6.2): a first message typed in a
// chat not made yet survives leaving it; every chat is reachable a page at a time and
// findable before it's loaded; Continue opens the chat with the last message; a row says
// when its chat started and how long it is, even on a phone; a card's definition folds
// anew when the window changes width.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const MANY = 205
const PERSONALITY =
  "Steady and dry-humoured, she measures every stranger twice before she trusts them once. " +
  "She keeps the harbor ledgers in her head, hums old sea songs when she is nervous, and never " +
  "admits to being lost, even when the fog is thick enough to lean on. Loyal past reason."

let fen: EntityId
let scale: EntityId
let aria: EntityId
let used: ChatId
let group: ChatId
let groupCreatedAt: number

/** How the app writes the day a chat started: its `createdAt`, not its ST file name's stamp (importreport). */
const startedDay = (createdAt: number) =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }).format(new Date(createdAt))

test.beforeAll(async () => {
  const card = (label: string) => admin((api) => api.CreateCard({ label, name: label }))
  fen = (await card("Fen")).entityId
  scale = (await card("Scale")).entityId
  // Aria, with a personality long enough to fold on a phone, not on a wide screen.
  const ariaRef = await card("Aria Vance")
  aria = ariaRef.entityId
  await admin((api) =>
    Effect.gen(function* () {
      yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: ariaRef.id,
        field: textField(["personality"]),
        content: PERSONALITY,
        expectedRowVersion: null,
        baseRevisionId: ariaRef.headRevisionId
      })
      const opened = yield* api.OpenEditor({ refId: ariaRef.id })
      yield* api.CommitEditorDrafts({
        refId: ariaRef.id,
        expectedRowVersion: opened.ref.rowVersion,
        fields: opened.drafts.map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
        message: null
      })
    })
  )
  const bren = (await card("Brennan Holloway-Whitcombe")).entityId
  const cass = (await card("Cassandra Ilse Marchetti")).entityId
  const me = await admin((api) => api.Whoami())
  const now = Date.now()
  // Many chats the card is in, older than the rest, with no messages read. Without messages,
  // the shell orders a chat's fork by its creation, so those differ too (shellReads.ts).
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: `INSERT INTO chats(id,owner_user_id,kind,status,title,created_at,last_message_at)
          WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${MANY - 1})
          SELECT printf('scale-%03d',i),?,'rp','active',printf('Scale chat %03d',i),?+i,?+i FROM n`,
        params: [me.id, now - 1_000_000, now - 1_000_000]
      },
      {
        sql: `INSERT INTO state_events(id,chat_id,seq,key,value_json,origin,created_at)
          WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${MANY - 1})
          SELECT printf('scale-join-%03d',i),printf('scale-%03d',i),0,'participant.join',json_object('entity',?),'import',? FROM n`,
        params: [scale, now]
      }
    ])
  )
  // Aria: a conversation, then a newer chat she joined that has no message yet.
  used = await admin((api) =>
    api.StartChat({
      cards: [aria],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Evening, Aria.", speakerEntityId: null }
    })
  ).then((started) => started.chat.id)
  await new Promise((done) => setTimeout(done, 20))
  const empty = await admin((api) => api.CreateChat({ title: "Opened, never written in" }))
  await admin((api) => api.ChangeCast({ chatId: empty.id, slotId: null, change: { _tag: "Join", entityId: aria } }))
  // A group chat imported from ST: a long name, three characters.
  const groupChat = await admin((api) =>
    api.CreateChat({ title: "The Lantern Inn at the End of the Long Road: 2024-4-6@21h03m12s345ms" })
  )
  group = groupChat.id
  groupCreatedAt = groupChat.createdAt
  for (const entityId of [aria, bren, cass]) {
    await admin((api) => api.ChangeCast({ chatId: group, slotId: null, change: { _tag: "Join", entityId } }))
  }
})

const phone = async (browser: import("@playwright/test").Browser) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await apiLogin(context.request, server(), ADMIN.handle, ADMIN.password)
  return { context, page: await context.newPage() }
}

const chatLinks = (page: Page) => {
  const list = page.getByRole("main").getByRole("list", { name: "Chats" })
  return list.getByRole("link").or(list.getByRole("button", { name: /^Open chat / }))
}

test("a first message typed before the chat exists survives leaving it, and goes once sent", async ({ browser }) => {
  const { context, page } = await phone(browser)
  const box = page.getByRole("textbox", { name: "Message", exact: true })
  const text = "Unsent: the first message, which must survive navigation"
  await page.goto(`${server().url}/cards/${fen}/chat`)
  await box.fill(text)
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: "Characters" }).click()
  await page.getByRole("main").getByRole("button", { name: "Open Fen", exact: true }).click()
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await expect(box).toHaveValue(text)
  // A reload, too: it's kept in the browser, not the page.
  await page.reload()
  await expect(box).toHaveValue(text)

  // Sent, the chat has it, and a new chat with Fen starts empty.
  await page.getByRole("button", { name: /^Send/ }).click()
  await expect(page).toHaveURL(/\/chats\//)
  await expect(page.getByText(text)).toBeVisible()
  await page.goto(`${server().url}/cards/${fen}/chat`)
  await expect(page.getByRole("heading", { name: "Fen" })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(box).toHaveValue("")
  await context.close()
})

test("a card's page reaches all its chats a page at a time, and finds those not loaded", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/cards/${scale}`)
  await expect(page.getByRole("heading", { name: `Chats (${MANY})`, exact: true })).toBeVisible()
  const main = page.getByRole("main")
  await expect(chatLinks(page)).toHaveCount(50)
  // Searching asks the server: the oldest chat is found before it's loaded.
  await main.getByLabel("Find a chat").fill("Scale chat 000")
  await expect(chatLinks(page)).toHaveCount(1)
  await expect(chatLinks(page)).toHaveAttribute("data-chat-id", "scale-000")
  await main.getByLabel("Find a chat").fill("Nothing like this")
  await expect(main.getByText("No chat's title or characters have “Nothing like this”.")).toBeVisible()
  await main.getByLabel("Find a chat").fill("")
  for (const count of [100, 150, 200, MANY]) {
    await main.getByRole("button", { name: "Load more" }).click()
    await expect(chatLinks(page)).toHaveCount(count)
  }
  await expect(main.getByRole("button", { name: "Load more" })).toHaveCount(0)
  // Only the card's chats, on every page; newest first.
  await expect(chatLinks(page).first()).toHaveAttribute("data-chat-id", `scale-${String(MANY - 1).padStart(3, "0")}`)
  await expect(chatLinks(page).last()).toHaveAttribute("data-chat-id", "scale-000")
})

test("the phone's chats page loads older chats and finds those not loaded", async ({ browser }) => {
  const { context, page } = await phone(browser)
  await page.goto(`${server().url}/chats`)
  const main = page.getByRole("main")
  await expect(chatLinks(page)).toHaveCount(50)
  await main.getByRole("button", { name: "Load more" }).click()
  await expect(chatLinks(page)).toHaveCount(100)
  await main.getByLabel("Find a chat").fill("Scale chat 000")
  await expect(chatLinks(page)).toHaveCount(1)
  await context.close()
})

test("Continue and the tile open the chat with the last message, not a newer empty one", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/`)
  await page.getByRole("main").getByRole("button", { name: "Open Aria Vance", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${used}`))
  await page.goto(`${server().url}/cards/${aria}`)
  const main = page.getByRole("main")
  await expect(main.getByRole("button", { name: /^Open chat / })).toHaveCount(3)
  await main.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${used}`))
})

test("on a phone, a group chat's row shows when it started and its length in full", async ({ browser }) => {
  const { context, page } = await phone(browser)
  await page.goto(`${server().url}/cards/${aria}`)
  const row = chatLinks(page).filter({ hasText: "The Lantern Inn" })
  const meta = row.locator("[data-chat-meta]")
  await expect(meta).toHaveText(`started ${startedDay(groupCreatedAt)} · 0 messages`)
  const fits = await meta.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const link = element.closest("a,button")!.getBoundingClientRect()
    return element.scrollWidth <= element.clientWidth && box.right <= link.right
  })
  expect(fits).toBe(true)
  // The cast on a line of its own.
  await expect(row).toContainText("with Aria Vance, Brennan Holloway-Whitcombe, Cassandra Ilse Marchetti")
  await context.close()
})

test("a long name shows in full, wrapped rather than clipped", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${server().url}/cards/${aria}`)
  // Since the branch list (fe174be2) the name wraps with no line clamp, so nothing needs a tooltip.
  const name = chatLinks(page)
    .filter({ hasText: "The Lantern Inn" })
    .getByText(/^The Lantern Inn/)
  await expect(name).toHaveText("The Lantern Inn at the End of the Long Road")
  const clipped = await name.evaluate((element) => {
    const line = element.parentElement!
    return (
      getComputedStyle(line).webkitLineClamp !== "none" ||
      line.scrollWidth > line.clientWidth ||
      line.scrollHeight > line.clientHeight
    )
  })
  expect(clipped).toBe(false)
})

test("a definition folded anew when the window narrows offers Show more, and stays open", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${server().url}/cards/${aria}`)
  const section = page.getByRole("main").getByRole("heading", { name: "Personality", exact: true }).locator("..")
  await expect(section.getByText(/^Steady and dry-humoured/)).toBeVisible()
  await expect(section.getByRole("button", { name: /Show more/ })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(section.getByRole("button", { name: /Show more/ })).toBeVisible()
  expect(await section.locator("p").evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(true)
  // Opened, it stays open through another change of width.
  await section.getByRole("button", { name: /Show more/ }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(section.getByRole("button", { name: /Show less/ })).toBeVisible()
})
