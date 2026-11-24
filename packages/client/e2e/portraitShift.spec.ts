// A chat row's count tile keeps one width, loading or loaded, whatever the count (portraitshift1):
// a pending row reserves the tile before its cast is known, and a large cast arriving must not
// push the title sideways. Synthetic chats of 2, 5, 12 and 120 characters, made cold as an
// import leaves them (their stored branch summaries removed, the server restarted), beside a
// cold chat whose parts SHELL_PASS_PAUSE_MS holds, so their rows stay pending meanwhile.
// With PORTRAIT_SHIFT_SHOTS set, each row's screenshot goes there.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const PAUSE_MS = 15_000
const server = serverPerFile({ ...withAdmin, SHELL_PASS_PAUSE_MS: String(PAUSE_MS) })
test.use({ locale: "en-GB", timezoneId: "UTC" })

const SIZES = [2, 5, 12, 120] as const

/** A chat of a few messages and branches: the pass reads its parts first, held by the pause. */
const bigChat = (title: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      const main = chat.currentForkId as ForkId
      let parent: SlotId | null = null
      const slots: Array<SlotId> = []
      for (let n = 0; n < 4; n++) {
        const sent: { readonly _tag: string; readonly entry?: { readonly slotId: SlotId } } = yield* api.SendMessage({
          chatId: chat.id,
          forkId: main,
          parentSlotId: parent,
          branch: false,
          content: `Main line ${n}.`
        })
        if (sent._tag !== "Posted" || sent.entry === undefined) throw new Error("unexpected queued fixture message")
        parent = sent.entry.slotId
        slots.push(parent)
      }
      for (let n = 0; n < 3; n++) {
        const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: slots[n]! })
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          forkId: fork.id,
          parentSlotId: slots[n]!,
          branch: false,
          content: `Only in branch ${n}.`
        })
        if (sent._tag !== "Posted") throw new Error("unexpected queued fixture message")
      }
      return chat
    })
  )

/** One chat per cast size, each named, so its title shows while it is pending. */
const castChats = (prefix: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards: Array<EntityId> = []
      for (let n = 0; n < Math.max(...SIZES); n++)
        cards.push((yield* api.CreateCard({ label: `Synthetic ${n + 1}`, name: `Synthetic ${n + 1}` })).entityId)
      const chats: Record<number, ChatId> = {}
      for (const size of SIZES) {
        const { chat } = yield* api.StartChat({
          cards: cards.slice(0, size),
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: `A synthetic gathering of ${size}.`, speakerEntityId: null }
        })
        yield* api.RenameChat({ chatId: chat.id, name: `${prefix} ${size}` })
        chats[size] = chat.id
      }
      return chats
    })
  )

const shot = (row: Locator, name: string) => {
  const dir = process.env.PORTRAIT_SHIFT_SHOTS
  if (!dir) return Promise.resolve()
  mkdirSync(dir, { recursive: true })
  return row.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" }).then(() => undefined)
}

/** Each row's title and count tile, by cast size. */
const measure = (row: (size: number) => Locator) =>
  Promise.all(
    SIZES.map((size) =>
      row(size).evaluate((element) => {
        const title = element.querySelector("[data-chat-title]")!.getBoundingClientRect()
        const tile = element.querySelector<HTMLElement>("[data-row-portraits] > [data-portrait-overflow]")
        const box = tile?.getBoundingClientRect()
        const portraits = element.querySelector("[data-row-portraits]")!.getBoundingClientRect()
        return {
          beside: portraits.right <= title.left,
          titleLeft: Math.round(title.left * 10) / 10,
          titleTop: Math.round(title.top * 10) / 10,
          tileWidth: box ? Math.round(box.width * 10) / 10 : null,
          tileHeight: box ? Math.round(box.height * 10) / 10 : null
        }
      })
    )
  )

const openSidebar = async (page: Page, width: number) => {
  if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
  else {
    // Wide enough that the portraits sit beside the title, not above it.
    await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus()
    await page.keyboard.press("End")
  }
  return width === 390
    ? page.locator(".fixed.inset-0")
    : page.getByRole("complementary", { name: "Sidebar", exact: true })
}

for (const width of [1340, 1920, 390])
  test(`a chat row's title stays put as a large cast arrives: ${width} dark`, async ({ page }, info) => {
    test.setTimeout(240_000)
    const big = await bigChat(`Harbor ${width}`)
    const chats = await castChats(`Gathering ${width}`)
    await server().pause()
    await Effect.runPromise(
      fixtureSql(server().dataDir, [
        {
          sql: `DELETE FROM fork_summaries WHERE chat_id IN (${[big.id, ...Object.values(chats)].map(() => "?").join(", ")})`,
          params: [big.id, ...Object.values(chats)]
        }
      ])
    )
    await server().restart()
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${big.id}`)
    await expect(page.getByRole("main").getByText("Only in branch 2.")).toBeVisible()
    const list = (await openSidebar(page, width)).locator("[data-shell-list]")
    const row = (size: number) =>
      list.locator("[data-fork-row]").filter({ has: page.locator(`[data-chat-id="${chats[size]}"]`) })
    for (const size of SIZES) await expect(row(size)).toHaveAttribute("data-fork-pending", "true")
    const before = await measure(row)
    for (const size of SIZES) await expect(row(size)).toHaveAttribute("data-fork-pending", "true")
    await expectLayout(page, info, `cast rows mid-pass ${width} dark`)
    await expect(list.locator("[data-fork-pending]")).toHaveCount(0, { timeout: PAUSE_MS * 6 })
    await expect(row(12).locator("[data-row-portraits] [data-portrait]")).toHaveCount(2)
    const after = await measure(row)
    // Arriving moves no title, and the tile is one width and the portraits' height in every row.
    if (width !== 390) for (const m of [...before, ...after]) expect(m.beside).toBe(true)
    expect(after.map((m) => [m.titleLeft, m.titleTop])).toEqual(before.map((m) => [m.titleLeft, m.titleTop]))
    expect(new Set(after.map((m) => m.titleLeft)).size).toBe(1)
    await expect(row(5).locator("[data-portrait-overflow]")).toHaveText("+3")
    await expect(row(12).locator("[data-portrait-overflow]")).toHaveText("+10")
    await expect(row(120).locator("[data-portrait-overflow]")).toHaveText("99+")
    expect(new Set([...before, ...after].map((m) => m.tileWidth)).size).toBe(1)
    const portrait = (await row(12).locator("[data-row-portraits] [data-portrait]").first().boundingBox())!
    for (const m of after) expect(m.tileHeight).toBe(Math.round(portrait.height * 10) / 10)
    // The count fits its tile: no digit is clipped.
    for (const size of [5, 12, 120])
      expect(
        await row(size)
          .locator("[data-portrait-overflow]")
          .evaluate((tile) => tile.scrollWidth <= tile.clientWidth)
      ).toBe(true)
    await expectLayout(page, info, `cast rows complete ${width} dark`)
    for (const size of SIZES) await shot(row(size), `row-${size}-${width}-dark`)
  })
