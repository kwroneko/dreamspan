// A chat's own note's unsaved dot shows only on its branch (owner, 2026-11-24): on another branch
// the note can't be seen, so no dot points at it; back on its branch the draft and its dot return.
// Synthetic text only.
import { Effect } from "effect"
import { expect, type Page, test } from "@playwright/test"
import type { ForkId } from "@dreamspan/shared/chat.ts"
import { urlOpenedInNewTab } from "./support/browserTab.ts"
import { openPanel } from "./support/panel.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/** With the message's branch arrows, in the app (no page load). */
const switchTo = async (page: Page, name: string, arrow: "Next branch" | "Previous branch") => {
  await page.getByRole("button", { name: arrow, exact: true }).click()
  await expect(page.getByRole("button", { name: new RegExp(`^Branch: ${name}`) })).toBeVisible()
}

test("a chat note's unsaved dot shows on its branch only, and comes back with it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const { chat, leftFork } = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Dot Mira", name: "Mira" })
      const start = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Before the fork.", speakerEntityId: null }
      })
      const note = yield* api.CreateChatNote({ chatId: start.chat.id, title: "Weather" })
      yield* api.ChangeCast({
        chatId: start.chat.id,
        slotId: start.entry.slotId,
        change: { _tag: "Note", entityId: note.entityId, active: true }
      })
      const left = yield* api.SendMessage({
        chatId: start.chat.id,
        parentSlotId: start.entry.slotId,
        branch: false,
        content: "Left."
      })
      const right = yield* api.SendMessage({
        chatId: start.chat.id,
        parentSlotId: start.entry.slotId,
        branch: true,
        content: "Right."
      })
      if (left._tag !== "Posted" || right._tag !== "Posted") throw new Error("synthetic messages queued")
      yield* api.NameFork({ forkId: left.chat.currentForkId as ForkId, name: "Alder" })
      yield* api.NameFork({ forkId: right.chat.currentForkId as ForkId, name: "Birch" })
      return { chat: start.chat, leftFork: left.chat.currentForkId! }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}?fork=${leftFork}&panel=notes`)
  const editor = page.getByRole("region", { name: "Note Weather" })
  await editor.getByRole("textbox", { name: "Text of Weather" }).click()
  await page.keyboard.type("Rain by evening.")
  const tab = page.getByRole("complementary", { name: "Chat panel" }).getByRole("tab", { name: "Notes", exact: true })
  await expect(editor.locator('[data-save-state="unsaved"]')).toBeVisible()
  await expect(tab.locator("[data-unsaved-dot]")).toBeVisible()

  await switchTo(page, "Birch", "Next branch")
  await expect(tab).toBeVisible()
  await expect(tab).not.toHaveAttribute("data-unsaved")
  await expect(page.locator("[data-unsaved-dot]")).toHaveCount(0)

  await switchTo(page, "Alder", "Previous branch")
  await expect(tab.locator("[data-unsaved-dot]")).toBeVisible()
  await expect(editor.getByRole("textbox", { name: "Text of Weather" })).toContainText("Rain by evening.")
})

test("a preset note link opened in a browser tab keeps the branch draft", async ({ page, context }) => {
  const { chatId, forkId, slotId, refId } = await admin((api) =>
    Effect.gen(function* () {
      const preset = yield* api.CreatePreset({ label: "Branch note preset" })
      yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
      const card = yield* api.CreateCard({ label: "Branch Wren", name: "Wren" })
      const start = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Before the fork.", speakerEntityId: null }
      })
      const chatId = start.chat.id
      yield* api.SendMessage({
        chatId,
        parentSlotId: start.entry.slotId,
        branch: false,
        content: "On the original branch."
      })
      const fork = yield* api.SendMessage({
        chatId,
        parentSlotId: start.entry.slotId,
        branch: true,
        content: "On the fork."
      })
      if (fork._tag !== "Posted") throw new Error("synthetic message queued")
      const forkId = fork.chat.currentForkId!
      const slotId = fork.entry.slotId
      const note = yield* api.CreateChatNote({ chatId, forkId, title: "Fog", content: "Saved forecast." })
      yield* api.ChangeCast({ chatId, slotId, forkId, change: { _tag: "Note", entityId: note.entityId, active: true } })
      return { chatId, forkId, slotId, refId: note.id }
    })
  )
  expect(forkId).not.toBe(chatId)
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}?fork=${forkId}&panel=notes`)
  const text = page.getByRole("textbox", { name: "Text of Fog" })
  await text.press("ControlOrMeta+a")
  await page.keyboard.insertText("Branch draft.")
  await expect
    .poll(
      async () => (await admin((api) => api.OpenEditor({ refId, chatNote: { chatId, forkId, slotId } }))).drafts.length
    )
    .toBeGreaterThan(0)

  const preset = await openPanel(page, "Prompt preset")
  const link = preset.getByRole("link", { name: "Fog", exact: true })
  const noteText = (tab: Page) =>
    tab.getByRole("region", { name: "Note editor", exact: true }).getByRole("textbox", { name: "Text of Fog" })
  for (const click of [{ modifiers: ["Control" as const] }, { button: "middle" as const }]) {
    const url = await urlOpenedInNewTab(page, () => link.click(click))
    const other = await context.newPage()
    await other.goto(url)
    await expect(noteText(other)).toHaveText("Branch draft.")
    await other.close()
  }
  const href = new URL((await link.getAttribute("href"))!, page.url())
  expect(href.searchParams.get("fork")).toBe(forkId)
  await link.click()
  await expect(noteText(page)).toHaveText("Branch draft.")
})
