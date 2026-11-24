import { join } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { openCastAdd } from "./support/cast.ts"
import { showActions } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

/** Does something in the pending chat's Cast tab (who's in it, who you play, who replies), then closes the panel. */
const inCast = async (page: Page, act: (tab: Locator) => Promise<void>) => {
  const tab = await openPanel(page, "Cast")
  await act(tab)
  await closePanel(page)
}
/** Starts adding a character from the Cast tab's Add characters, as in a saved chat. */
const startAdding = async (page: Page, name: string) => {
  await openPanel(page, "Cast")
  const section = await openCastAdd(page)
  await section.getByRole("searchbox", { name: "Find a character to add" }).fill(name)
  await section.getByRole("button", { name: `Add ${name} to this chat`, exact: true }).click()
}
/** Leaves a character out of the pending chat, from their row's ⋯ in the Cast tab. */
const remove = (page: Page, name: string) =>
  inCast(page, async (tab) => {
    await tab.getByRole("button", { name: `More for ${name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Remove from chat", exact: true }).click()
  })

// A new chat is a pending chat (DraftChatPage.tsx), whose greetings follow who's in it, as a
// group start's (the server's SyncPendingGreetings): a character who joins greets with their own
// greeting, a message with their other greetings as swipes; with two characters, group-only
// greetings are swipes too; one who leaves, or whom you play, takes their greeting along, and a
// group greeting shown then gives way to the card's first, saying so. None of it starts the chat.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "10000", FAKE_GENERATOR_TOKENS: "10" })

/** A greeting message, by its text now. */
const greetingOf = (page: Page, from: string) =>
  page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: from })
/** Steps a message's swipes. */
const step = async (message: Locator, direction: "Next" | "Previous") => {
  await showActions(message)
  await message.getByRole("button", { name: `${direction} swipe`, exact: true }).click()
}
const FELL_BACK = "selected group greeting is no longer available"

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const)
    test(`group greetings follow a new chat's cast at ${width} (${theme})`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Mira ${width} ${theme}`
      const second = `Tobin ${width} ${theme}`
      for (const data of [
        {
          name,
          first_mes: "Mira opens the door.",
          alternate_greetings: ["Mira waves."],
          group_only_greetings: ["Mira welcomes the crew."]
        },
        { name: second, first_mes: "Tobin nods.", group_only_greetings: ["Tobin greets everyone."] }
      ]) {
        const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
          data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
          headers: { origin: server().url, "content-type": "application/octet-stream" }
        })
        expect(response.status()).toBe(200)
      }
      await page.goto(`${server().url}/library`)
      await page.getByRole("link", { name: `Start a chat with ${name}`, exact: true }).click()
      await expect(page).toHaveURL(/[?&]draft=/)
      const greeting = page.getByRole("article", { name: "Reply", exact: true }).first()
      await expect(greeting).toContainText("Mira opens the door.")
      // One character: her ordinary greetings only.
      await expect(greeting).toContainText("1/2")
      await step(greeting, "Next")
      await expect(greeting).toContainText("Mira waves.")
      const add = async () => {
        await startAdding(page, second)
        await closePanel(page)
        await expect(greetingOf(page, "Tobin nods.")).toBeVisible()
      }
      await add()
      // Her greeting stays what it showed; both now offer their group greetings too.
      await expect(greeting).toContainText("Mira waves.")
      await expect(greeting).toContainText("2/3")
      await step(greeting, "Next")
      await expect(greeting).toContainText("Mira welcomes the crew.")
      const secondGreeting = page.getByRole("article", { name: "Reply", exact: true }).nth(1)
      await step(secondGreeting, "Next")
      await expect(secondGreeting).toContainText("Tobin greets everyone.")
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `group-${width}-${theme}.png`) })
      await expectLayout(page, info, "pending-group-greetings")
      // He leaves: his greeting goes, and hers, a group greeting, falls back to her first.
      await remove(page, second)
      await expect(greeting).toContainText("Mira opens the door.")
      await expect(greeting).toContainText("1/2")
      await expect(greetingOf(page, "Tobin")).toHaveCount(0)
      await expect(page.getByText(FELL_BACK).first()).toBeVisible()
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `fallback-${width}-${theme}.png`) })
      // He comes back: the group greetings with him.
      await add()
      await expect(greeting).toContainText("1/3")
      await step(greeting, "Next")
      await step(greeting, "Next")
      await expect(greeting).toContainText("Mira welcomes the crew.")
      // Played, he's no character: his greeting goes, and hers falls back again.
      await openPanel(page, "Cast")
      await page.getByRole("button", { name: /^Playing as / }).click()
      await page.getByRole("tab", { name: "All cards", exact: true }).click()
      const search = page.getByRole("combobox", { name: "Find a card to play as" })
      await search.fill(second)
      await expect(page.getByRole("option")).toHaveCount(1)
      await search.press("Enter")
      await expect(page.getByRole("button", { name: new RegExp(`^Playing as ${second}`) })).toBeVisible()
      await closePanel(page)
      await expect(greetingOf(page, "Tobin")).toHaveCount(0)
      await expect(greeting).toContainText("Mira opens the door.")
      await expect(greeting).toContainText("1/2")
      // None of that started it; the first message does, the greeting as shown.
      await expect(page).toHaveURL(/[?&]draft=/)
      await page.getByLabel("Message", { exact: true }).fill("Hello crew.")
      // You speak as the card you play: Send as them.
      await page
        .getByTestId("composer-box")
        .getByRole("button", { name: /^Send\b/ })
        .click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+(?:\?.*)?$/)
      await expect(greeting).toContainText("Mira opens the door.")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
}

test("a group's new chat can restore a removed original member", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const names = ["Group Mira", "Group Tobin"]
  for (const name of names) {
    const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3.0",
          data: { name, first_mes: `${name} waves.`, group_only_greetings: [`${name} welcomes everyone.`] }
        })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.status()).toBe(200)
  }
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      return yield* api.StartChat({
        cards: names.map((name) => cards.find((card) => card.name === name)!.entityId),
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hello group.", speakerEntityId: null }
      })
    })
  )
  await page.goto(`${server().url}/groups/${started.chat.id}/new`)
  await expect(page).toHaveURL(/[?&]draft=/)
  // Each member greets at a random greeting of theirs: show Mira's group greeting.
  const greeting = page.getByRole("article", { name: "Reply", exact: true }).first()
  await expect(greeting).toContainText("Group Mira")
  if (!(await greeting.innerText()).includes("Group Mira welcomes everyone.")) await step(greeting, "Next")
  await expect(greeting).toContainText("Group Mira welcomes everyone.")
  await remove(page, "Group Tobin")
  await expect(greeting).toContainText("Group Mira waves.")
  await expect(page.getByText(FELL_BACK).first()).toBeVisible()
  await expect(greetingOf(page, "Group Tobin")).toHaveCount(0)
  await startAdding(page, "Group Tobin")
  await closePanel(page)
  await expect(greetingOf(page, "Group Tobin waves.")).toBeVisible()
  await step(greeting, "Next")
  await expect(greeting).toContainText("Group Mira welcomes everyone.")
  await expect(page).toHaveURL(/[?&]draft=/)
})
