// Moving a message up or down in its branch (owner, 2026-11-16): Move up and Move down from a
// message's "More actions", the new order shown, Undo from the toast, the ends disabled with
// their reason, and a branch made before the move keeping its order. At 1440 and 390 pixels,
// light and dark. Every card and message here is made up.
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { loginCookie, withCookie, type Client as Api } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin })

let cookie = ""
const admin = <A>(use: (api: Api) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

const LINES = ["The lamp is lit.", "A ship rounds the point.", "The fog horn sounds."] as const

/** Mira and three messages; a branch made at the last one before anything moves. */
const harbor = (title: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const existing = (yield* api.ListCards()).find((card) => card.name === "Mira")
      const mira: EntityId = existing?.entityId ?? (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const chat = yield* api.CreateChat({ title })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: mira } })
      let parent: SlotId | null = null
      for (const content of LINES) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content,
          speakerEntityId: mira
        })
        if (sent._tag !== "Posted") return yield* Effect.die(new Error("queued"))
        parent = sent.entry.slotId
      }
      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
      const main = window.forkId!
      const before = (yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: parent })).fork.id
      return { chatId: chat.id as ChatId, main: main as ForkId, before: before as ForkId }
    })
  )

const textsIn = (chatId: ChatId, forkId: ForkId) =>
  admin((api) =>
    Effect.map(api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }), (window) =>
      window.entries.map((e) => e.version.content)
    )
  )

const messages = (page: Page) => page.locator("article[data-slot]")
const message = (page: Page, text: string) => messages(page).filter({ hasText: text })
const shown = (page: Page) =>
  messages(page).evaluateAll((rows) => rows.map((row) => row.querySelector(".markdown")?.textContent?.trim() ?? ""))

/** Opens the message's "More actions" menu. */
const openMenu = async (page: Page, text: string) => {
  const row = message(page, text)
  await showActions(row)
  await row.getByRole("button", { name: "More actions" }).click()
}

for (const [width, height, theme] of [
  [1440, 900, "light"],
  [390, 844, "dark"]
] as const) {
  test(`moves a message up and down in its branch, with Undo (${width}px, ${theme})`, async ({ page }, info) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
    const fixture = await harbor(`Harbor move ${width} ${theme}`)
    await page.goto(`${server().url}/chats/${fixture.chatId}?fork=${fixture.main}`)
    await expect(message(page, LINES[2])).toBeVisible()

    // The first message can't move up: shown disabled, with the reason.
    await openMenu(page, LINES[0])
    await expect(page.getByRole("menuitem", { name: /Move up/ })).toBeDisabled()
    await expect(page.getByRole("menuitem", { name: /Move down/ })).toBeEnabled()
    await expectLayout(page, info, `move-menu-${width}-${theme}`, { hovered: true })
    await page.keyboard.press("Escape")

    // Move up: the last message goes above the one before it, in this branch only.
    await openMenu(page, LINES[2])
    await page.getByRole("menuitem", { name: /Move up/ }).click()
    await expect.poll(() => shown(page)).toEqual([LINES[0], LINES[2], LINES[1]])
    const toast = page.getByText("Message moved up", { exact: true })
    await expect(toast).toBeVisible()
    expect(await textsIn(fixture.chatId, fixture.main)).toEqual([LINES[0], LINES[2], LINES[1]])
    expect(await textsIn(fixture.chatId, fixture.before)).toEqual([...LINES])
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await expect.poll(() => shown(page)).toEqual([...LINES])

    // Move down, then back up: the order is as it was.
    await openMenu(page, LINES[0])
    await page.getByRole("menuitem", { name: /Move down/ }).click()
    await expect.poll(() => shown(page)).toEqual([LINES[1], LINES[0], LINES[2]])
    await openMenu(page, LINES[0])
    await page.getByRole("menuitem", { name: /Move up/ }).click()
    await expect.poll(() => shown(page)).toEqual([...LINES])
    await expectLayout(page, info, `move-done-${width}-${theme}`)
  })
}
