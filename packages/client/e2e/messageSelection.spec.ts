// Deleting several messages together (job msgactions1; ST-COMPARISON item 24): "Select messages"
// on a message's menu ticks it and shows a tick on every message; Select range (or Shift-click)
// ticks a run; the bar's Delete… says what goes and what stays, then one toast's Undo puts them
// all back. Cancel ends it with nothing deleted. At 1440 and 390 px, light and dark, with the
// layout audit on the chat with the bar shown. Synthetic messages only; no provider.
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { join } from "node:path"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

const COUNT = 30
const line = (i: number) => `Synthetic harbor line ${i}.`

/** A chat of `COUNT` messages of the user's, one after another. */
const seed = (title: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      let parent: SlotId | null = null
      for (let i = 1; i <= COUNT; i++) {
        const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: false, content: line(i) })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        parent = sent.entry.slotId as SlotId
      }
      return chat.id as ChatId
    })
  )

const message = (page: Page, i: number) =>
  page.getByRole("article", { name: "Your message", exact: true }).filter({ hasText: line(i) })
const tick = (row: Locator) => row.getByRole("checkbox", { name: "Select this message", exact: true })
const bar = (page: Page) => page.getByRole("region", { name: "Selected messages" })

const showLastAboveBar = async (row: Locator, selected: Locator) => {
  await row.scrollIntoViewIfNeeded()
  await expect(row).toBeInViewport({ ratio: 1 })
  await expect
    .poll(async () => {
      const messageBox = await row.boundingBox()
      const barBox = await selected.boundingBox()
      return messageBox && barBox ? messageBox.y + messageBox.height - barBox.y : Infinity
    })
    .toBeLessThanOrEqual(0)
}

for (const width of [1440, 390] as const)
  for (const theme of ["light", "dark"] as const)
    test(`select a range, delete it, Undo (${width}px, ${theme})`, async ({ browser }, info) => {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        colorScheme: theme,
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {})
      })
      const page = await context.newPage()
      const chatId = await seed(`Harbor ${width} ${theme}`)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(message(page, COUNT)).toBeVisible()
      // No ticks until selecting starts.
      await expect(page.getByRole("checkbox", { name: "Select this message" })).toHaveCount(0)

      await messageMenu(message(page, COUNT), "Select messages")
      await expect(bar(page)).toContainText("1 message selected")
      await expect(tick(message(page, COUNT))).toBeChecked()
      await expect(tick(message(page, COUNT - 1))).not.toBeChecked()

      // Select range, then the run's other end: every message between is ticked.
      await bar(page).getByRole("button", { name: "Select range" }).click()
      await tick(message(page, COUNT - 5)).click()
      await expect(bar(page)).toContainText("6 messages selected")
      // The list keeps only the rows near the view: those shown say so.
      await expect(tick(message(page, COUNT - 5))).toBeChecked()
      await expect(tick(message(page, COUNT - 4))).toBeChecked()
      // Unticking one leaves the rest.
      await tick(message(page, COUNT - 4)).click()
      await expect(bar(page)).toContainText("5 messages selected")
      await tick(message(page, COUNT - 4)).click()
      await expect(bar(page)).toContainText("6 messages selected")

      await page.getByTestId("messages").evaluate((list) => {
        list.scrollTop = list.scrollHeight
      })
      await showLastAboveBar(message(page, COUNT), bar(page))
      await expectLayout(page, info, `selection ${width} ${theme}`)
      await shoot(page, `selection-bar-${width}-${theme}`)

      await bar(page).getByRole("button", { name: "Delete…" }).click()
      const dialog = page.getByRole("alertdialog")
      await expect(dialog).toContainText("Delete 6 messages?")
      await expect(dialog).toContainText("They move to the bin.")
      await expect(dialog).toContainText("Only this branch changes")
      await expect(dialog).toContainText("Undo, or the bin, puts them back.")
      await expectLayout(page, info, `selection confirmation ${width} ${theme}`)
      await shoot(page, `selection-confirm-${width}-${theme}`)
      await dialog.getByRole("button", { name: "Delete 6 messages" }).click()

      const toast = page.getByText("6 messages moved to the bin.")
      await expect(toast).toBeVisible()
      await expect(bar(page)).toHaveCount(0)
      for (let i = COUNT - 5; i <= COUNT; i++) await expect(message(page, i)).toHaveCount(0)
      await expect(message(page, COUNT - 6)).toBeVisible()
      await expect(page.getByRole("checkbox", { name: "Select this message" })).toHaveCount(0)
      await expect
        .poll(async () => {
          const path = await admin((api) =>
            api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
          )
          return path.entries.length
        })
        .toBe(COUNT - 6)
      await shoot(page, `selection-deleted-${width}-${theme}`)

      // One Undo puts them all back, in their places.
      await page.getByRole("button", { name: "Undo", exact: true }).click()
      await expect(message(page, COUNT - 5)).toBeVisible()
      await expect
        .poll(async () => {
          const path = await admin((api) =>
            api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
          )
          return path.entries.map((e) => e.version.content)
        })
        .toEqual(Array.from({ length: COUNT }, (_, i) => line(i + 1)))
      await context.close()
    })

test("Cancel and Esc end selecting with nothing deleted; Shift-click ticks a run", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const chatId = await seed("Harbor cancel")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(message(page, COUNT)).toBeVisible()
  await messageMenu(message(page, COUNT - 1), "Select messages")
  await tick(message(page, COUNT - 3)).click({ modifiers: ["Shift"] })
  await expect(bar(page)).toContainText("3 messages selected")
  await bar(page).getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(bar(page)).toHaveCount(0)
  await expect(page.getByRole("checkbox", { name: "Select this message" })).toHaveCount(0)
  // Cancelling changes row sizes; bring the last row back into the virtual window.
  await page.getByTestId("messages").evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })
  await expect(message(page, COUNT)).toBeVisible()
  await messageMenu(message(page, COUNT), "Select messages")
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(bar(page)).toHaveCount(0)
  const path = await admin((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }))
  expect(path.entries.map((entry) => entry.version.content)).toEqual(
    Array.from({ length: COUNT }, (_, i) => line(i + 1))
  )
})

test("selection is tab-local, clears on external deletion, and ticks work with the keyboard", async ({
  page,
  context
}) => {
  const chatId = await seed("Harbor concurrent selection")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(message(page, COUNT)).toBeVisible()
  await messageMenu(message(page, COUNT), "Select messages")
  const other = await context.newPage()
  await other.goto(`${server().url}/chats/${chatId}`)
  await expect(message(other, COUNT)).toBeVisible()
  await expect(bar(other)).toHaveCount(0)
  await tick(message(page, COUNT - 1)).focus()
  await page.keyboard.press("Space")
  await expect(tick(message(page, COUNT - 1))).toBeChecked()
  await expect(bar(page)).toContainText("2 messages selected")
  await bar(page).getByRole("button", { name: "Delete…" }).click()
  await admin((api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      yield* api.DeleteMessages({ forkId: path.forkId!, slotIds: [path.entries.at(-1)!.slotId] })
    })
  )
  await expect(bar(page)).toHaveCount(0)
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(message(other, COUNT)).toHaveCount(0)
  await other.close()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`side chat selection and confirmation (${width}px, ${theme})`, async ({ page }, info) => {
      const story = await seed(`Story beside selection ${width} ${theme}`)
      const workshop = await admin((api) => api.CreateWorkshop({ attachTo: story }))
      await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: workshop.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          yield* api.SendMessage({
            chatId: workshop.id,
            parentSlotId: path.entries.at(-1)?.slotId ?? null,
            branch: false,
            reply: false,
            content: "Synthetic side chat message."
          })
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${story}?panel=workshop&workshop=${workshop.id}`)
      const side = page.locator(`[data-side-chat="${workshop.id}"]`)
      const row = side.getByRole("article").filter({ hasText: "Synthetic side chat message." })
      await expect(row).toBeVisible()
      await messageMenu(row, "Select messages")
      const selected = side.getByRole("region", { name: "Selected messages" })
      await expect(selected).toContainText("1 message selected")
      await showLastAboveBar(row, selected)
      await expectLayout(page, info, `side selection ${width} ${theme}`)
      await shoot(page, `selection-side-${width}-${theme}`)
      await selected.getByRole("button", { name: "Delete…" }).click()
      await expectLayout(page, info, `side selection confirmation ${width} ${theme}`)
      await shoot(page, `selection-side-confirm-${width}-${theme}`)
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete message", exact: true }).click()
      await expect(row).toHaveCount(0)
      await page.getByRole("button", { name: "Undo", exact: true }).click()
      await expect(row).toBeVisible()
    })

// Hide from the model and Show to the model on the bar (job selecthide1): one action, one Undo,
// both offered when the selection mixes hidden and shown messages.
for (const width of [1440, 390] as const)
  for (const theme of ["light", "dark"] as const)
    test(`hide a range from the model, show it again, Undo (${width}px, ${theme})`, async ({ browser }, info) => {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        colorScheme: theme,
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {})
      })
      const page = await context.newPage()
      const chatId = await seed(`Harbor hide ${width} ${theme}`)
      const hiddenNow = () =>
        admin((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })).then((path) =>
          path.entries.filter((e) => e.contextExcluded).map((e) => e.version.content)
        )
      // The rows marked hidden (the list keeps those near the view; these are the last few).
      const hiddenRows = () => page.locator('article[data-hidden="true"]')
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(message(page, COUNT)).toBeVisible()

      await messageMenu(message(page, COUNT), "Select messages")
      await bar(page).getByRole("button", { name: "Select range" }).click()
      await tick(message(page, COUNT - 3)).click()
      await expect(bar(page)).toContainText("4 messages selected")
      // All shown: only Hide is offered.
      await expect(bar(page).getByRole("button", { name: "Show to the model" })).toHaveCount(0)
      await bar(page).getByRole("button", { name: "Hide from the model" }).click()
      await expect(page.getByText("4 messages hidden from the model.")).toBeVisible()
      await expect(bar(page)).toHaveCount(0)
      // Ticking line 27 scrolled it into view, so the list no longer follows its end; the rows
      // grow by their Hidden note and the last one can leave the mounted window. Back to the end.
      await expect(async () => {
        await page.getByTestId("messages").evaluate((list) => {
          list.scrollTop = list.scrollHeight
        })
        await expect(hiddenRows()).toContainText([COUNT - 3, COUNT - 2, COUNT - 1, COUNT].map(line), {
          timeout: 1_000
        })
      }).toPass()
      await expect(message(page, COUNT)).toHaveAttribute("data-hidden", "true")

      // One Undo shows them all again.
      await page.getByRole("button", { name: "Undo", exact: true }).click()
      await expect(hiddenRows()).toHaveCount(0)
      await expect(message(page, COUNT)).not.toHaveAttribute("data-hidden")

      // A mix of hidden and shown offers both.
      // The message's own action (the login limit leaves no room for more API calls here).
      await messageMenu(message(page, COUNT - 1), "Hide from the model")
      await expect(message(page, COUNT - 1)).toHaveAttribute("data-hidden", "true")
      await page.getByTestId("messages").evaluate((list) => {
        list.scrollTop = list.scrollHeight
      })
      await messageMenu(message(page, COUNT), "Select messages")
      await tick(message(page, COUNT - 2)).click({ modifiers: ["Shift"] })
      await expect(bar(page)).toContainText("3 messages selected")
      await expect(bar(page).getByRole("button", { name: "Hide from the model" })).toBeVisible()
      await expect(bar(page).getByRole("button", { name: "Show to the model" })).toBeVisible()
      await page.getByTestId("messages").evaluate((list) => {
        list.scrollTop = list.scrollHeight
      })
      await showLastAboveBar(message(page, COUNT), bar(page))
      await expectLayout(page, info, `selection hide ${width} ${theme}`)
      await shoot(page, `selection-hide-${width}-${theme}`)
      await bar(page).getByRole("button", { name: "Show to the model" }).click()
      await expect(page.getByText("1 message shown to the model again.")).toBeVisible()
      await expect(hiddenRows()).toHaveCount(0)
      await page.getByRole("button", { name: "Undo", exact: true }).click()
      await expect(hiddenRows()).toContainText([line(COUNT - 1)])
      expect(await hiddenNow()).toEqual([line(COUNT - 1)])
      await context.close()
    })
