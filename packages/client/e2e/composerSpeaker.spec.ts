// Who speaks and who replies at the composer (ST-GRIPES E4, D8; DESIGN §2.2): "Reply from"
// with the next in turn and a pick for one reply, an empty Send asking for the reply alone,
// Generate saying whose turn it writes, a speaker that stays chosen through a reload and in
// a second tab, and the switcher's search. Every card here is made up.
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })

const composer = (page: Page) => page.getByLabel("Message", { exact: true })
const generating = (page: Page) => page.getByText("generating", { exact: true })
const replyFrom = (page: Page) => page.getByRole("group", { name: "Reply from" })
const speakerChip = (page: Page) => page.getByRole("button", { name: /^Speaking as / })
const lastHeader = (page: Page) => page.locator("article[data-slot]").last().locator("header").first()

/** A chat with `characters`, played as Ana and Bo (personas), with no messages yet. */
const chatWith = (characters: ReadonlyArray<string>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const ids: Record<string, EntityId> = {}
      for (const name of [...characters, "Ana", "Bo"]) {
        const existing = (yield* api.ListCards()).find((card) => card.name === name)
        ids[name] = existing?.entityId ?? (yield* api.CreateCard({ label: name, name })).entityId
        if (name === "Ana" || name === "Bo") yield* api.SetPersona({ entityId: ids[name], persona: true })
      }
      const chat = yield* api.CreateChat({ title: characters.length > 1 ? "The Lantern" : characters[0]! })
      for (const name of [...characters, "Ana", "Bo"])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ids[name]! } })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [ids.Ana!, ids.Bo!] }
      })
      return chat.id
    })
  )

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

test("Reply from: the next in turn, a pick for one reply, and an empty Send", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin", "Wren"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  // The characters only: the cards the user plays never reply.
  await expect(replyFrom(page).getByRole("button", { name: /^Reply from / })).toHaveCount(3)
  await expect(replyFrom(page).getByRole("button", { name: "Reply from Mira" })).toHaveAttribute("aria-pressed", "true")
  await expect(replyFrom(page)).toContainText("Next in turn: Mira, first in the cast")

  await composer(page).fill("The lantern gutters.")
  await page.keyboard.press("Enter")
  await expect(lastHeader(page)).toContainText("Mira")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(replyFrom(page)).toContainText("Next in turn: Tobin, after Mira")

  // A pick is for one reply, kept on the server until it's used.
  await replyFrom(page).getByRole("button", { name: "Reply from Wren" }).click()
  await expect(replyFrom(page)).toContainText("Wren replies next: your pick")
  await page.reload()
  await expect(replyFrom(page).getByRole("button", { name: "Reply from Wren" })).toHaveAttribute("aria-pressed", "true")
  // With nothing typed, Send asks for that reply alone.
  await page.getByRole("button", { name: "Wren replies" }).click()
  await expect(lastHeader(page)).toContainText("Wren")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(replyFrom(page)).toContainText("Next in turn: Mira, after Wren")

  // Generate says whose turn it writes: the persona's, for the user.
  const write = page.getByRole("button", { name: "Write for Ana" })
  await expect(write).toBeVisible()
  await write.click()
  await expect(lastHeader(page)).toContainText("Ana")
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
})

test("the speaker stays chosen through a reload and in every tab; the switcher searches", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)

  // The search field has focus as the switcher opens; type part of a name, then Enter.
  await speakerChip(page).click()
  await page.getByRole("tab", { name: "All cards" }).click()
  const search = page.getByRole("combobox", { name: "Find a card to speak as" })
  await expect(search).toBeFocused()
  await page.keyboard.type("bo")
  await expect(page.getByRole("option")).toHaveCount(1)
  await expect(page.getByRole("option", { name: /Bo/ })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Enter")
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)

  // Arrow keys move through what's left; Escape closes without a change.
  await speakerChip(page).click()
  await page.keyboard.type("i")
  await expect(page.getByRole("option")).toHaveCount(2)
  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("option", { name: /Tobin/ })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(search).toBeHidden()
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)

  // Kept on the server with the composer: a reload, and a second tab, speak as Bo.
  await page.reload()
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Bo/)
  const second = await page.context().newPage()
  await second.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(second)).toHaveAccessibleName(/^Speaking as Bo/)
  // A change in one tab shows in the other.
  await speakerChip(second).click()
  await second.keyboard.type("ana")
  await second.keyboard.press("Enter")
  await expect(speakerChip(second)).toHaveAccessibleName(/^Speaking as Ana/)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  await second.close()
})

test("a one-card chat has no Reply from, and an empty Send asks its character", async ({ page }) => {
  const chatId = await chatWith(["Mira"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Ana/)
  await expect(replyFrom(page)).toHaveCount(0)
  await page.getByRole("button", { name: "Mira replies" }).click()
  await expect(lastHeader(page)).toContainText("Mira")
})
