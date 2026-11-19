// The chat's Messages and Summaries tabs (owner, 2026-11-18, DESIGN §10.1): a row of two tabs
// hanging from the messages above them, at the boundary and above the first message, only when
// summaries exist. Arrow keys move between them; the layout audit runs on the chat. Screenshots
// go to SCREENSHOT_DIR when set.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { condensed, level1 } from "./support/summaries.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie = ""
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`Messages and Summaries tabs at ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      const chat = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Shots ${width} ${theme}` })
          let parent: SlotId | null = null
          for (let n = 1; n <= 8; n++) {
            const sent: SendResult = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              content: `Original message ${n}, a line of synthetic harbour talk.`
            })
            if (sent._tag !== "Posted") return yield* Effect.die("queued")
            parent = sent.entry.slotId
          }
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
          return { id: chat.id, entries: path.entries }
        })
      )
      const a = await level1(server().dataDir, chat.id, chat.entries.slice(0, 2), "First pair of original messages.")
      const b = await level1(server().dataDir, chat.id, chat.entries.slice(2, 4), "Second pair of original messages.")
      await condensed(server().dataDir, chat.id, [a, b], "Condensed first four messages.")
      await level1(server().dataDir, chat.id, chat.entries.slice(4, 6), "The fifth and sixth messages.")
      // Each test starts from Messages: a flip in the one before set the account default.
      await admin((api) => api.SetDisplayPrefs({ prefs: { timeline: "originals" } }))
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[6]!.slotId}`)
      await expect(page.getByTestId("lcm-boundary")).toBeVisible()
      const dir = process.env.SCREENSHOT_DIR
      const shoot = async (name: string) => {
        if (!dir) return
        mkdirSync(dir, { recursive: true })
        await page.screenshot({ path: join(dir, `${name}-${width}-${theme}.png`) })
      }
      const messages = page.getByTestId("messages")
      const row = (at: "start" | "boundary") => messages.locator(`[data-testid="summary-tabs"][data-at="${at}"]`)
      const tab = (at: "start" | "boundary", name: "Messages" | "Summaries") =>
        row(at).getByRole("tab", { name, exact: true })
      // No switch any more: a row of two tabs, Messages chosen.
      await expect(messages.getByRole("switch", { name: "Summaries in chat" })).toHaveCount(0)
      await row("boundary").scrollIntoViewIfNeeded()
      await expect(tab("boundary", "Messages")).toHaveAttribute("aria-selected", "true")
      await expect(tab("boundary", "Summaries")).toHaveAttribute("aria-selected", "false")
      // Hanging from the line above: the tabs start at the row's top edge, their marker on top.
      const hang = await row("boundary")
        .getByRole("tablist")
        .evaluate((list) => {
          const box = list.getBoundingClientRect()
          const chosen = list.querySelector("[data-active]")!
          const style = getComputedStyle(chosen)
          return {
            line: getComputedStyle(list).borderTopWidth,
            gap: chosen.getBoundingClientRect().top - box.top,
            marker: style.borderTopWidth,
            under: style.borderBottomWidth,
            width: box.width
          }
        })
      expect(hang.line).toBe("1px")
      expect(Math.abs(hang.gap)).toBeLessThanOrEqual(1)
      expect(hang.marker).toBe("2px")
      expect(hang.under).toBe("0px")
      // The line runs the width of the messages, as the divider's rule did.
      const article = (await messages.locator("article").first().boundingBox())!
      expect(hang.width).toBeGreaterThanOrEqual(article.width - 2)
      await page.mouse.move(0, 0)
      await shoot("divider")
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `summary-tabs-boundary-${width}-${theme}`)
      // Each explained on hover.
      await tab("boundary", "Summaries").hover()
      await expect(page.getByText(/Show the summaries the model reads/).first()).toBeVisible()
      // Keyboard: focus the chosen tab, arrow to the other, it is chosen, focus visible on it.
      await tab("boundary", "Messages").focus()
      await page.keyboard.press("ArrowRight")
      await expect(tab("boundary", "Summaries")).toBeFocused()
      await expect(tab("boundary", "Summaries")).toHaveAttribute("aria-selected", "true")
      await expect(messages.locator("[data-timeline-summary]").first()).toBeVisible()
      const ring = await tab("boundary", "Summaries").evaluate((el) => getComputedStyle(el).boxShadow)
      expect(ring).not.toBe("none")
      await shoot("divider-focus")
      // Above the chat's first message: the same row, in step with the boundary's.
      await messages.evaluate((el) => (el.scrollTop = 0))
      await expect(row("start")).toBeVisible()
      await expect(tab("start", "Summaries")).toHaveAttribute("aria-selected", "true")
      await page.mouse.move(0, 0)
      await shoot("top-summaries")
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), `summary-tabs-start-${width}-${theme}`)
      await tab("start", "Messages").click()
      await expect(messages.locator("[data-timeline-summary]")).toHaveCount(0)
      // The list is placed anew; the focus stays on a Messages tab, so the arrows go on working.
      const focused = page.locator('[role="tab"]:focus')
      await expect(focused).toHaveAccessibleName("Messages")
      await expect(focused).toHaveAttribute("aria-selected", "true")
      await page.keyboard.press("ArrowRight")
      await expect(messages.locator("[data-timeline-summary]").first()).toBeVisible()
      await expect(focused).toHaveAccessibleName("Summaries")
      await page.keyboard.press("ArrowLeft")
      await expect(messages.locator("[data-timeline-summary]")).toHaveCount(0)
      await expect(focused).toHaveAccessibleName("Messages")
      // A press elsewhere right after a choice: the focus stays where it went, no tab takes it.
      await page.keyboard.press("ArrowRight")
      await page.mouse.click(width - 8, 200)
      await page.waitForTimeout(800)
      await expect(page.locator('[role="tab"]:focus')).toHaveCount(0)
      await expect(messages.locator("[data-timeline-summary]").first()).toBeVisible()
      await messages.evaluate((el) => (el.scrollTop = 0))
      await page.mouse.move(0, 0)
      await shoot("top-messages")
      await noSideways(page)
    })

test("no tabs in a chat without summaries", async ({ page }) => {
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "No summaries" })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A lone message." })
      return chat
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByText("A lone message.")).toBeVisible()
  await expect(page.getByTestId("lcm-boundary")).toBeVisible()
  await expect(page.getByTestId("summary-tabs")).toHaveCount(0)
})

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
