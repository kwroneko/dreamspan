// Starting chats from cards, speakers and the send queue (DESIGN §2.1, §2.2), against a
// server with the fake generator: a card's greeting follows the persona picked until the
// first send makes the chat; Send as and Generate with a one-turn direction; and messages
// sent during a reply wait, post when it ends or is stopped, and can be withdrawn. Every
// card here is made up.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
      first_mes: "{{description}} The log says {{datetimeformat::YYYY-MM-DD}}."
    })
    await importCard(page, { name: "Ana", description: "A cartographer." })
    await importCard(page, { name: "Bo", description: "A diver." })
    await page.goto(`${server().url}/library`)
    for (const persona of ["Ana", "Bo"]) {
      const box = page.getByRole("checkbox", { name: `${persona}: Persona` })
      await box.click()
      await expect(box).toBeChecked()
    }
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
  const greeting = page.getByRole("article", { name: "Greeting" })
  await expect(greeting).toContainText("The bell rings for Ana.")
  // Opening a card made no chat (DESIGN §2.1).
  await page.goto(`${server().url}/chats`)
  await expect(page.getByText("No chats yet")).toBeVisible()
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
  await expect(page.getByRole("heading", { level: 1, name: "Mira & Bo" })).toBeVisible()
  // The greeting picked, as a version of the first message, with its macros resolved for Bo.
  const first = replies(page).first()
  await expect(first).toContainText("Mira waves at Bo from the pier.")
  await expect(first.getByRole("group", { name: "Versions" })).toContainText("2")
  await expect(page.getByRole("article", { name: "Your message" })).toContainText("Bo")
  await expect(replies(page)).toHaveCount(2)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(replies(page).last().locator("header")).toContainText("Mira")

  // Later, playing Ana from here on doesn't rewrite what was said before.
  await page.getByRole("button", { name: "Cast", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Who's here" })
  await dialog.getByLabel("Add someone").click()
  await page.getByRole("option", { name: "Ana" }).click()
  await expect(dialog.getByRole("list", { name: "Members" })).toContainText("Ana")
  await page.keyboard.press("Escape")
  await expect(first).toContainText("Mira waves at Bo from the pier.")
  await page.reload()
  await expect(replies(page).first()).toContainText("Mira waves at Bo from the pier.")
  await expect(page.getByText("No chats yet")).toHaveCount(0)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Chat settings" })).toBeVisible()
  await page.getByText("Speaker's card last").click()
  await shoot(page, "chat-settings")
  await page.keyboard.press("Escape")
  // Settings are state from the leaf on: read back after a reload.
  await page.reload()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("radio", { name: /Speaker's card last/ })).toBeChecked()
})

test("Send as another card, and Generate with a one-turn direction that swipes reuse", async ({ page }) => {
  await login(page)
  await chatWithMira(page)
  // The speaker is always visible; picking a card that isn't in the chat adds it.
  await page.getByRole("button", { name: /^Speaking as Bo/ }).click()
  await page.getByRole("tab", { name: "All cards" }).click()
  await shoot(page, "speaker-switcher")
  await page.getByRole("button", { name: "Tobin" }).click()
  await composer(page).fill("Tobin pushes off from the dock.")
  await page.getByRole("button", { name: "Send as Tobin" }).click()
  const mine = page.getByRole("article", { name: "Your message" }).last()
  await expect(mine.locator("header")).toContainText("Tobin")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // The switcher remembers its tab; recent speakers are one tap away.
  await page.getByRole("button", { name: /^Speaking as Tobin/ }).click()
  await expect(page.getByRole("tab", { name: "All cards" })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Speak as Mira" }).click()

  await composer(page).fill("Mira tells a story about the storm.")
  await page.getByRole("button", { name: "Generate Mira" }).click()
  await expect(composer(page)).toHaveValue("")
  const reply = replies(page).last()
  await expect(reply).toContainText("Direction: Mira tells a story about the storm.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await shoot(page, "generate-with-direction")
  // A swipe of that turn keeps its direction.
  await reply.getByRole("button", { name: "Generate another version" }).click()
  await expect(reply.getByText("2 / 2")).toBeVisible()
  await expect(reply).toContainText("Direction: Mira tells a story about the storm.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // The next turn doesn't inherit it.
  await page.getByRole("button", { name: "Generate Mira" }).click()
  await expect(replies(page).last()).not.toContainText("Direction:")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("a message sent during a reply waits, then posts after it", async ({ page }) => {
  await login(page)
  await chatWithMira(page)
  // Mira's turn, then back to speaking as Bo: both one tap away.
  await page.getByRole("button", { name: "Speak as Mira" }).click()
  await page.getByRole("button", { name: "Generate Mira" }).click()
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
  await page.getByRole("button", { name: "Generate Mira" }).click()
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
  await page.getByRole("button", { name: "Generate Mira" }).click()
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
  await composer(page).fill("A held direction.")
  await page.getByRole("button", { name: "Generate Mira" }).click()
  await expect.poll(() => release !== null).toBe(true)
  await composer(page).fill("Typed while it was on its way.")
  release!()
  await expect(replies(page).last()).toContainText("Direction: A held direction.")
  await expect(composer(page)).toHaveValue("Typed while it was on its way.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("saving a queued message another tab changed meanwhile is a conflict, not an overwrite", async ({
  page,
  context
}) => {
  let heard = false
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      if (String(frame.payload).includes("The other tab's edit.")) heard = true
    })
  )
  await login(page)
  await chatWithMira(page)
  await miraGenerating(page)
  await composer(page).fill("The first words.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  const mine = page.getByRole("list", { name: "Queued messages" })
  await expect(mine).toContainText("The first words.")
  const other = await context.newPage()
  await other.goto(page.url())
  const theirs = other.getByRole("list", { name: "Queued messages" })
  await expect(theirs).toContainText("The first words.")

  await mine.getByRole("button", { name: "Edit" }).click()
  await mine.getByLabel("Queued message").fill("An older draft.")
  await theirs.getByRole("button", { name: "Edit" }).click()
  await theirs.getByLabel("Queued message").fill("The other tab's edit.")
  await theirs.getByRole("button", { name: "Save" }).click()
  await expect(theirs).toContainText("The other tab's edit.")
  // Once this tab has heard of it, its save is refused with theirs shown; its own text stays.
  await expect.poll(() => heard).toBe(true)
  await expect(mine.getByLabel("Queued message")).toHaveValue("An older draft.")
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(mine.getByRole("alert")).toContainText("The other tab's edit.")
  await expect(theirs).toContainText("The other tab's edit.")
  await expect(mine.getByLabel("Queued message")).toHaveValue("An older draft.")
  // Saving again is deliberate: it replaces theirs.
  await mine.getByRole("button", { name: "Save" }).click()
  await expect(mine).toContainText("An older draft.")
  await expect(theirs).toContainText("An older draft.")
  await other.close()
  await page.getByRole("button", { name: "Stop", exact: true }).first().click()
})

test("a saved greeting keeps its card's fields and the date it showed", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-03-01T12:00:00Z"))
  await login(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Wren" }).click()
  const greeting = page.getByRole("article", { name: "Greeting" })
  await expect(greeting).toContainText("A lighthouse keeper. The log says 2026-03-01.")
  await composer(page).fill("Hello, keeper.")
  await page.getByRole("button", { name: /^Send/ }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  const first = replies(page).first()
  await expect(first).toContainText("A lighthouse keeper. The log says 2026-03-01.")
  // A day later, it still says what it said.
  await page.clock.setFixedTime(new Date("2026-03-02T12:00:00Z"))
  await page.reload()
  await expect(replies(page).first()).toContainText("A lighthouse keeper. The log says 2026-03-01.")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})
