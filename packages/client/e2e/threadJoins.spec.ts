// Joining threads (spec/THREADS.md §7.1, TH5): ⋯ "Join threads…" opens the merge dialog in its
// thread mode with the other thread ticked and what it brings, Join writes one "Joined" row, the
// branch control's Threads section says "Joined at #N", and a thread with nothing new isn't
// offered again. Synthetic chats only.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "12" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/**
 * Ash (the user's) with Mira "At the Lantern" and Wren "At the docks", threads from #3: the docks
 * go on for #4 and #5, the Lantern for #4, which the user is in.
 */
const seed = (suffix: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: `Harbor ${suffix}` })
      const card = (name: string) => api.CreateCard({ label: `Synthetic ${name}`, name })
      const [mira, wren, ash] = yield* Effect.all([card("Mira"), card("Wren"), card("Ash")])
      for (const c of [mira, wren, ash])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: c.entityId } })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [ash.entityId as EntityId] }
      })
      const say = function* (forkId: ForkId, parent: SlotId | null, content: string, speaker: { entityId: string }) {
        const sent: {
          readonly _tag: string
          readonly entry?: { readonly slotId: SlotId; readonly rowVersion: number }
        } = yield* api.SendMessage({
          chatId: chat.id,
          forkId,
          parentSlotId: parent,
          branch: false,
          content,
          speakerEntityId: speaker.entityId as EntityId
        })
        if (sent._tag !== "Posted") throw new Error("Synthetic chat unexpectedly queued")
        return sent.entry!
      }
      const main = chat.currentForkId! as ForkId
      let at = yield* say(main, null, "The ferry docks at dusk.", ash)
      at = yield* say(main, at.slotId, "Mira shoulders her pack.", mira)
      at = yield* say(main, at.slotId, "Wren heads for the water; the others take rooms at the Lantern.", ash)
      const started = yield* api.StartThreads({
        chatId: chat.id,
        forkId: main,
        slotId: at.slotId,
        expectedRowVersion: at.rowVersion,
        threads: [
          { name: "At the Lantern", cast: [mira.entityId as EntityId], writesAs: null },
          { name: "At the docks", cast: [wren.entityId as EntityId], writesAs: null }
        ]
      })
      const docks = started.forkIds[1]!
      const first = yield* say(docks, at.slotId, "Wren counts the crates on the pier.", wren)
      yield* say(docks, first.slotId, "A lantern swings on the last boat.", wren)
      // Written last, so the chat opens on the Lantern.
      yield* say(main, at.slotId, "Mira asks the keeper for two rooms.", mira)
      return { chatId: chat.id as ChatId, lantern: main, docks }
    })
  )

const open = async (page: Page, path: string, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${path}`)
  await expect(page.getByTestId("composer")).toBeVisible()
}

const chatMenu = async (page: Page) => {
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  return page.getByRole("menu")
}
const joinDialog = (page: Page) => page.getByRole("dialog", { name: "Join threads" })

for (const [width, theme] of [
  [390, "light"],
  [1440, "dark"]
] as const)
  test(`the join dialog lays out at ${width} (${theme})`, async ({ page }, info) => {
    const { chatId } = await seed(`${width}`)
    await open(page, `/chats/${chatId}`, width, theme)
    await (await chatMenu(page)).getByRole("menuitem", { name: "Join threads…", exact: true }).click()
    const dialog = joinDialog(page)
    await expect(dialog.getByTestId("merge-relation")).toHaveText("Joins 2 messages since #3")
    await expectLayout(page, info, `join threads ${width} ${theme}`, { scope: '[role="dialog"]' })
  })

test("joining the docks into the Lantern: one Joined row, Joined at #5, not offered again", async ({ page }) => {
  const { chatId, lantern, docks } = await seed("join")
  await open(page, `/chats/${chatId}`, 1280, "light")

  await (await chatMenu(page)).getByRole("menuitem", { name: "Join threads…", exact: true }).click()
  const dialog = joinDialog(page)
  // The one other thread is ticked already, with what it brings.
  const docksBox = dialog.getByRole("checkbox", { name: "At the docks" })
  await expect(docksBox).toBeChecked()
  await expect(dialog.locator("[data-join-thread]")).toContainText("2 messages since #3")
  await expect(dialog.getByTestId("merge-relation")).toHaveText("Joins 2 messages since #3")
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("At the docks")
  // How the characters see it (one shared context): together by default; separately, each reads its own.
  const view = dialog.getByRole("radiogroup", { name: "How the characters see it" })
  const together = view.getByRole("radio", { name: /^Everyone reads both threads/ })
  await expect(together).toBeChecked()
  await view.getByRole("radio", { name: /^Each character reads only its own thread/ }).click()
  await dialog.getByText("What the model reads").click()
  const reads = dialog.getByTestId("merge-section")
  const reader = dialog.getByRole("combobox", { name: "For" })
  await reader.click()
  await page.getByRole("option", { name: /^Mira/ }).click()
  await expect(reads).toContainText("Mira wasn't there")
  await reader.click()
  await page.getByRole("option", { name: /^Wren/ }).click()
  await expect(reads).toContainText("A lantern swings on the last boat.")
  await together.click()
  await expect(reader).toHaveCount(0)
  await expect(dialog.getByTestId("merge-section")).toContainText("A lantern swings on the last boat.")
  await dialog.getByRole("button", { name: "Join", exact: true }).click()
  await expect(page.getByText("Joined “At the docks”", { exact: true })).toBeVisible()

  // The timeline's row, worded as a join, with a link to the thread.
  const row = page.getByRole("button", { name: "Joined “At the docks” · 2 messages", exact: true })
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId("messages").getByText("Wren counts the crates on the pier.")).toBeVisible()

  // The branch control's Threads section: the docks were joined here at #5.
  await page.getByRole("button", { name: /^Thread: At the Lantern,/ }).click()
  const menu = page.getByRole("dialog", { name: "Branches of this chat" })
  await expect(menu.locator('[data-thread-row="1"]')).toContainText("Joined at #5")
  await page.keyboard.press("Escape")

  // Nothing new in the docks: not offered again, nor to send to.
  const actions = await chatMenu(page)
  await expect(actions.getByRole("menuitem", { name: "Start parallel threads…", exact: true })).toBeVisible()
  await expect(actions.getByRole("menuitem", { name: "Join threads…", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  const stored = await admin((api) => api.ThreadsOf({ chatId, forkId: lantern }))
  expect(stored[0]!.threads[1]).toMatchObject({ openForkId: docks, joined: { number: 5, upToDate: true } })
})
