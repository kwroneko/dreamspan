// Starting chats from cards, speakers and the send queue (DESIGN §2.1, §2.2), against a
// server with the fake generator: a card's greeting follows the persona picked until the
// first send makes the chat; Send as and Generate with a one-turn direction; and messages
// sent during a reply wait, post when it ends or is stopped, and can be withdrawn; and a
// new chat of a group, from its tile. Every card here is made up.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { markPersona } from "./support/library.ts"
import { openPanel } from "./support/panel.ts"
import { addToCast } from "./support/cast.ts"

// About four seconds a reply: long enough to queue behind and to stop.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "40", FAKE_GENERATOR_TOKENS: "160" })

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=${String(data.name)}.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

// The panels and the switcher run under the Content-Security-Policy too (csp.spec.ts).
const violations: Array<string> = []
test.beforeEach(({ page }) => {
  violations.length = 0
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })
})
test.afterEach(() => expect(violations).toEqual([]))

/** With SCREENSHOT_DIR set, the screen as it is, at desktop width. */
const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

const replies = (page: Page) => page.getByRole("article", { name: "Reply" })
const generating = (page: Page) => page.getByText("generating", { exact: true })
const composer = (page: Page) => page.getByLabel("Message", { exact: true })
/** The account's guidance toggle (DESIGN §2.2), on or off whatever an earlier test left. */
const setGuidance = async (page: Page, on: boolean) => {
  const toggle = page.getByRole("switch", { name: "Guidance", exact: true })
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(on))
}

let cast: Promise<void> | null = null
/** Mira and Tobin to talk to, Ana and Bo in the persona folder: once per file, through the library. */
const setUp = (page: Page) =>
  (cast ??= (async () => {
    await importCard(page, {
      name: "Mira",
      description: "A harbor pilot.",
      first_mes: "The bell rings for {{user}}.",
      alternate_greetings: ["Mira waves at {{user}} from the pier."]
    })
    await importCard(page, { name: "Tobin", description: "A ferryman.", first_mes: "Tobin nods." })
    await importCard(page, {
      name: "Wren",
      description: "A lighthouse keeper.",
      first_mes: "{{description}} The log says {{datetimeformat::[{{char}},] YYYY-MM-DD}}."
    })
    await importCard(page, { name: "Ana", description: "A cartographer." })
    await importCard(page, {
      name: "Crowd",
      first_mes: "{{random::x{{space::262145}}x}}",
      alternate_greetings: Array.from({ length: 1000 }, (_, i) => `Alternate ${i} at {{time}}`)
    })
    await importCard(page, { name: "Bo", description: "A diver." })
    await page.goto(`${server().url}/library`)
    for (const persona of ["Ana", "Bo"]) await markPersona(page, persona)
  })())

const login = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await setUp(page)
}

/** A chat with Mira, played as Bo, with Mira's reply to the first message finished. */
const chatWithMira = async (page: Page) => {
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Mira" }).click()
  await page.getByLabel("Playing as").click()
  await page.getByRole("option", { name: "Bo" }).click()
  await composer(page).fill("Hello there.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  await expect(replies(page)).toHaveCount(2)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
}

test("a new chat from a card: the greeting follows the persona until the first send", async ({ page }) => {
  await login(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Mira" }).click()
  const greeting = page.getByRole("article", { name: /^Greeting from / })
  await expect(greeting).toContainText("The bell rings for Ana.")
  // Opening a card made no chat (DESIGN §2.1).
  await page.goto(`${server().url}/chats`)
  await expect(page.getByText(/^No chats yet\./)).toBeVisible()
  await page.goBack()

  await greeting.getByRole("button", { name: "Next greeting" }).click()
  await expect(greeting).toContainText("Mira waves at Ana from the pier.")
  await page.getByLabel("Playing as").click()
  await page.getByRole("option", { name: "Bo" }).click()
  await expect(greeting).toContainText("Mira waves at Bo from the pier.")
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await shoot(page, "new-chat-from-card")

  await composer(page).fill("Hello there.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  // Named by its character and day, the persona left out.
  await expect(page.getByRole("heading", { level: 1, name: /^Mira, [A-Z][a-z]{2} \d{1,2}$/ })).toBeVisible()
  // The greeting picked, as a version of the first message, with its macros resolved for Bo.
  const first = replies(page).first()
  await expect(first).toContainText("Mira waves at Bo from the pier.")
  await expect(first.getByRole("group", { name: "Versions" })).toContainText("2")
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("Bo")
  await expect(replies(page)).toHaveCount(2)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(replies(page).last().locator("header")).toContainText("Mira")

  // Later, playing Ana from here on doesn't rewrite what was said before.
  await openPanel(page, "Cast")
  const cast = page.getByRole("tabpanel", { name: "Cast" })
  // Ana is in the persona folder: offered apart, under the characters.
  await addToCast(page, "Ana")
  await expect(cast.getByRole("list", { name: "Characters in this chat" })).toContainText("Ana")
  await expect(first).toContainText("Mira waves at Bo from the pier.")
  // The panel's tab is in the URL: a reload keeps it open there.
  await expect(page).toHaveURL(/panel=cast/)
  await page.reload()
  await expect(replies(page).first()).toContainText("Mira waves at Bo from the pier.")
  await expect(page.getByText(/^No chats yet\./)).toHaveCount(0)
  await expect(page.getByRole("tabpanel", { name: "Cast" })).toBeVisible()
  await page.getByRole("tab", { name: "This chat" }).click()
  const settings = page.getByRole("tabpanel", { name: "This chat" })
  // The card layout is the preset's, never a chat's: no selector here.
  await expect(settings.getByText("Card layout")).toHaveCount(0)
  // Who each message is sent as is advanced, collapsed.
  await settings.getByText("Advanced: who each message is sent as", { exact: true }).click()
  await settings.getByText("By perspective").click()
  await shoot(page, "chat-settings")
  // Settings are state from the leaf on: read back after a reload.
  await page.reload()
  await page.getByText("Advanced: who each message is sent as", { exact: true }).click()
  await expect(page.getByRole("radio", { name: /By perspective/ })).toBeChecked()
  // Closed, it stays closed.
  await page.getByRole("button", { name: "Close the panel" }).click()
  await expect(page).not.toHaveURL(/panel=/)
  await page.reload()
  await expect(page.getByRole("complementary", { name: "Chat panel" })).toHaveCount(0)
})

test("Send as a card added to the chat, and Generate with guidance that a swipe takes only while it's on", async ({
  page
}) => {
  await login(page)
  await chatWithMira(page)
  // The speaker is always visible; it lists only the chat's cast (DESIGN §2.2).
  await page.getByRole("button", { name: /^Speaking as Bo/ }).click()
  await expect(page.getByRole("option", { name: /^Mira/ })).toBeVisible()
  await expect(page.getByRole("option", { name: /^Tobin/ })).toHaveCount(0)
  await shoot(page, "speaker-switcher")
  await page.keyboard.press("Escape")
  // To speak as another card, add it to the chat first.
  await openPanel(page, "Cast")
  await addToCast(page, "Tobin")
  await page.getByRole("button", { name: "More for Tobin" }).click()
  await page.getByRole("button", { name: "Write as Tobin" }).click()
  await page.keyboard.press("Escape")
  await composer(page).fill("Tobin pushes off from the dock.")
  await page.getByRole("button", { name: "Send as Tobin" }).click()
  // A cast member the user doesn't play speaks on the model's side, whoever wrote it.
  const mine = page.getByRole("article").filter({ hasText: "Tobin pushes off from the dock." })
  await expect(mine.locator("header")).toContainText("Tobin")
  await expect(mine).toHaveAttribute("aria-label", "Reply")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // Recent speakers are one tap away where the composer has the width for them: with the side
  // panel closed (open, the speaker picker lists them first).
  await page.getByRole("button", { name: "Hide panel", exact: true }).click()
  await page.getByRole("button", { name: "Speak as Mira" }).click()
  await expect(page.getByRole("button", { name: /^Speaking as Mira/ })).toBeVisible()

  // With guidance on, the box is a one-turn direction, and it leaves the box (DESIGN §2.2).
  await setGuidance(page, true)
  const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
  await guidance.fill("Mira tells a story about the storm.")
  await page.getByRole("button", { name: "Write for Mira" }).click()
  const reply = replies(page).last()
  await expect(reply).toContainText("Direction: Mira tells a story about the storm.")
  await expect(guidance).toHaveValue("")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await shoot(page, "generate-with-direction")
  // A swipe reuses the guidance of the version it re-rolls.
  await reply.getByRole("button", { name: "Generate another version" }).click()
  await expect(reply.getByRole("group", { name: "Versions" })).toContainText("2/2")
  await expect(reply).toContainText("Direction: Mira tells a story about the storm.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // With guidance off too; the next turn doesn't get it.
  await setGuidance(page, false)
  await reply.getByRole("button", { name: "Generate another version" }).click()
  await expect(reply.getByRole("group", { name: "Versions" })).toContainText("3/3")
  await expect(reply).toContainText("Direction: Mira tells a story about the storm.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await page.getByRole("button", { name: "Write for Mira" }).click()
  await expect(replies(page).last()).not.toContainText("Direction:")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await composer(page).fill("")
})

test("a message sent during a reply waits, then posts after it", async ({ page }) => {
  await login(page)
  await chatWithMira(page)
  // Mira's turn, then back to speaking as Bo: both one tap away.
  await page.getByRole("button", { name: "Speak as Mira" }).click()
  await page.getByRole("button", { name: "Write for Mira" }).click()
  await expect(generating(page)).toBeVisible()
  await page.getByRole("button", { name: "Speak as Bo" }).click()
  await composer(page).fill("While you were talking.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  // Pending under the streaming reply, and the composer is free again.
  const queued = page.getByRole("list", { name: "Queued messages" })
  await expect(queued).toContainText("While you were talking.")
  await shoot(page, "queued-message")
  await expect(composer(page)).toHaveValue("")
  // It posts when the reply finishes, and gets a reply of its own.
  await expect(queued).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByRole("article", { name: "Your message" }).last()).toContainText("While you were talking.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // Its own reply follows it (the list is virtualized: older rows may be out of the DOM).
  await expect(page.locator("article[data-slot]").last()).toHaveAttribute("aria-label", "Reply")
})

test("a queued message posts right after a stopped reply, and one withdrawn never does", async ({ page }) => {
  await login(page)
  await chatWithMira(page)
  // Mira's turn, then back to speaking as Bo: both one tap away.
  await page.getByRole("button", { name: "Speak as Mira" }).click()
  await page.getByRole("button", { name: "Write for Mira" }).click()
  await expect(generating(page)).toBeVisible()
  await page.getByRole("button", { name: "Speak as Bo" }).click()
  await composer(page).fill("Never mind.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  await composer(page).fill("Wait, stop.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  const queued = page.getByRole("list", { name: "Queued messages" })
  await expect(queued.getByRole("listitem")).toHaveCount(2)
  // Withdrawn, it comes back to the composer if that's empty.
  await queued.getByRole("listitem").first().getByRole("button", { name: "Withdraw" }).click()
  await expect(queued.getByRole("listitem")).toHaveCount(1)
  await expect(composer(page)).toHaveValue("Never mind.")
  await composer(page).fill("")

  // Stopped: the queued message posts right after the stopped version.
  await page.getByRole("button", { name: "Stop", exact: true }).first().click()
  await expect(page.getByText("stopped", { exact: true })).toBeVisible()
  await expect(queued).toHaveCount(0, { timeout: 10_000 })
  const mine = page.getByRole("article", { name: "Your message" })
  await expect(mine.last()).toContainText("Wait, stop.")
  await expect(page.getByText("Never mind.")).toHaveCount(0)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

/** Mira's turn, generating, with Bo speaking again: what's sent now is queued. */
const miraGenerating = async (page: Page) => {
  await page.getByRole("button", { name: "Speak as Mira" }).click()
  await page.getByRole("button", { name: "Write for Mira" }).click()
  await expect(generating(page)).toBeVisible()
  await page.getByRole("button", { name: "Speak as Bo" }).click()
}

test("withdrawing while typing keeps both texts in the composer", async ({ page }) => {
  await login(page)
  await chatWithMira(page)
  await miraGenerating(page)
  await composer(page).fill("Important queued text.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  const queued = page.getByRole("list", { name: "Queued messages" })
  await expect(queued).toContainText("Important queued text.")
  await composer(page).fill("A new draft.")
  await queued.getByRole("button", { name: "Withdraw" }).click()
  await expect(queued).toHaveCount(0)
  await expect(composer(page)).toHaveValue("A new draft.\n\nImportant queued text.")
  await page.getByRole("button", { name: "Stop", exact: true }).first().click()
})

test("text typed while Generate is on its way stays in the composer", async ({ page }) => {
  // Holds the Generate request until the test lets it through.
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((message) => {
      if (
        release === null &&
        String(message).includes('"tag":"Generate"') &&
        String(message).includes("A held direction.")
      ) {
        release = () => server.send(message)
      } else server.send(message)
    })
    server.onMessage((message) => socket.send(message))
  })
  await login(page)
  await chatWithMira(page)
  await page.getByRole("button", { name: "Speak as Mira" }).click()
  await setGuidance(page, true)
  const guidance = page.getByRole("textbox", { name: "Guidance", exact: true })
  await guidance.fill("A held direction.")
  await page.getByRole("button", { name: "Write for Mira" }).click()
  await expect.poll(() => release !== null).toBe(true)
  await guidance.fill("Typed while it was on its way.")
  release!()
  await expect(replies(page).last()).toContainText("Direction: A held direction.")
  await expect(guidance).toHaveValue("Typed while it was on its way.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await setGuidance(page, false)
})

test("a saved greeting keeps its card's fields and the date it showed", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"))
  await login(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Wren" }).click()
  const greeting = page.getByRole("article", { name: /^Greeting from / })
  await expect(greeting).toContainText("A lighthouse keeper. The log says Wren, 2026-03-01.")
  await composer(page).fill("Hello, keeper.")
  await page.getByRole("button", { name: /^Send/ }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  const first = replies(page).first()
  await expect(first).toContainText("A lighthouse keeper. The log says Wren, 2026-03-01.")
  // A day later, it still says what it said.
  await page.clock.setFixedTime(new Date("2026-03-02T12:00:00Z"))
  await page.reload()
  await expect(replies(page).first()).toContainText("A lighthouse keeper. The log says Wren, 2026-03-01.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("text typed while the first send makes the chat goes along to the chat's composer", async ({ page }) => {
  // Holds the StartChat request until the test lets it through.
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((message) => {
      if (release === null && String(message).includes('"tag":"StartChat"')) release = () => server.send(message)
      else server.send(message)
    })
    server.onMessage((message) => socket.send(message))
  })
  await login(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Tobin" }).click()
  await composer(page).fill("Take me across.")
  await page.getByRole("button", { name: /^Send/ }).click()
  await expect.poll(() => release !== null).toBe(true)
  await expect(composer(page)).toHaveValue("")
  await composer(page).fill("And bring the lantern.")
  release!()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("Take me across.")
  await expect(composer(page)).toHaveValue("And bring the lantern.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("a card with 1,001 greetings and a huge random draw starts like any other", async ({ page }) => {
  await login(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Crowd" }).click()
  await expect(page.getByRole("article", { name: /^Greeting from / })).toContainText("1 / 1001")
  await composer(page).fill("Hello, everyone.")
  await page.getByRole("button", { name: /^Send/ }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("Hello, everyone.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("a new chat of a group: each character greets in turn, and the first send makes one of its chats", async ({
  page
}) => {
  await login(page)
  // A group: a chat with Mira and Tobin, named "The Pier".
  const chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId
      const chat = yield* api.CreateChat({ title: "The Pier" })
      for (const entityId of [id("Mira"), id("Tobin")])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Low tide." })
      return chat.id
    })
  )
  await page.goto(`${server().url}/`)
  await page.goto(`${server().url}/groups/${chatId}/new`)
  await expect(page).toHaveURL(`${server().url}/groups/${chatId}/new`)
  await expect(page.getByRole("heading", { level: 1, name: "New chat: The Pier" })).toBeVisible()
  await expect(
    page.getByText("With Mira, Tobin, who greet in turn. Saved when you send the first message.")
  ).toBeVisible()
  // Each member's greeting, in the group's order, as ST starts a group chat; each has its alternates.
  const greetings = page.getByRole("article", { name: /^Greeting from / })
  await expect(greetings).toHaveCount(2)
  await expect(greetings.nth(0)).toContainText("Mira")
  // ST draws an initial greeting; choose the first for this assertion.
  const previous = greetings.nth(0).getByRole("button", { name: "Previous greeting from Mira" })
  if (await previous.isEnabled()) await previous.click()
  await expect(greetings.nth(0)).toContainText("The bell rings for Ana.")
  await expect(greetings.nth(0)).toContainText("1 / 2")
  await expect(greetings.nth(1)).toContainText("Tobin nods.")
  // Opening it made no chat: the group still has one.
  await page.goto(`${server().url}/groups/${chatId}`)
  await expect(page.getByRole("heading", { level: 2, name: "Chats (1)" })).toBeVisible()
  await page.getByRole("main").getByRole("link", { name: "New chat", exact: true }).click()
  await expect(page).toHaveURL(`${server().url}/groups/${chatId}/new`)

  // What's typed is kept in this browser, per group, until it's sent.
  await composer(page).fill("Is the ferry running?")
  await page.reload()
  await expect(composer(page)).toHaveValue("Is the ferry running?")
  await page.getByLabel("Reply from").click()
  await page.getByRole("option", { name: "Tobin" }).click()
  // Reply from is independent of the speaker that Generate writes.
  await expect(page.getByRole("button", { name: "Generate Ana" })).toBeVisible()
  await shoot(page, "new-group-chat")

  // Reopening draws again. Pick the alternate explicitly before sending.
  const before = greetings.nth(0).getByRole("button", { name: "Previous greeting from Mira" })
  if (await before.isEnabled()) await before.click()
  // Mira's alternate greeting, picked before the send, is the one the chat shows.
  await greetings.nth(0).getByRole("button", { name: "Next greeting from Mira" }).click()
  await expect(greetings.nth(0)).toContainText("Mira waves at Ana from the pier.")
  await page.getByRole("button", { name: "Send as Ana" }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  await expect(page.getByRole("heading", { level: 1, name: "The Pier" })).toBeVisible()
  // Both greetings, the alternate picked shown, then the message and Tobin's reply.
  await expect(replies(page).first()).toContainText("Mira waves at Ana from the pier.")
  await expect(replies(page).nth(1)).toContainText("Tobin nods.")
  await expect(replies(page)).toHaveCount(3)
  await expect(replies(page).last().locator("header")).toContainText("Tobin")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })

  // One of the group's chats now: two on its page and its tile.
  await page.goto(`${server().url}/groups/${chatId}`)
  await expect(page.getByRole("heading", { level: 2, name: "Chats (2)" })).toBeVisible()
  await page.goto(`${server().url}/`)
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Groups", exact: true })
    .click()
  await expect(page.getByRole("main").getByRole("button", { name: "Open chat The Pier", exact: true })).toHaveCount(2)
})
