import { expect, type Page, test } from "@playwright/test"
import { DEFAULT_DISPLAY_PREFS, type SendResult } from "@rp/shared/chatApi.ts"
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { condensed, level1 } from "./support/summaries.ts"
import { closePanel, openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
let cookie = ""
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

const fixture = async (title: string, count = 8) => {
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title })
      let parent: SlotId | null = null
      for (let n = 1; n <= count; n++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Original ${n}: ${title}`
        })
        if (sent._tag !== "Posted") return yield* Effect.die("queued")
        parent = sent.entry.slotId
      }
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 500 })
      return { id: chat.id, entries: path.entries }
    })
  )
  const first = await level1(server().dataDir, chat.id, chat.entries.slice(0, 2), "First pair of original messages.")
  const second = await level1(server().dataDir, chat.id, chat.entries.slice(2, 4), "Second pair of original messages.")
  const top = await condensed(server().dataDir, chat.id, [first, second], "Condensed first four messages.")
  // A second top-level item makes path-order assertions meaningful.
  const tail = await level1(server().dataDir, chat.id, chat.entries.slice(4, 6), "The fifth and sixth messages.")
  return { ...chat, first, second, top, tail }
}
const originals = (page: Page, entry: PathEntry) => page.locator(`article[data-slot="${entry.slotId}"]`)

for (const width of [1440, 390]) {
  test(`timeline toggle, selected layer, recursive expansion and composer draft at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const chat = await fixture(`Timeline ${width}`)
    // Use an uncovered link: covered links deliberately expand their summary.
    await page.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[6]!.slotId}`)
    await expect(originals(page, chat.entries[5]!)).toBeVisible()
    await expect(page.locator("[data-timeline-summary]")).toHaveCount(0)
    const composer = page.getByLabel("Message", { exact: true })
    await composer.fill("A draft kept while switching the viewer.")
    const toggle = page.getByTestId("messages").getByRole("switch", { name: "Summaries in chat" })
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(page.locator("[data-timeline-summary]")).toHaveCount(2)
    const top = page.locator(`[data-timeline-summary="${chat.top.id}"]`)
    const tail = page.locator(`[data-timeline-summary="${chat.tail.id}"]`)
    expect(
      await page
        .locator("[data-timeline-summary]")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-level")))
    ).toEqual(["2", "1"])
    await expect(top).toContainText("Messages 1–4")
    await expect(top).toContainText("Condensed first four messages.")
    await expect(tail).toContainText("Messages 5–6")
    await expect(originals(page, chat.entries[5]!)).toHaveCount(0)
    await expect(originals(page, chat.entries[6]!)).toBeVisible()
    await top.getByRole("button", { name: "Expand messages 1–4", exact: true }).click()
    const child = top.locator(`[data-timeline-summary="${chat.first.id}"]`)
    await expect(child).toContainText("First pair of original messages.")
    await expect(top.locator(`[data-timeline-summary="${chat.second.id}"]`)).toContainText("Second pair")
    await child.getByRole("button", { name: /^Expand messages/ }).click()
    await expect(originals(page, chat.entries[0]!)).toBeVisible()
    await expect(originals(page, chat.entries[1]!)).toBeVisible()
    await child
      .getByRole("button", { name: /^Collapse messages/ })
      .first()
      .click()
    await expect(originals(page, chat.entries[0]!)).toHaveCount(0)
    await expect(composer).toHaveValue("A draft kept while switching the viewer.")
    const panel = await openPanel(page, "Summaries")
    await expect(panel.getByRole("switch", { name: "Summaries in chat" })).toBeChecked()
    await panel.getByRole("switch", { name: "Coverage rail" }).click()
    await expect(panel.getByRole("switch", { name: "Coverage rail" })).toBeChecked()
    await closePanel(page)
    await page.reload()
    await expect(page.getByTestId("messages").getByRole("switch", { name: "Summaries in chat" })).toBeChecked()
    await expect(page.getByTestId("coverage-rail")).toBeVisible()
    await expect(composer).toHaveValue("A draft kept while switching the viewer.")
    // Another page of this browser on the same chat: originals and no rail (they're this tab's).
    const sibling = await page.context().newPage()
    await sibling.setViewportSize({ width, height: 1000 })
    await sibling.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[6]!.slotId}`)
    await expect(originals(sibling, chat.entries[5]!)).toBeVisible()
    await expect(sibling.getByTestId("messages").getByRole("switch", { name: "Summaries in chat" })).not.toBeChecked()
    await expect(sibling.locator("[data-timeline-summary]")).toHaveCount(0)
    await expect(sibling.getByTestId("coverage-rail")).toHaveCount(0)
    await sibling.reload()
    await expect(originals(sibling, chat.entries[5]!)).toBeVisible()
    await expect(sibling.locator("[data-timeline-summary]")).toHaveCount(0)
    await sibling.close()
    // Another chat opened in this tab: the tab's choices come along.
    const other = await fixture(`Other chat ${width}`)
    await page.evaluate((href) => {
      const a = Object.assign(document.createElement("a"), { href })
      document.body.append(a)
      a.click()
      a.remove()
    }, `/chats/${other.id}`)
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/chats/${other.id}`)
    await expect(page.locator("[data-timeline-summary]")).toHaveCount(2)
    const otherPanel = await openPanel(page, "Summaries")
    await expect(otherPanel.getByRole("switch", { name: "Coverage rail" })).toBeChecked()
    await otherPanel.getByRole("switch", { name: "Summaries in chat" }).click()
    await expect(otherPanel.getByRole("switch", { name: "Summaries in chat" })).not.toBeChecked()
    await closePanel(page)
    await expect(page.locator("[data-timeline-summary]")).toHaveCount(0)
    await expect(originals(page, other.entries[5]!)).toBeVisible()
  })
}

test("viewer preferences belong to the account, how a tab shows the timeline to the tab", async ({ browser }) => {
  await admin((api) =>
    api.CreateUser({ handle: "viewer", displayName: "Viewer", role: "user", password: "viewer-password-1" })
  )
  const otherCookie = await loginCookie(server(), "viewer", "viewer-password-1")
  const patch = { portraitSize: "largest", outputMacros: true } as const
  await admin((api) => api.SetDisplayPrefs({ prefs: patch }))
  await admin((api) => api.SetDisplayPrefs({ prefs: { reasoning: "collapsed" } }))
  // Later preferences (display transforms, text colours, Enter sends) keep their defaults.
  expect(await admin((api) => api.GetDisplayPrefs({}))).toEqual({
    ...DEFAULT_DISPLAY_PREFS,
    ...patch,
    reasoning: "collapsed"
  })
  expect(await withCookie(server(), otherCookie, (api) => api.GetDisplayPrefs({}))).toEqual(DEFAULT_DISPLAY_PREFS)
  const chat = await fixture("Preferences across fresh browsers")
  // A fresh browser has no localStorage: the account still has the portrait size; the layer
  // shown is the tab's URL's (originals without it, summaries with it).
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  try {
    const page = await context.newPage()
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    await expect(page.getByTestId("messages").getByRole("switch", { name: "Summaries in chat" })).not.toBeChecked()
    await expect(page.locator("[data-timeline-summary]")).toHaveCount(0)
    await page.goto(`${server().url}/chats/${chat.id}?timeline=summaries`)
    await expect(page.locator("[data-timeline-summary]")).toHaveCount(2)
    await expect(page.locator("article .chat-portrait").first()).toHaveCSS("width", "84px")
    await page.reload()
    await expect(page.locator("article .chat-portrait").first()).toHaveCSS("height", "126px")
    await page.locator("article .chat-portrait").first().click()
    await expect(page.getByText("This card has no image.")).toBeVisible()
    await page.keyboard.press("Escape")
    await apiLogin(page.request, server(), "viewer", "viewer-password-1")
    const otherChat = await withCookie(server(), otherCookie, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Viewer's chat" })
        yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "A viewer's message." })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${otherChat.id}`)
    const panel = await openPanel(page, "Summaries")
    await expect(panel.getByRole("switch", { name: "Summaries in chat" })).not.toBeChecked()
    await expect(panel.getByRole("switch", { name: "Coverage rail" })).not.toBeChecked()
    await openPanel(page, "Interface")
    await expect(page.getByLabel("Message portrait size", { exact: true })).toHaveText("Small (60 × 90)")
  } finally {
    await context.close()
  }
})

test("expansion reads the child revisions the parent condensed", async ({ page }) => {
  const chat = await fixture("Pinned summary provenance")
  await admin((api) =>
    Effect.gen(function* () {
      const top = yield* api.GetSummary({ summaryId: chat.top.id as never })
      // A manually kept parent remains selected after its child changes.
      yield* api.EditSummary({
        summaryId: top.id,
        content: top.content,
        expectedRowVersion: top.rowVersion,
        commitDraft: null
      })
      const child = yield* api.GetSummary({ summaryId: chat.first.id as never })
      yield* api.EditSummary({
        summaryId: child.id,
        content: "A later edit of the first child.",
        expectedRowVersion: child.rowVersion,
        commitDraft: null
      })
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}?timeline=summaries`)
  const top = page.locator(`[data-timeline-summary="${chat.top.id}"]`)
  await top.getByRole("button", { name: "Expand messages 1–4", exact: true }).click()
  const child = top.locator(`[data-timeline-summary="${chat.first.id}"]`)
  await expect(child).toContainText("First pair of original messages.")
  await expect(child).not.toContainText("A later edit")
})
