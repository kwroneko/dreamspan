// The summary screens as the review left them (ARCHITECTURE §16), at 1440 and 390, light and
// dark: a panel block's header holds its controls (the pencil, Details, ⋯) with the rest in the
// menu, the text is cut with Show all, a failure reads as words, every badge and switch says
// what it means on hover, the divider keeps its badges with its line, and in "Summaries in
// chat" a summary's header expands it, its end collapses it, and a link into a level-2
// summary lands on the message also on a phone, where the layer arrives after the window.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { condensed, level1 } from "./support/summaries.ts"
import { closePanel, openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(180_000)
// "Summaries in chat" is the account's: the tests take turns with it.
test.describe.configure({ mode: "serial" })
let cookie = ""
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

const LONG = Array.from(
  { length: 12 },
  (_, n) => `Line ${n + 1}: the ferry crossed at dusk, and the harbormaster counted the crates twice.`
).join("\n")

/** Sixty messages: level-1 summaries over 1–10 and 11–20 under a level-2, a failed one over 21–30. */
const makeChat = async (title: string) => {
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      let parent: SlotId | null = null
      for (let n = 1; n <= 60; n++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Message ${n} of ${title}. ` + "The tide came in over the causeway. ".repeat(6)
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        parent = sent.entry.slotId
      }
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 500 })
      return { id: chat.id, entries: path.entries }
    })
  )
  const dataDir = server().dataDir
  const first = await level1(dataDir, chat.id, chat.entries.slice(0, 10), "Mira and Tomas reached the ferry.")
  const second = await level1(dataDir, chat.id, chat.entries.slice(10, 20), "They crossed, and the ledger got wet.")
  const top = await condensed(dataDir, chat.id, [first, second], LONG)
  // As the summarizer records a provider's failure: its class, and its own body after the status.
  const failed = await level1(dataDir, chat.id, chat.entries.slice(20, 30), "", {
    status: "failed",
    error: JSON.stringify({ class: "overloaded", message: '500: {"message":"The upstream model is overloaded."}' })
  })
  return { ...chat, first, second, top, failed }
}

const timeline = (on: boolean) =>
  admin((api) => api.SetDisplayPrefs({ prefs: { timeline: on ? "summaries" : "originals" } }))

const hint = async (page: Page, target: ReturnType<Page["locator"]>, text: string | RegExp) => {
  await target.hover()
  await expect(page.getByText(text).last()).toBeVisible()
  await page.mouse.move(0, 0)
}

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

for (const [name, viewport] of [
  ["1440", { width: 1440, height: 900 }],
  ["390", { width: 390, height: 844 }]
] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${name} ${colorScheme}`, () => {
      test.use({ viewport, colorScheme })

      test("a summary block keeps its controls in its header and its text first", async ({ page }) => {
        const chat = await makeChat(`blocks ${name} ${colorScheme}`)
        await timeline(false)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/chats/${chat.id}`)
        const panel = await openPanel(page, "Summaries")
        const top = panel.locator(`[data-summary="${chat.top.id}"]`)
        // Text first, cut to a few lines; nothing else as words under it.
        await expect(top.getByText("Line 1:", { exact: false })).toBeVisible()
        await expect(top.getByRole("button", { name: "Show all" })).toBeVisible()
        await expect(top.getByRole("button", { name: /^Re-summarize/ })).toHaveCount(0)
        await expect(top.getByRole("button", { name: "Details", exact: true })).toHaveCount(0)
        await top.getByRole("button", { name: "Show all" }).click()
        await expect(top.getByText(/Line 12:/)).toBeVisible()
        // The header: pencil, Details, ⋯; the menu says what each item does.
        await expect(top.getByRole("button", { name: "Edit the summary of messages 1–20" })).toBeVisible()
        await expect(top.getByRole("button", { name: "Details of the summary of messages 1–20" })).toBeVisible()
        await top.getByRole("button", { name: "Actions for the summary of messages 1–20" }).click()
        const resummarize = page.getByRole("menuitem", { name: /^Re-summarize messages 1–20/ })
        await expect(resummarize).toBeVisible()
        await expect(page.getByRole("menuitem", { name: "Condensed from 2" })).toBeVisible()
        await resummarize.hover()
        // Beside the menu (explain's menu items), and the item's description.
        await expect(
          page.getByText("Writes it again from its messages with your next reply.").filter({ visible: true })
        ).toBeVisible()
        await expect(resummarize).toHaveAccessibleDescription("Writes it again from its messages with your next reply.")
        await page.keyboard.press("Escape")
        // A badge says what it means.
        await hint(page, top.getByText("Level 2", { exact: true }), /a summary of level-1 summaries/)
        // A failure reads as words, with Retry in its header.
        const failed = panel.locator(`[data-summary="${chat.failed.id}"]`)
        await expect(failed).toContainText("The provider was busy: The upstream model is overloaded. (HTTP 500)")
        await expect(failed).not.toContainText('{"')
        await expect(failed.getByRole("button", { name: /^Re-summarize messages 21–30/ })).toHaveText("Retry")
        // The head: the two view switches on one row, each explained on hover.
        const switches = [
          panel.getByRole("switch", { name: "Summaries in chat" }),
          panel.getByRole("switch", { name: "Coverage rail" })
        ]
        if (name === "1440") {
          const [a, b] = await Promise.all(switches.map((s) => s.boundingBox()))
          expect(Math.abs(a!.y - b!.y)).toBeLessThan(4)
        }
        await hint(page, panel.getByText("Coverage rail", { exact: true }), /which summary covers each message/)
        await noSideways(page)
      })

      test("the divider keeps its badges with its line and says what they are", async ({ page }) => {
        const chat = await makeChat(`divider ${name} ${colorScheme}`)
        await timeline(false)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[20]!.slotId}`)
        const boundary = page.getByTestId("lcm-boundary")
        await boundary.scrollIntoViewIfNeeded()
        await expect(boundary).toContainText("1 failed")
        // The badge stays inside the button, which sits between the rules.
        const [line, badge] = await Promise.all([boundary.boundingBox(), boundary.getByText("1 failed").boundingBox()])
        expect(badge!.x).toBeGreaterThanOrEqual(line!.x)
        expect(badge!.x + badge!.width).toBeLessThanOrEqual(line!.x + line!.width + 1)
        await hint(page, boundary, /1 failed: those messages are sent as they are/)
        // A covered message shows the icon, not the word.
        const covered = page.locator(`article[data-slot="${chat.entries[19]!.slotId}"]`)
        await covered.scrollIntoViewIfNeeded()
        await expect(covered.getByRole("img", { name: /^Summarized/ })).toBeVisible()
        await expect(covered.getByText("Summarized", { exact: true })).toHaveClass(/sr-only/)
        await noSideways(page)
      })

      test("in Summaries in chat, a header expands and the end collapses; a link into level 2 lands", async ({
        page
      }) => {
        const chat = await makeChat(`timeline ${name} ${colorScheme}`)
        await timeline(true)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        // A link to message 15, inside the level-2 summary: it opens to it, highlighted.
        await page.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[14]!.slotId}`)
        const target = page.locator(`article[data-slot="${chat.entries[14]!.slotId}"]`)
        await expect(target).toBeVisible({ timeout: 30_000 })
        await expect(target).toHaveClass(/border-accent/)
        await expect(target).toBeInViewport()
        const top = page.locator(`[data-timeline-summary="${chat.top.id}"]`)
        await expect(top.getByRole("button", { name: "Collapse messages 1–20", exact: true }).first()).toHaveAttribute(
          "aria-expanded",
          "true"
        )
        // The level-1 summary's own end folds it, and brings its header back into view.
        const second = top.locator(`[data-timeline-summary="${chat.second.id}"]`)
        await second.getByRole("button", { name: "Collapse messages 11–20", exact: true }).last().click()
        await expect(target).toHaveCount(0)
        await expect(second.getByRole("button", { name: "Expand messages 11–20", exact: true })).toBeInViewport()
        // The header is the toggle again, and says so.
        await hint(
          page,
          second.getByRole("button", { name: "Expand messages 11–20", exact: true }),
          "Show its messages"
        )
        // Its state badges are those of the panel, and it opens there.
        await top.getByRole("button", { name: "Open the summary of messages 1–20 in the Summaries tab" }).click()
        const panel = page.getByRole("tabpanel", { name: "Summaries" })
        await expect(panel.locator(`[data-summary="${chat.top.id}"]`)).toBeVisible()
        await closePanel(page)
        await noSideways(page)
        await timeline(false)
      })
    })
  }
}
