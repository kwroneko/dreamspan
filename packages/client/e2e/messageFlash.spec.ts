// A message jumped to flashes a couple of times, then is left unmarked (owner, 2026-11-06:
// "It should flash a couple times like when scrolling to a specific old message on a chat app,
// not remain highlighted."). Each way of jumping, at both widths and in both themes; with
// reduced motion a steady highlight fades instead; coming back to the jump doesn't flash again.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { clearFlashes, expectFlashedThenUnmarked, flashedSlots, flashes, recordFlashes } from "./support/flashes.ts"
import { messageMenu } from "./support/message.ts"
import { closePanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = process.env.MSGFLASH_SHOTS

/** A chat of 30 lines between the user, Karen (to line 21) and Sam, with a branch from line 5. */
const seed = (tag: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const karen = yield* api.CreateCard({ label: `Karen ${tag}`, name: `Karen ${tag}` })
      const sam = yield* api.CreateCard({ label: `Sam ${tag}`, name: `Sam ${tag}` })
      const chat = yield* api.CreateChat({ title: `Lighthouse ${tag}` })
      for (const card of [karen, sam])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      const slots: SlotId[] = []
      let parent: SlotId | null = null
      for (let i = 0; i < 30; i++) {
        const speaker = i % 2 === 0 ? null : i < 22 ? karen.entityId : sam.entityId
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content:
            i === 1
              ? "Line 1: the beacon turns once over the bay."
              : `Line ${i}: the tide comes in over the rocks, slow and grey, and the gulls wheel above the lamp room.`,
          ...(speaker ? { speakerEntityId: speaker } : {})
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        parent = sent.entry.slotId
        slots.push(sent.entry.slotId)
      }
      const side = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId!,
        atSlotId: slots[5]!,
        name: "Side road"
      })
      yield* api.SendMessage({
        chatId: chat.id,
        forkId: side.fork.id,
        parentSlotId: slots[5]!,
        branch: false,
        content: "The side road leads inland."
      })
      return { chatId: chat.id, slots, side: side.fork.id }
    })
  )

const article = (page: Page, slot: string) => page.locator(`article[data-slot="${slot}"]`)
const urlSlot = (page: Page) => new URL(page.url()).searchParams.get("slot")!

/** Nothing flashes for a while: about two flashes' time. */
const expectNoFlash = async (page: Page) => {
  await page.waitForTimeout(2500)
  expect(await flashedSlots(page)).toEqual([])
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: every jump flashes its message, then leaves it unmarked`, async ({ page }, info) => {
      test.setTimeout(120_000)
      const tag = `${width}${theme}`
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await recordFlashes(page)
      const data = await seed(tag)
      const chatUrl = `${server().url}/chats/${data.chatId}`
      const shot = async (name: string) => {
        if (!shots) return
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
      }

      // The character's tile opens its chat at the line it last spoke.
      await page.goto(server().url)
      await page
        .getByRole("main")
        .getByLabel("Characters", { exact: true })
        .getByRole("link", { name: new RegExp(`^Open Karen ${tag}`) })
        .click()
      await expect(page).toHaveURL(new RegExp(`slot=${data.slots[21]}`))
      const karenLast = article(page, data.slots[21]!)
      if (width === 390) {
        // A phone shows the card's panel over the chat first: the line flashes once it's closed.
        await expect(page.getByRole("dialog")).toBeVisible()
        await expect(karenLast).toBeAttached()
        await page.waitForTimeout(2000)
        expect(await flashedSlots(page)).toEqual([])
        await closePanel(page)
      }
      await expect(karenLast).toBeInViewport()
      if (shots) {
        await page.locator("article[data-flashing]").waitFor({ timeout: 3000 })
        await shot("character-flashing")
      }
      await expectFlashedThenUnmarked(page, karenLast)
      await shot("character-after")
      await expectLayout(page, info, `chat-after-flash-${width}-${theme}`, { scope: '[data-testid="messages"]' })

      // A reload, or back and forward to it, opens there again without flashing.
      await page.reload()
      await expect(karenLast).toBeVisible()
      await expectNoFlash(page)
      await page.goBack()
      await expect(page).not.toHaveURL(/\/chats\//)
      await page.goForward()
      await expect(karenLast).toBeVisible()
      await expectNoFlash(page)

      // A message link (Copy link's URL).
      await page.goto(`${chatUrl}?slot=${data.slots[3]}`)
      await expect(article(page, data.slots[3]!)).toBeInViewport()
      await expectFlashedThenUnmarked(page, article(page, data.slots[3]!))
      // Three flashes of the ring, as an added item's (ui/reveal.ts).
      expect(await flashes(page)).toEqual([{ slot: data.slots[3], reduced: false, iterations: [3] }])

      // A search match (History edits' Next).
      await page.goto(`${chatUrl}?panel=history`)
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("beacon")
      await expect(page.getByRole("status").filter({ hasText: "1 in messages" })).toBeVisible()
      await clearFlashes(page)
      await page.getByRole("button", { name: "Next", exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`slot=${data.slots[1]}`))
      await expect(article(page, data.slots[1]!)).toBeInViewport()
      await expectFlashedThenUnmarked(page, article(page, data.slots[1]!))

      // The branch menu's link to where a branch starts; again, from the same place, flashes again.
      await page.goto(`${chatUrl}?fork=${data.side}`)
      await expect(page.getByTestId("messages").getByText("The side road leads inland.")).toBeVisible()
      for (const times of [1, 2]) {
        await page.getByRole("button", { name: /switch branch/ }).click()
        await page.getByRole("button", { name: "Go to where this branch starts", exact: true }).click()
        await expect(page).toHaveURL(/[?&]slot=/)
        const start = article(page, urlSlot(page))
        await expect(start).toBeInViewport()
        await expectFlashedThenUnmarked(page, start, times)
      }

      // A message inserted flashes where it went.
      await messageMenu(article(page, urlSlot(page)), "Insert message below")
      await page.getByTestId("insert-editor").getByTestId("insert-text").fill("A gull lands on the rail.")
      await page.getByTestId("insert-editor").getByRole("button", { name: "Insert", exact: true }).click()
      const inserted = page.locator("article[data-slot]").filter({ hasText: "A gull lands on the rail." })
      await expect(inserted).toBeVisible()
      await expectFlashedThenUnmarked(page, inserted)
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: with reduced motion a jump's highlight fades once instead`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await recordFlashes(page)
      const data = await seed(`reduced${width}${theme}`)
      await page.goto(`${server().url}/chats/${data.chatId}?slot=${data.slots[4]}`)
      await expectFlashedThenUnmarked(page, article(page, data.slots[4]!))
      expect(await flashes(page)).toEqual([{ slot: data.slots[4], reduced: true, iterations: [1] }])
    })
