// A cold chat's branch list fills in while the shell's first pass reads it (perfshell3): every
// branch is listed at once, a branch not read yet shows its name if it has one and quiet bars
// for the rest, a progress line says how far the pass is and goes when it is done, and nothing
// moves as the rows fill in. Synthetic chats made through the API, then made cold as an import
// leaves them: the server stopped, the chat's stored branch summaries removed, the server started
// again. SHELL_PASS_PAUSE_MS holds the pass between its parts (the open branch alone first, then
// the rest), so each test sees it half done. With BRANCH_PROGRESS_SHOTS set, screenshots go there.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { portraitPng } from "./support/portrait.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const PAUSE_MS = 20_000
const server = serverPerFile({ ...withAdmin, SHELL_PASS_PAUSE_MS: String(PAUSE_MS) })
test.use({ locale: "en-GB", timezoneId: "UTC" })

const BRANCHES = 14

/** A chat of twelve messages and `BRANCHES` branches off them, each with a message of its own; one named. */
const coldChat = (title: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      const added = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const main = chat.currentForkId as ForkId
      const slots: Array<SlotId> = []
      let parent: SlotId | null = null
      for (let n = 0; n < 12; n++) {
        const sent: { readonly _tag: string; readonly entry?: { readonly slotId: SlotId } } = yield* api.SendMessage({
          chatId: chat.id,
          forkId: main,
          parentSlotId: parent,
          branch: false,
          content: `Main line ${n}.`
        })
        if (sent._tag !== "Posted" || sent.entry === undefined) throw new Error("unexpected queued fixture message")
        const slot = sent.entry.slotId
        parent = slot
        slots.push(slot)
      }
      const forks: Array<ForkId> = []
      for (let n = 0; n < BRANCHES; n++) {
        const at = slots[n % slots.length]!
        const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: at })
        forks.push(fork.id)
        if (n === 3)
          yield* api.ChangeCast({
            chatId: chat.id,
            forkId: fork.id,
            slotId: at,
            change: { _tag: "Join", entityId: added.entityId }
          })
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          forkId: fork.id,
          parentSlotId: at,
          branch: false,
          content: `Only in branch ${n}.`
        })
        if (sent._tag !== "Posted") throw new Error("unexpected queued fixture message")
      }
      yield* api.NameFork({ forkId: forks[3]!, name: "Lighthouse" })
      // Back on the main line: the chat opens there.
      const last = yield* api.SendMessage({
        chatId: chat.id,
        forkId: main,
        parentSlotId: parent,
        branch: false,
        content: "Main line goes on."
      })
      if (last._tag !== "Posted") throw new Error("unexpected queued fixture message")
      return { chat, main, forks }
    })
  ).then(async (fixture) => {
    await server().pause()
    await Effect.runPromise(
      fixtureSql(server().dataDir, [{ sql: "DELETE FROM fork_summaries WHERE chat_id = ?", params: [fixture.chat.id] }])
    )
    await server().restart()
    return fixture
  })

const shots = (page: Page, name: string) => {
  const dir = process.env.BRANCH_PROGRESS_SHOTS
  if (!dir) return Promise.resolve()
  mkdirSync(dir, { recursive: true })
  return page.screenshot({ path: join(dir, `${name}.png`) }).then(() => undefined)
}

/** Each row's box, by fork: what must not move as the rows fill in. */
const boxes = (rows: Locator) =>
  rows.evaluateAll((elements) =>
    Object.fromEntries(
      elements.map((row) => {
        const box = row.getBoundingClientRect()
        const id = row.querySelector<HTMLElement>("[data-fork-id]")?.dataset.forkId ?? ""
        const text = row.querySelector("[data-row-text]")!.getBoundingClientRect()
        return [
          id,
          [
            Math.round(box.top),
            Math.round(box.height),
            Math.round(box.width),
            Math.round(text.top),
            Math.round(text.left)
          ]
        ]
      })
    )
  )

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a cold chat's branches fill in as the pass reads them: ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(180_000)
      const fixture = await coldChat(`Harbor ${width} ${theme}`)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chat.id}?forks=${fixture.chat.id}`)
      await expect(page.getByRole("main").getByText("Main line goes on.")).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      const panel =
        width === 390
          ? page.locator(".fixed.inset-0")
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      const list = panel.locator("[data-shell-list]")
      const rows = list.locator("[data-fork-row]")
      // Every branch at once, most not read yet, and how far the pass is.
      await expect(rows).toHaveCount(BRANCHES + 1)
      const progress = panel.getByRole("status").filter({ hasText: /^Loading branches… \d+ of 15$/ })
      await expect(progress).toBeVisible()
      await expect(list.locator("[data-fork-pending]")).not.toHaveCount(0)
      // A pending branch says its name when it has one, and nothing it doesn't know.
      const named = list.locator(`[data-fork-row]:has([data-fork-id="${fixture.forks[3]}"])`)
      await expect(named).toHaveAttribute("data-fork-pending", "true")
      await expect(named).toContainText("Lighthouse")
      await expect(named).not.toContainText("No messages yet")
      await expect(named).not.toContainText("Last message")
      // The branch the chat opens on is read first.
      const current = list.locator(`[data-fork-row]:has([data-fork-id="${fixture.main}"])`)
      await expect(current).not.toHaveAttribute("data-fork-pending")
      await expect(current).toContainText("Main line goes on.")
      const search = panel.getByRole("textbox", { name: "Find a branch", exact: true })
      await search.fill("Lighthouse")
      await expect(rows).toHaveCount(1)
      await expect(panel.getByRole("note")).toContainText("found by name only")
      await search.fill("Only in branch 3.")
      await expect(rows).toHaveCount(0)
      await search.fill("")
      await expect(rows).toHaveCount(BRANCHES + 1)
      await expectLayout(page, info, `branch progress mid-pass ${width} ${theme}`)
      await shots(page, `mid-pass-${width}-${theme}`)
      const before = await boxes(rows)
      // Filled in: the line goes, every row is read, and none moved.
      await expect(progress).toHaveCount(0, { timeout: PAUSE_MS * 3 })
      await expect(list.locator("[data-fork-pending]")).toHaveCount(0)
      await expect(named).toContainText("Only in branch 3.")
      expect(await boxes(rows)).toEqual(before)
      await expectLayout(page, info, `branch progress complete ${width} ${theme}`)
      await shots(page, `complete-${width}-${theme}`)
    })

test("a branch opens while the pass reads it, and a second tab fills in too", async ({ page, context }) => {
  test.setTimeout(240_000)
  const fixture = await coldChat("Harbor two tabs")
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const url = `${server().url}/chats/${fixture.chat.id}?forks=${fixture.chat.id}`
  await page.goto(url)
  const panel = page.getByRole("complementary", { name: "Sidebar", exact: true })
  const progress = panel.getByRole("status").filter({ hasText: /^Loading branches…/ })
  await expect(progress).toBeVisible()
  // A pending row opens its branch: the middle shows it, the row is marked as shown.
  const target = fixture.forks[7]!
  const row = panel.locator(`[data-fork-row]:has([data-fork-id="${target}"])`)
  await expect(row).toHaveAttribute("data-fork-pending", "true")
  await row.locator(`[data-fork-id="${target}"]`).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(target)
  await expect(page.getByRole("main").getByText("Only in branch 7.")).toBeVisible()
  await expect(row.locator(`[data-fork-id="${target}"]`)).toHaveAttribute("aria-current", "page")
  // A second tab of the same chat, opened mid-pass, lists every branch and fills in as well.
  const second = await context.newPage()
  await second.setViewportSize({ width: 1440, height: 900 })
  await second.goto(url)
  const secondPanel = second.getByRole("complementary", { name: "Sidebar", exact: true })
  await expect(secondPanel.locator("[data-shell-list] [data-fork-row]")).toHaveCount(BRANCHES + 1)
  // Mutations while the pass is paused reach both subscriptions, without reviving old rows.
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.NameFork({ forkId: target, name: "Renamed while loading" })
      yield* api.DeleteFork({ forkId: fixture.forks[0]! })
      yield* api.CreateFork({ chatId: fixture.chat.id, fromForkId: fixture.main, atSlotId: null })
    })
  )
  for (const p of [panel, secondPanel]) {
    await expect(p.locator(`[data-fork-row]:has([data-fork-id="${fixture.forks[0]}"])`)).toHaveCount(0)
    await expect(p.locator(`[data-fork-row]:has([data-fork-id="${target}"])`)).toContainText("Renamed while loading")
    await expect(p.locator("[data-shell-list] [data-fork-row]")).toHaveCount(BRANCHES + 1)
  }
  // Completed parts survive a process restart; both existing tabs reconnect mid-pass.
  await server().pause()
  await server().restart()
  for (const p of [panel, secondPanel]) {
    await expect(p.getByRole("status").filter({ hasText: /^Loading branches…/ })).toHaveCount(0, {
      timeout: PAUSE_MS * 3
    })
    await expect(p.locator("[data-fork-pending]")).toHaveCount(0)
  }
  await expect(row).toContainText("Only in branch 7.")
  await second.close()
})

test("a chat deleted mid-pass disappears from both tabs", async ({ page, context }) => {
  test.setTimeout(180_000)
  const fixture = await coldChat("Deleted while loading")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${fixture.chat.id}?forks=${fixture.chat.id}`)
  const second = await context.newPage()
  await second.goto(page.url())
  for (const p of [page, second]) {
    await expect(p.locator("[data-shell-list] [data-fork-pending]")).not.toHaveCount(0)
  }
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.DeleteChat({ chatId: fixture.chat.id }))
  for (const p of [page, second]) {
    await expect(p.locator(`[data-shell-list] [data-chat-id="${fixture.chat.id}"]`)).toHaveCount(0)
    await expect(p.getByRole("status").filter({ hasText: /^Loading branches…/ })).toHaveCount(0)
  }
  await second.close()
})

/**
 * Small cold chats beside `coldChat`'s: one branch each, so the pass walks them only after its
 * parts (held by SHELL_PASS_PAUSE_MS), and their chat rows stay pending meanwhile. Two have a
 * picture of their own; one or three characters each.
 */
const coldChats = async (page: Page, title: string) => {
  const big = await coldChat(title)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const upload = async (variant: number) => {
    const response = await page.request.post(`${server().url}/chat/image`, {
      headers: { "content-type": "application/octet-stream" },
      data: portraitPng([], variant)
    })
    expect(response.status()).toBe(200)
    return ((await response.json()) as { mediaId: string }).mediaId
  }
  const pictures = [await upload(3), await upload(4)]
  const small = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards: Array<EntityId> = []
      for (const name of ["Mira Lantern", "Tomas Reed", "Ada Quill"])
        cards.push((yield* api.CreateCard({ label: name, name })).entityId)
      const start = (members: typeof cards, content: string) =>
        api.StartChat({
          cards: [...members],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content, speakerEntityId: null }
        })
      const one = (yield* start(cards.slice(0, 1), "A synthetic walk along the quay.")).chat.id
      const three = (yield* start(cards, "A synthetic evening at the lighthouse.")).chat.id
      const pictureOne = (yield* start(cards.slice(1, 2), "A synthetic morning at the market.")).chat.id
      const pictureThree = (yield* start(cards, "A synthetic night on the pier.")).chat.id
      yield* api.SetChatPicture({ chatId: pictureOne, mediaId: pictures[0]! })
      yield* api.SetChatPicture({ chatId: pictureThree, mediaId: pictures[1]! })
      return { one, three, pictureOne, pictureThree }
    })
  )
  await server().pause()
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: "DELETE FROM fork_summaries WHERE chat_id IN (?, ?, ?, ?, ?)",
        params: [big.chat.id, small.one, small.three, small.pictureOne, small.pictureThree]
      }
    ])
  )
  await server().restart()
  return { big, small }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a cold library's chat rows keep their boxes as they fill in, pictured or not: ${width} ${theme}`, async ({
      page
    }, info) => {
      test.setTimeout(240_000)
      const { big, small } = await coldChats(page, `Harbor chats ${width} ${theme}`)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${big.chat.id}`)
      await expect(page.getByRole("main").getByText("Main line goes on.")).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      const panel =
        width === 390
          ? page.locator(".fixed.inset-0")
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      const list = panel.locator("[data-shell-list]")
      const row = (chatId: string) =>
        list.locator("[data-fork-row]").filter({ has: page.locator(`[data-chat-id="${chatId}"]`) })
      for (const chatId of Object.values(small)) await expect(row(chatId)).toHaveAttribute("data-fork-pending", "true")
      // A pending chat's own picture shows at once, in its first box; nothing shows another's.
      for (const chatId of [small.pictureOne, small.pictureThree]) {
        await expect(row(chatId).locator("[data-row-portraits] img")).toHaveCount(1)
        await expect
          .poll(() =>
            row(chatId)
              .locator("[data-row-portraits] img")
              .evaluate((img: HTMLImageElement) => img.naturalWidth)
          )
          .toBeGreaterThan(0)
      }
      for (const chatId of [small.one, small.three])
        await expect(row(chatId).locator("[data-row-portraits] img")).toHaveCount(0)
      const shownPicture = (chatId: string) =>
        row(chatId)
          .locator("[data-row-portraits] img")
          .evaluate((img: HTMLImageElement) => new URL(img.src).searchParams.get("id"))
      const pictured = [await shownPicture(small.pictureOne), await shownPicture(small.pictureThree)]
      expect(new Set(pictured).size).toBe(2)
      const rows = list.locator("[data-fork-row]")
      await expectLayout(page, info, `chat rows mid-pass ${width} ${theme}`)
      await shots(page, `chats-mid-pass-${width}-${theme}`)
      const before = await boxes(rows)
      await expect(list.locator("[data-fork-pending]")).toHaveCount(0, { timeout: PAUSE_MS * 4 })
      // Filled in: faces where there is no picture, the same picture where there is, and no row moved.
      await expect(row(small.three).locator("[data-row-portraits] [data-portrait]")).toHaveCount(2)
      await expect(row(small.three).locator("[data-portrait-overflow]")).toContainText("+1")
      await expect(row(small.one).locator("[data-row-portraits] [data-portrait]")).toHaveCount(1)
      expect([await shownPicture(small.pictureOne), await shownPicture(small.pictureThree)]).toEqual(pictured)
      expect(await boxes(rows)).toEqual(before)
      await expectLayout(page, info, `chat rows complete ${width} ${theme}`)
      await shots(page, `chats-complete-${width}-${theme}`)
    })
