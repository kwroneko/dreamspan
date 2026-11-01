import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { condensed, level1 } from "./support/summaries.ts"
import { showActions } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(180_000)
// One API session for the file: a login per call would reach the per-address login throttle.
let cookie = ""
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
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
      await summary.getByRole("button", { name: /^Expand messages/ }).click()
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
  await summary.getByRole("button", { name: /^Expand messages/ }).click()
  await expect(summary.locator("article")).toHaveCount(100)
  await summary.getByRole("button", { name: "Earlier messages", exact: true }).click()
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

for (const width of [1440, 390])
  test(`links traverse nested summaries and page directly to early originals ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const chat = await fixture(130, 120)
    // The fixture's edit made a new revision of the child; a parent pinning the old one is stale.
    const child = await admin((api) => api.GetSummary({ summaryId: chat.summary.id as never }))
    const top = await condensed(
      server().dataDir,
      chat.id,
      [{ ...chat.summary, revisionId: child.revisionId }],
      "Nested retained summary"
    )
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
    await summary.getByRole("button", { name: "Later messages", exact: true }).click()
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

for (const width of [1440, 390])
  test(`a refreshed linked page retains access to later originals ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const chat = await fixture(130, 120)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}?slot=${chat.entries[1]!.slotId}`)
    const summary = page.locator(`[data-timeline-summary="${chat.summary.id}"]`)
    await expect(summary.locator("article")).toHaveCount(100)
    const later = summary.getByRole("button", { name: "Later messages", exact: true })
    await expect(later).toHaveCount(1)
    // Another tab selects a new version: the refresh reads backwards from the last loaded original.
    const original = chat.entries[1]!
    await admin((api) =>
      api.WriteVersion({
        slotId: original.slotId,
        content: "A selected version that refreshes the linked page",
        expectedRowVersion: original.rowVersion
      })
    )
    await expect(summary.locator(`article[data-slot="${original.slotId}"] .markdown`)).toHaveText(
      "A selected version that refreshes the linked page"
    )
    await expect(summary.locator("article")).toHaveCount(100)
    await expect(later).toHaveCount(1)
    await shoot(page, `refreshed-link-${width}`)
    await later.click()
    await expect(summary.locator("article")).toHaveCount(120)
    await expect(later).toHaveCount(0)
  })

test("a delayed page response cannot land in another link's page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const chat = await fixture(250, 240)
  let release: (() => void) | null = null
  let answered = false
  let held: unknown = null
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    upstream.onMessage((data) => {
      if (held !== null && typeof data === "string" && (JSON.parse(data) as { requestId?: unknown }).requestId === held)
        answered = true
      socket.send(data)
    })
    socket.onMessage((data) => {
      const request =
        typeof data === "string"
          ? (JSON.parse(data) as {
              tag?: string
              id?: unknown
              payload?: { leafSlotId?: string; range?: { _tag: string } }
            })
          : null
      if (
        held === null &&
        request?.tag === "ReadPath" &&
        request.payload?.leafSlotId === chat.summary.lastSlotId &&
        request.payload.range?._tag === "Newer"
      ) {
        held = request.id
        release = () => upstream.send(data)
        return
      }
      upstream.send(data)
    })
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const base = `${server().url}/chats/${chat.id}`
  await page.goto(`${base}?slot=${chat.entries[1]!.slotId}`)
  const summary = page.locator(`[data-timeline-summary="${chat.summary.id}"]`)
  await expect(summary.locator("article")).toHaveCount(100)
  await summary.getByRole("button", { name: "Later messages", exact: true }).click()
  await expect.poll(() => release !== null).toBe(true)
  // Follow a link to another page of the same summary while the old page is still on its way.
  await page.evaluate((url) => {
    history.pushState({}, "", url)
    dispatchEvent(new PopStateEvent("popstate"))
  }, `${base}?slot=${chat.entries[219]!.slotId}`)
  const slots = () => summary.locator("article").evaluateAll((rows) => rows.map((row) => row.dataset.slot))
  await expect.poll(async () => (await slots())[0]).toBe(chat.entries[140]!.slotId)
  await expect(summary.locator("article")).toHaveCount(100)
  release!()
  await expect.poll(() => answered).toBe(true)
  // Responses arrive in order, so once the next page has rendered the stale one has been handled.
  // The new page pages on from its own window, without the old page appended.
  await summary.getByRole("button", { name: "Earlier messages", exact: true }).click()
  await expect(summary.locator("article")).toHaveCount(200)
  expect(await slots()).toEqual(chat.entries.slice(40, 240).map((entry) => entry.slotId))
})
