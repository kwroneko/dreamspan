import { expectTextBox } from "./support/textbox.ts"
// The Cast tab (DESIGN §2.1, §2.2, §3.5, §4), against a server with the fake generator:
// everyone in the chat with what ST's group panel offers (mute, speak now, write as, the
// card shown, remove, add), and a card edited only in this chat or everywhere. Every card
// here is made up.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { markPersona } from "./support/library.ts"
import { openPanel } from "./support/panel.ts"
import { addToCast, pickPendingPersona } from "./support/cast.ts"

// About four seconds a reply.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "40", FAKE_GENERATOR_TOKENS: "160" })

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=${String(data.name)}.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

// The tab, its menus and tooltips run under the Content-Security-Policy too.
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
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

const replies = (page: Page) => page.getByRole("article", { name: "Reply" })
const generating = (page: Page) => page.getByText("generating", { exact: true })
const composer = (page: Page) => page.getByLabel("Message", { exact: true })
const members = (page: Page) => page.getByRole("list", { name: "Characters in this chat" })
const member = (page: Page, name: string) => members(page).getByRole("listitem", { name })

let library: Promise<void> | null = null
/** Mira and Tobin to talk to, Bo in the persona folder: once per file. */
const setUp = (page: Page) =>
  (library ??= (async () => {
    await importCard(page, {
      name: "Mira",
      description: "A harbor pilot who reads the tides.",
      personality: "Patient.",
      first_mes: "The bell rings for {{user}}.",
      mes_example: "<START>\n{{char}}: Mind the shoal."
    })
    await importCard(page, { name: "Tobin", description: "A ferryman.", first_mes: "Tobin nods." })
    await importCard(page, { name: "Bo", description: "A diver." })
    await page.goto(`${server().url}/library`)
    await markPersona(page, "Bo")
  })())

/** A chat with Mira, played as Bo, with Mira's reply to the first message finished; its URL. */
const chatWithMira = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await setUp(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Mira" }).click()
  await pickPendingPersona(page, "Bo")
  await composer(page).fill("Hello there.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
  await expect(replies(page)).toHaveCount(2)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  return page.url()
}

/** The side panel at its Cast tab, opened however the chat's header offers it. */
const openCast = async (page: Page) => {
  await openPanel(page, "Cast")
  await expect(members(page)).toBeVisible()
}

test("the Cast tab: mute, speak now, write as, the card, add and remove", async ({ page }) => {
  await chatWithMira(page)
  await openCast(page)
  // No standing line about when changes apply (owner, 2026-11-02).
  await expect(page.getByText("Changes here apply", { exact: false })).toHaveCount(0)
  // The card you play is apart, with no count of the chats it's in; Mira is the one character.
  const you = page.getByRole("group", { name: "Your persona", exact: true })
  await expect(you).toContainText("Bo")
  await expect(you).not.toContainText(/used by/)
  await expect(members(page).getByRole("listitem")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Mute Bo" })).toHaveCount(0)
  await expect(member(page, "Mira").getByRole("button", { name: "Mute Mira", exact: true })).toBeVisible()
  await expect(member(page, "Mira")).not.toContainText(/used by/)
  await expect(page.getByRole("heading", { level: 2, name: "1 character" })).toBeVisible()
  // One row: portrait, name, Mute, Away, Speak now and ⋯; no wall of text buttons.
  await expect(member(page, "Mira").getByRole("button")).toHaveCount(6)

  // Absent from here on, like ST's mute; and back. The button says what it does, the row what it is.
  await member(page, "Mira").getByRole("button", { name: "Mute Mira", exact: true }).click()
  await expect(member(page, "Mira").getByText("Muted", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: /1 muted/ })).toBeVisible()
  await shoot(page, "cast-tab")
  await member(page, "Mira").getByRole("button", { name: "Unmute Mira", exact: true }).click()
  await expect(member(page, "Mira").getByText("Muted", { exact: true })).toHaveCount(0)

  // The name opens Mira's tab, where the card is edited.
  await member(page, "Mira").getByRole("button", { name: "Mira: open their card" }).click()
  await expectTextBox(
    page.getByRole("textbox", { name: "Description", exact: true }),
    "A harbor pilot who reads the tides."
  )
  await page.goBack()
  await expect(members(page)).toBeVisible()
  await page.goForward()
  await expectTextBox(
    page.getByRole("textbox", { name: "Description", exact: true }),
    "A harbor pilot who reads the tides."
  )

  // Speak now: the model writes Mira's turn.
  await openCast(page)
  await page.getByRole("button", { name: "Speak now: Mira" }).click()
  await expect(member(page, "Mira")).toContainText("writing…")
  await page.keyboard.press("Escape")
  await expect(replies(page)).toHaveCount(3)
  await expect(replies(page).last().locator("header")).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })

  // Add Tobin, searching for him, then write as him (under his row's ⋯).
  await openCast(page)
  await addToCast(page, "Tobin")
  await expect(member(page, "Tobin")).toBeVisible()
  await page.getByRole("button", { name: "More for Tobin" }).click()
  await page.getByRole("menuitem", { name: "Write as Tobin" }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: /^Speaking as Tobin/ })).toBeVisible()
  await composer(page).fill("Tobin pushes off from the dock.")
  await page.getByRole("button", { name: "Send as Tobin" }).click()
  // A cast member the user doesn't play speaks on the model's side, whoever wrote it.
  const sent = page.getByRole("article").filter({ hasText: "Tobin pushes off from the dock." })
  await expect(sent.locator("header")).toContainText("Tobin")
  await expect(sent).toHaveAttribute("aria-label", "Reply")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })

  // Removed from here on.
  await openCast(page)
  await page.getByRole("button", { name: "More for Tobin" }).click()
  await page.getByRole("menuitem", { name: "Remove from chat" }).click()
  await expect(member(page, "Tobin")).toHaveCount(0)
  await expect(members(page).getByRole("listitem")).toHaveCount(1)
})

test("the full editor opens the card used everywhere over the chat, and goes back to it", async ({ page }) => {
  await chatWithMira(page)
  await openCast(page)
  const chat = page.url()
  await page.getByRole("button", { name: "More for Mira" }).click()
  await page.getByRole("menuitem", { name: "Open Mira in the full editor", exact: true }).click()
  const editor = page.getByRole("region", { name: "Card editor", exact: true })
  await expect(editor.getByText(/Used by \d+ chats?/)).toBeVisible()
  await expectTextBox(editor.getByRole("textbox", { name: "Description" }), "A harbor pilot who reads the tides.")
  // The editor is a tab beside the chat, bound to it.
  expect(new URL(page.url()).pathname).toMatch(/^\/library\//)
  expect(`/chats/${new URL(page.url()).searchParams.get("chat")}`).toBe(new URL(chat).pathname)
  await editor.getByRole("button", { name: "Close", exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(page.url()).toBe(chat)
})

test("the latest reply's › makes a new version, shown without a hover even at one version", async ({ page }) => {
  await chatWithMira(page)
  const latest = replies(page).last()
  const next = latest.getByRole("group", { name: "Versions" }).getByRole("button", { name: "Generate another version" })
  // Not hovered: the pointer is on the composer.
  await page.getByTestId("composer").hover()
  await expect(next).toHaveCSS("opacity", "1")
  // The reply's own › is the one way to swipe it: the composer has no second copy.
  await expect(page.getByRole("button", { name: /regenerate the latest/i })).toHaveCount(0)
  await next.click()
  await expect(generating(page)).toHaveCount(1)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // A new version of that reply, not a new turn.
  await expect(replies(page)).toHaveCount(2)
  await expect(latest.getByRole("group", { name: "Versions" })).toContainText("2")
})
