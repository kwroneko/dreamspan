// A chat's own note's unsaved dot shows only on its branch (owner, 2026-11-24): on another branch
// the note can't be seen, so no dot points at it; back on its branch the draft and its dot return.
// Synthetic text only.
import { Effect } from "effect"
import { expect, type Page, test } from "@playwright/test"
import type { ForkId } from "@dreamspan/shared/chat.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const switchTo = async (page: Page, name: string) => {
  await page.getByRole("button", { name: /^Branch:.*switch branch$/ }).click()
  const dialog = page.getByRole("dialog", { name: "Branches of this chat" })
  await dialog
    .getByRole("list", { name: "Branches" })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click()
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

  await switchTo(page, "Birch")
  await expect(tab).toBeVisible()
  await expect(tab).not.toHaveAttribute("data-unsaved")
  await expect(page.locator("[data-unsaved-dot]")).toHaveCount(0)

  await switchTo(page, "Alder")
  await expect(tab.locator("[data-unsaved-dot]")).toBeVisible()
  await expect(editor.getByRole("textbox", { name: "Text of Weather" })).toContainText("Rain by evening.")
})
