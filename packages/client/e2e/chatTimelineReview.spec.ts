import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, asUser } from "./support/rpc.ts"
import { condensed, level1 } from "./support/summaries.ts"
import { showActions } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(180_000)
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
const fixture = async (count = 8, covered = 4) => {
  const chat = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Review synthetic timeline" })
      let parent: SlotId | null = null
      for (let n = 1; n <= count; n++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Original ${n}`
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        parent = sent.entry.slotId
      }
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 500 })
      return { id: chat.id, entries: path.entries }
    })
  )
  const summary = await level1(
    server().dataDir,
    chat.id,
    chat.entries.slice(0, covered),
    "A retained review summary of the first four messages."
  )
  await admin((api) =>
    Effect.gen(function* () {
      const current = yield* api.GetSummary({ summaryId: summary.id as never })
      yield* api.EditSummary({
        summaryId: current.id,
        content: current.content,
        expectedRowVersion: current.rowVersion,
        commitDraft: null
      })
      yield* api.SetDisplayPrefs({ prefs: { timeline: "summaries" } })
    })
  )
  return { ...chat, summary }
}

const shoot = async (page: Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`saved edits to expanded originals must appear immediately ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      const chat = await fixture()
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      const summary = page.locator(`[data-timeline-summary="${chat.summary.id}"]`)
      await summary.getByRole("button", { name: "Expand to messages", exact: true }).click()
      const message = page.locator(`article[data-slot="${chat.entries[0]!.slotId}"]`)
      await expect(message.locator(".markdown")).toHaveText("Original 1")
      await showActions(message)
      await message.getByRole("button", { name: "Edit", exact: true }).click()
      await message.getByLabel("Message text").fill("Saved replacement from expanded summary")
      await message.getByRole("button", { name: "Save", exact: true }).click()
      await expect(message.getByLabel("Message text")).toHaveCount(0)
      const stored = await admin((api) =>
        api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      )
      expect(stored.entries[0]!.version.content).toBe("Saved replacement from expanded summary")
      await expect(message.locator(".markdown")).toHaveText("Saved replacement from expanded summary")
      await shoot(page, `saved-edit-${width}-${colorScheme}`)
    })

    test(`a link to a covered original must reveal the linked message ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      const chat = await fixture()
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[1]!.slotId}`)
      await expect(page.locator(`[data-timeline-summary="${chat.summary.id}"]`)).toBeVisible()
      await expect(page.locator(`article[data-slot="${chat.entries[1]!.slotId}"]`)).toBeInViewport({ ratio: 1 })
      await shoot(page, `covered-link-${width}-${colorScheme}`)
    })
  }

test("expanded pages refresh originals outside the main window without losing earlier pages", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const chat = await fixture(130, 120)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const summary = page.locator(`[data-timeline-summary="${chat.summary.id}"]`)
  // The selected layer arrives after the message window and can replace its rows.
  await expect(async () => {
    await page.getByTestId("messages").evaluate((node) => {
      node.scrollTop = 0
    })
    await expect(summary).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await summary.getByRole("button", { name: "Expand to messages", exact: true }).click()
  await expect(summary.locator("article")).toHaveCount(100)
  await summary.getByRole("button", { name: "Load earlier messages in this summary" }).click()
  await expect(summary.locator("article")).toHaveCount(120)
  const original = chat.entries[0]!
  const message = page.locator(`article[data-slot="${original.slotId}"]`)
  await message.scrollIntoViewIfNeeded()
  await showActions(message)
  await message.getByRole("button", { name: "Edit", exact: true }).click()
  await message.getByLabel("Message text").fill("Saved outside the main window")
  await message.getByRole("button", { name: "Save", exact: true }).click()
  await expect(message.getByLabel("Message text")).toHaveCount(0)
  await expect(message.locator(".markdown")).toHaveText("Saved outside the main window")
  await expect(summary.locator("article")).toHaveCount(120)
  // A remote slot/version change must also refresh expanded originals.
  await admin((api) =>
    api.WriteVersion({
      slotId: original.slotId,
      content: "Another selected version",
      expectedRowVersion: original.rowVersion
    })
  )
  await expect(message.locator(".markdown")).toHaveText("Another selected version")
  await admin((api) => api.SetMessageHidden({ slotId: original.slotId, hidden: true }))
  await expect(message).toHaveAttribute("data-hidden", "true")
  await expect(summary.locator("article")).toHaveCount(120)
})

test("links traverse nested summaries and page directly to early originals", async ({ page }) => {
  const chat = await fixture(130, 120)
  const top = await condensed(server().dataDir, chat.id, [chat.summary], "Nested retained summary")
  await admin((api) =>
    Effect.gen(function* () {
      const current = yield* api.GetSummary({ summaryId: top.id as never })
      yield* api.EditSummary({
        summaryId: current.id,
        content: current.content,
        expectedRowVersion: current.rowVersion,
        commitDraft: null
      })
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const base = `${server().url}/chats/${chat.id}`
  await page.goto(`${base}?slot=${chat.entries[1]!.slotId}`)
  const summary = page.locator(`[data-timeline-summary="${top.id}"]`)
  const message = (index: number) => page.locator(`article[data-slot="${chat.entries[index]!.slotId}"]`)
  await expect(summary).toBeVisible()
  await expect(message(1)).toBeInViewport()
  await expect(message(1)).toHaveClass(/border-accent/)
  await expect(summary.locator("article")).toHaveCount(100)
  await summary.getByRole("button", { name: "Load later messages in this summary" }).click()
  await expect(summary.locator("article")).toHaveCount(120)
  // Navigate within the mounted chat, then follow a range link from its summary panel.
  await page.evaluate((url) => {
    history.pushState({}, "", url)
    dispatchEvent(new PopStateEvent("popstate"))
  }, `${base}?slot=${chat.entries[110]!.slotId}`)
  await expect(message(110)).toBeInViewport()
  await expect(message(110)).toHaveClass(/border-accent/)
  const panel = await openPanel(page, "Summaries")
  await panel.getByRole("button", { name: "Messages 1–120: show the first message", exact: true }).click()
  await expect(message(0)).toBeInViewport()
  await expect(message(0)).toHaveClass(/border-accent/)
})
