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
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { expectLayout } from "./support/layoutAudit.ts"
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
        return [id, [Math.round(box.top), Math.round(box.height), Math.round(box.width)]]
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
  for (const p of [panel, secondPanel]) {
    await expect(p.getByRole("status").filter({ hasText: /^Loading branches…/ })).toHaveCount(0, {
      timeout: PAUSE_MS * 3
    })
    await expect(p.locator("[data-fork-pending]")).toHaveCount(0)
  }
  await expect(row).toContainText("Only in branch 7.")
  await second.close()
})
