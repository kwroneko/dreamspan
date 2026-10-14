// The Cast tab (DESIGN §2.1, §2.2, §3.5, §4), against a server with the fake generator:
// everyone in the chat with what ST's group panel offers (absent, speak now, write as, the
// card shown, remove, add), and a card edited only in this chat or everywhere. Every card
// here is made up.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
    const box = page.getByRole("checkbox", { name: "Bo: Persona" })
    await box.click()
    await expect(box).toBeChecked()
  })())

/** A chat with Mira, played as Bo, with Mira's reply to the first message finished; its URL. */
const chatWithMira = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await setUp(page)
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Start a chat with Mira" }).click()
  await page.getByLabel("Playing as").click()
  await page.getByRole("option", { name: "Bo" }).click()
  await composer(page).fill("Hello there.")
  await page.getByRole("button", { name: "Send as Bo" }).click()
  await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
  await expect(replies(page)).toHaveCount(2)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  return page.url()
}

/** The side panel at its Cast tab: the panel's own tab when it's open, else the header's button. */
const openCast = async (page: Page) => {
  const tab = page.getByRole("tab", { name: "Cast", exact: true })
  const toggle = page.getByRole("group", { name: "Chat panel" }).getByRole("button", { name: "Cast", exact: true })
  await expect(tab.or(toggle)).toBeVisible()
  await ((await tab.isVisible()) ? tab : toggle).click()
  await expect(members(page)).toBeVisible()
}

test("the Cast tab: absent, speak now, write as, the card, add and remove", async ({ page }) => {
  await chatWithMira(page)
  await openCast(page)
  await expect(page.getByText("Changes here apply from the latest message on, on this branch.")).toBeVisible()
  await expect(members(page).getByRole("listitem")).toHaveCount(2)
  await expect(member(page, "Bo")).toContainText("played by you")

  // Absent from here on, like ST's mute; and back.
  await member(page, "Mira").getByRole("switch").click()
  await expect(member(page, "Mira")).toContainText("absent")
  await member(page, "Mira").getByRole("switch").click()
  await expect(member(page, "Mira")).not.toContainText("absent")

  // The card as this chat uses it, read-only.
  await page.getByRole("button", { name: "Show card: Mira" }).click()
  const card = page.getByRole("region", { name: "Mira's card" })
  await expect(card).toContainText("A harbor pilot who reads the tides.")
  await expect(card).toContainText("Mind the shoal.")
  await expect(card).toContainText("Empty: scenario, creator's notes.")
  await shoot(page, "cast-tab")

  // Speak now: the model writes Mira's turn.
  await page.getByRole("button", { name: "Speak now: Mira" }).click()
  await expect(member(page, "Mira")).toContainText("writing…")
  await page.keyboard.press("Escape")
  await expect(replies(page)).toHaveCount(3)
  await expect(replies(page).last().locator("header")).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })

  // Add Tobin, searching for him, then write as him.
  await openCast(page)
  await page.getByRole("button", { name: "Add character" }).click()
  await page.getByRole("searchbox", { name: "Search your cards" }).fill("tob")
  const addable = page.getByRole("list", { name: "Cards to add" })
  await expect(addable.getByRole("button")).toHaveCount(1)
  await addable.getByRole("button", { name: /^Tobin/ }).click()
  await expect(member(page, "Tobin")).toBeVisible()
  await page.getByRole("button", { name: "Write as Tobin" }).click()
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
  await expect(members(page).getByRole("listitem")).toHaveCount(2)
})

test("a card edited only in this chat, and everywhere", async ({ page }) => {
  const other = await chatWithMira(page)
  await chatWithMira(page)
  await openCast(page)
  await page.getByRole("button", { name: "Edit Mira" }).click()
  const scope = page.getByRole("dialog", { name: "Edit Mira" })
  await expect(scope.getByRole("button", { name: /^Everywhere \(used by \d+ chats\)$/ })).toBeVisible()
  await shoot(page, "cast-edit-scope")
  await scope.getByRole("button", { name: /^Only in this chat/ }).click()

  // The editor says it's this chat's own version, and how to get back.
  await expect(page).toHaveURL(/\/library\/[^/?]+$/)
  await expect(page.getByText("Edited for this chat.")).toBeVisible()
  const description = page.getByRole("textbox", { name: "Description" })
  await expect(description).toHaveValue("A harbor pilot who reads the tides.")
  await description.fill("A river pilot who reads the tides.")
  await page.getByRole("button", { name: /^Save/ }).first().click()
  await page.getByRole("dialog", { name: "Save a revision" }).getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByText("Saved a revision.")).toBeVisible()
  await page.getByRole("link", { name: /^← Back to / }).click()

  // The row says so and opens it again; the card shown is this chat's.
  await openCast(page)
  const edited = member(page, "Mira").getByRole("link", { name: "Edited for this chat" })
  await expect(edited).toBeVisible()
  await page.getByRole("button", { name: "Show card: Mira" }).click()
  await expect(page.getByRole("region", { name: "Mira's card" })).toContainText("A river pilot")
  await page.getByRole("button", { name: "Edit Mira" }).click()
  await expect(page.getByRole("dialog", { name: "Edit Mira" })).toContainText("Opens this chat's own version")
  await page.getByRole("button", { name: "Cancel" }).click()

  // Another chat with Mira still has the original.
  await page.goto(other)
  await openCast(page)
  await expect(member(page, "Mira").getByRole("link", { name: "Edited for this chat" })).toHaveCount(0)
  await page.getByRole("button", { name: "Show card: Mira" }).click()
  await expect(page.getByRole("region", { name: "Mira's card" })).toContainText("A harbor pilot")

  // Everywhere opens the library's card, which says how many chats use it.
  await page.getByRole("button", { name: "Edit Mira" }).click()
  await page.getByRole("button", { name: /^Everywhere/ }).click()
  await expect(page.getByText(/used by \d+ chats/)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue("A harbor pilot who reads the tides.")
})

test("a name edited only in this chat is the name the chat shows, in the Cast and the composer", async ({ page }) => {
  await chatWithMira(page)
  await openCast(page)
  await page.getByRole("button", { name: "Edit Mira" }).click()
  await page.getByRole("button", { name: /^Only in this chat/ }).click()
  await expect(page.getByText("Edited for this chat.")).toBeVisible()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Harbor Mira")
  await page.getByRole("button", { name: /^Save/ }).first().click()
  await page.getByRole("dialog", { name: "Save a revision" }).getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByText("Saved a revision.")).toBeVisible()
  await page.getByRole("link", { name: /^← Back to / }).click()

  // The row has the chat's name, and the library label beside it.
  await openCast(page)
  const row = member(page, "Harbor Mira")
  await expect(row).toBeVisible()
  await expect(row).toContainText("Mira")
  await shoot(page, "cast-local-rename-row")
  await page.getByRole("button", { name: "Close the panel" }).click()
  await expect(members(page)).toHaveCount(0)

  // The composer's recent speakers, then the speaker chip, Send and Generate.
  await page.getByRole("button", { name: "Speak as Harbor Mira" }).click()
  await expect(page.getByRole("button", { name: "Speaking as Harbor Mira. Change the speaker" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send as Harbor Mira" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Generate Harbor Mira" })).toBeVisible()
  await shoot(page, "cast-local-rename-composer")
})

test("the composer regenerates the latest reply, apart from Generate", async ({ page }) => {
  await chatWithMira(page)
  const latest = replies(page).last()
  await page.getByRole("button", { name: "Regenerate the latest reply" }).click()
  await expect(generating(page)).toHaveCount(1)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // A new version of that reply, not a new turn.
  await expect(replies(page)).toHaveCount(2)
  await expect(latest.getByRole("group", { name: "Versions" })).toContainText("2")
})
