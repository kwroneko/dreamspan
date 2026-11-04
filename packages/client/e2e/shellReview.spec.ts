import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test("Groups opens its forks after navigating home from an unrelated character", async ({ page }) => {
  const { a, group } = await admin((api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Alone", name: "Alone" })
      const b = yield* api.CreateCard({ label: "Bee", name: "Bee" })
      const c = yield* api.CreateCard({ label: "Cee", name: "Cee" })
      yield* api.StartChat({
        cards: [a.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Alone's chat", speakerEntityId: a.entityId }
      })
      const group = yield* api.StartChat({
        cards: [b.entityId, c.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Group story", speakerEntityId: b.entityId }
      })
      yield* api.RenameChat({ chatId: group.chat.id, name: "Bee and Cee" })
      return { a, group }
    })
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page
    .getByRole("main")
    .getByRole("button", { name: `Open ${a.label}`, exact: true })
    .click()
  await expect(page.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("Alone")
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click()
  await page
    .getByRole("group", { name: "Show", exact: true })
    .getByRole("button", { name: "Groups", exact: true })
    .click()
  await page.getByRole("main").getByRole("button", { name: "Open chat Bee and Cee", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/chats/${group.chat.id}`))
  await expect(page.getByRole("tab", { name: "This chat", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("link", { name: "Edit card", exact: true })).toHaveCount(0)
  await expect(page.getByRole("region", { name: /^(Named and pinned|Branches)$/ }).first()).toBeVisible()
})

test("home pins discard an unrelated remembered character tab", async ({ page }) => {
  const { a, group } = await admin((api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Pinned Alone", name: "Pinned Alone" })
      const b = yield* api.CreateCard({ label: "Pinned Bee", name: "Pinned Bee" })
      const c = yield* api.CreateCard({ label: "Pinned Cee", name: "Pinned Cee" })
      yield* api.StartChat({
        cards: [a.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Alone's chat", speakerEntityId: a.entityId }
      })
      const group = yield* api.StartChat({
        cards: [b.entityId, c.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Group story", speakerEntityId: b.entityId }
      })
      yield* api.RenameChat({ chatId: group.chat.id, name: "Pinned Bee and Cee" })
      yield* api.SetChatPin({ chatId: group.chat.id, leaf: group.chat.activeLeafSlotId, pinned: true })
      return { a, group }
    })
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page
    .getByRole("main")
    .getByRole("button", { name: `Open ${a.label}`, exact: true })
    .click()
  await expect(page.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("Pinned Alone")
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click()
  await page
    .getByRole("main")
    .getByRole("region", { name: "Pinned chats", exact: true })
    .getByRole("button", { name: "Open chat Pinned Bee and Cee", exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`/chats/${group.chat.id}`))
  await expect(page.getByRole("tab", { name: "This chat", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("link", { name: "Edit card", exact: true })).toHaveCount(0)
})

test("a character that left without speaking is listed under Was in", async ({ page }) => {
  await admin((api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Silent departed", name: "Silent departed" })
      const b = yield* api.CreateCard({ label: "Still present", name: "Still present" })
      const chat = yield* api.StartChat({
        cards: [a.entityId, b.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Nobody has spoken as Silent departed", speakerEntityId: null }
      })
      yield* api.ChangeCast({
        chatId: chat.chat.id,
        slotId: chat.chat.activeLeafSlotId,
        change: { _tag: "Leave", entityId: a.entityId }
      })
    })
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page.getByRole("main").getByRole("button", { name: "Open Silent departed", exact: true }).click()
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()

  await expect(page.getByRole("region", { name: "Was in", exact: true })).toBeVisible()
})

test("a silent present character played by the user is not classified as departed", async ({ page }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Silent present", name: "Silent present" })
      const b = yield* api.CreateCard({ label: "Present companion", name: "Present companion" })
      const chat = yield* api.StartChat({
        cards: [a.entityId, b.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Synthetic start", speakerEntityId: null }
      })
      yield* api.ChangeCast({
        chatId: chat.chat.id,
        slotId: chat.chat.activeLeafSlotId,
        change: { _tag: "PlayedByMe", entityIds: [a.entityId] }
      })
    })
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page.getByRole("main").getByRole("button", { name: "Open Silent present", exact: true }).click()
  await expect(page.getByRole("region", { name: "With others", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Was in", exact: true })).toHaveCount(0)
})

test("home pins keep a remembered tab for a character the user plays there", async ({ page }) => {
  const { played } = await admin((api) =>
    Effect.gen(function* () {
      const played = yield* api.CreateCard({ label: "Played by me", name: "Played by me" })
      const partner = yield* api.CreateCard({ label: "Model partner", name: "Model partner" })
      const chat = yield* api.StartChat({
        cards: [played.entityId, partner.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Synthetic start", speakerEntityId: null }
      })
      yield* api.ChangeCast({
        chatId: chat.chat.id,
        slotId: chat.chat.activeLeafSlotId,
        change: { _tag: "PlayedByMe", entityIds: [played.entityId] }
      })
      yield* api.RenameChat({ chatId: chat.chat.id, name: "Played pair" })
      yield* api.SetChatPin({ chatId: chat.chat.id, leaf: chat.chat.activeLeafSlotId, pinned: true })
      return { played }
    })
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(server().url)
  await page
    .getByRole("main")
    .getByRole("button", { name: `Open ${played.label}`, exact: true })
    .click()
  await expect(page.getByRole("tab", { name: played.label, exact: true })).toHaveAttribute("aria-selected", "true")
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("link", { name: "Home", exact: true })
    .click()
  await page
    .getByRole("main")
    .getByRole("region", { name: "Pinned chats", exact: true })
    .getByRole("button", { name: "Open chat Played pair", exact: true })
    .click()
  await expect(page.getByRole("tab", { name: played.label, exact: true })).toHaveAttribute("aria-selected", "true")
})
