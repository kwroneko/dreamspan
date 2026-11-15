// Finding a message in any chat from the left panel's chat search (MessageSearch.tsx): the
// toggle beside the field widens it to message text, the results name the chat, the branch and
// the speaker with the words marked, a message both branches share is listed once, the URL holds
// the search through a reload, and a result opens its chat on its branch at that message.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let harbour = { chatId: "", forkId: "", branchSlot: "", sharedSlot: "" }
test.beforeAll(async () => {
  harbour = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const started = yield* api.StartChat({
        cards: [mira.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "The lighthouse keeper waves from the pier.", speakerEntityId: null }
      })
      const chatId = started.chat.id
      yield* api.RenameChat({ chatId, name: "Harbour nights" })
      const first = started.chat.activeLeafSlotId!
      const fork = yield* api.CreateFork({ chatId, fromForkId: null, atSlotId: first, name: "Foggy path" })
      const sent = yield* api.SendMessage({
        chatId,
        forkId: fork.fork.id,
        parentSlotId: first,
        branch: false,
        content: "Only this branch hears the lighthouse foghorn at midnight.",
        reply: false
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      const other = yield* api.CreateChat({ title: "Market day" })
      yield* api.SendMessage({
        chatId: other.id,
        parentSlotId: null,
        branch: false,
        content: "Nobody mentions the tower here.",
        reply: false
      })
      const unfinished = yield* api.CreateChat({ title: "Unfinished harbour (import unfinished)" })
      yield* api.SendMessage({
        chatId: unfinished.id,
        parentSlotId: null,
        branch: false,
        content: "unfinishedsignal from a partial import",
        reply: false
      })
      return { chatId, forkId: fork.fork.id, branchSlot: sent.entry.slotId, sharedSlot: first }
    })
  )
})

const panelOf = (page: Page, width: number) =>
  width === 390 ? page.locator(".fixed.inset-0") : page.getByRole("complementary", { name: "Sidebar", exact: true })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`message search at ${width} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/`)
      const open = async () => {
        if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      }
      await open()
      const panel = panelOf(page, width)
      const toggle = panel.getByRole("button", { name: "Search message text", exact: true })
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-pressed", "true")
      const field = panel.getByRole("textbox", { name: "Find in messages", exact: true })
      await field.fill("lighthouse")
      const results = panel.getByRole("list", { name: "Messages found", exact: true })
      const hits = results.locator("[data-message-hit]")
      await expect(hits).toHaveCount(2)
      // Newest first: the branch's own message, then the one both branches share, listed once.
      await expect(hits.nth(0)).toContainText("Harbour nights")
      await expect(hits.nth(0)).toContainText("You: Only this branch hears the lighthouse foghorn")
      await expect(hits.nth(0).locator("[data-hit-branch]")).toHaveText("#2 on Foggy path")
      await expect(hits.nth(1).locator("[data-hit-branch]")).toHaveText(/^#1 on .+ and 1 other branch$/)
      await expect(hits.nth(0).locator("mark")).toHaveText("lighthouse")
      await expect(hits.filter({ hasText: "tower" })).toHaveCount(0)
      expect(new URL(page.url()).searchParams.get("sideIn")).toBe("messages")
      expect(new URL(page.url()).searchParams.get("sideQ")).toBe("lighthouse")
      await expectLayout(page, info, `message-search-${width}-${theme}`, {
        scope: width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
      })
      await page.screenshot({ path: info.outputPath(`results-${width}-${theme}.png`) })

      await field.fill("unfinishedsignal")
      await expect(hits).toHaveCount(1)
      await expect(hits.first()).toContainText("Unfinished harbour (import unfinished)")
      await expectLayout(page, info, `unfinished-message-search-${width}-${theme}`, {
        scope: width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
      })
      await field.fill("lighthouse")
      await expect(hits).toHaveCount(2)

      // A reload shows the same search.
      await page.reload()
      await open()
      await expect(panelOf(page, width).locator("[data-message-hit]")).toHaveCount(2)
      await expect(panelOf(page, width).getByRole("textbox", { name: "Find in messages" })).toHaveValue("lighthouse")

      // Nothing found says so; then the branch's message opens on its branch, at that message.
      await panelOf(page, width).getByRole("textbox", { name: "Find in messages" }).fill("zeppelin")
      await expect(panelOf(page, width).getByText("No message in your chats has “zeppelin”.")).toBeVisible()
      await panelOf(page, width).getByRole("textbox", { name: "Find in messages" }).fill("foghorn")
      await panelOf(page, width).locator("[data-message-hit]").first().click()
      await expect(page).toHaveURL(new RegExp(`/chats/${harbour.chatId}\\?`))
      const url = new URL(page.url())
      expect(url.searchParams.get("fork")).toBe(harbour.forkId)
      expect(url.searchParams.get("slot")).toBe(harbour.branchSlot)
      await expect(page.locator(`article[data-slot="${harbour.branchSlot}"]`)).toContainText("foghorn")
      await page.reload()
      await expect(page.locator(`article[data-slot="${harbour.branchSlot}"]`)).toContainText("foghorn")

      // Back to names: the chat list again.
      await open()
      await panelOf(page, width).getByRole("button", { name: "Search message text", exact: true }).click()
      await expect(panelOf(page, width).getByRole("textbox", { name: "Find a chat", exact: true })).toBeVisible()
      await expect(panelOf(page, width).locator("[data-message-hit]")).toHaveCount(0)
    })
