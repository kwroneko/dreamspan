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

test("hundreds of cards stay searchable and reachable by keyboard on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const chatId = await chatWith(["Mira"])
  const cardCount = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      for (let index = 0; index < 240; index++) {
        const name = `Visitor ${String(index).padStart(3, "0")}`
        yield* api.CreateCard({ label: name, name })
      }
      return (yield* api.ListCards()).length
    })
  )
  await page.goto(`${server().url}/chats/${chatId}`)
  await speakerChip(page).click()
  await page.getByRole("tab", { name: "All cards" }).click()
  const search = page.getByRole("combobox", { name: "Find a card to speak as" })
  await expect(search).toBeFocused()
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-setsize", String(cardCount))
  expect(await page.getByRole("option").count()).toBeLessThan(30)
  // The file shares a library with other scenarios; isolate the rows this test created.
  await search.fill("Visitor")
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-setsize", "240")
  await search.press("End")
  await search.press("ArrowUp")
  await expect(page.getByRole("option", { name: "Visitor 238" })).toHaveAttribute("aria-selected", "true")
  await expect(search).toBeInViewport()
  await search.fill("239")
  await expect(page.getByRole("option")).toHaveCount(1)
  await search.press("Enter")
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Visitor 239/)
  await page.reload()
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Visitor 239/)
})

test("a phone shows the full named Write for action and keeps an empty input compact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const chatId = await chatWith(["Mira", "Captain Rhee"])
  await page.goto(`${server().url}/chats/${chatId}`)
  await speakerChip(page).click()
  await page.getByRole("tab", { name: "All cards" }).click()
  await page.getByRole("combobox", { name: "Find a card to speak as" }).fill("rhee")
  await page.keyboard.press("Enter")
  await expect(speakerChip(page)).toHaveAccessibleName(/^Speaking as Captain Rhee/)
  const write = page.getByRole("button", { name: "Write for Captain Rhee" })
  await expect(write).toBeEnabled()
  const label = write.locator("span").first()
  expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  expect((await composer(page).boundingBox())!.height).toBeLessThan(45)
})

test("reply order follows the branch tip, including a character turn beyond the loaded window", async ({ page }) => {
  const chatId = await chatWith(["Mira", "Tobin", "Wren"])
  const firstSlot = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const entity = (name: string) => cards.find((card) => card.name === name)!.entityId
      let parent = null as import("@rp/shared/chat.ts").SlotId | null
      let first = parent
      for (let index = 0; index < 82; index++) {
        const sent = yield* api.SendMessage({
          chatId,
          parentSlotId: parent,
          branch: false,
          content: `Turn ${index}: the room is quiet.`,
          speakerEntityId: entity(index === 0 ? "Mira" : index === 1 ? "Tobin" : "Ana")
        })
        if (sent._tag === "Posted") {
          parent = sent.entry.slotId
          first ??= parent
        }
      }
      return first
    })
  )
  // An old-message deep link opens around Mira, not the actual last character, Tobin.
  await page.goto(`${server().url}/chats/${chatId}?slot=${firstSlot}`)
  await expect(replyFrom(page)).toContainText("Next in turn: Wren, after Tobin")
  await expect(page.getByRole("button", { name: "Wren replies" })).toBeEnabled()
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(replyFrom(page)).toContainText("Next in turn: Wren, after Tobin")
})

test("typing stays available while the saved speaker is loading; sending waits for it", async ({ page }) => {
  const chatId = await chatWith(["Mira"])
  let waiting = false
  let release: (() => void) | null = null
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    const held: Array<string | Buffer> = []
    let resumed = false
    release = () => {
      resumed = true
      for (const message of held) upstream.send(message)
    }
    socket.onMessage((message) => {
      if (!resumed && String(message).includes('"tag":"GetComposerChoice"')) {
        waiting = true
        held.push(message)
      } else upstream.send(message)
    })
    upstream.onMessage((message) => socket.send(message))
  })
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect.poll(() => waiting).toBe(true)
  await expect(composer(page)).toBeEditable()
  await composer(page).fill("Kept while the speaker loads.")
  const send = page.getByRole("button", { name: "Send as Ana" })
  await expect(send).toBeDisabled()
  release!()
  await expect(send).toBeEnabled()
  await expect(composer(page)).toHaveValue("Kept while the speaker loads.")
  await send.click()
  await expect(page.getByRole("article", { name: "Your message", exact: true }).last()).toContainText(
    "Kept while the speaker loads."
  )
})
