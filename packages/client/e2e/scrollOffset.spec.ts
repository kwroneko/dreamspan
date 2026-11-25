// The development probe from review-suitegreen5: a short history clamps the initial
// estimate, and correcting that offset must not flush React during its layout effect.
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { createServer } from "vite"
import { asPage, asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("development scroll synchronization does not emit lifecycle errors", async ({ page }) => {
  test.setTimeout(180_000)
  const vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/rpc": { target: server().url.replace(/^http/, "ws"), ws: true },
        "/auth": { target: server().url }
      }
    }
  })
  try {
    await vite.listen()
    const url = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
    const errors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await page.setViewportSize({ width: Number(process.env.FOLLOW_TEST_WIDTH ?? 1440), height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const { chat, lastSlot } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Synthetic scroll review" })
        let lastSlot: SlotId | null = null
        for (let n = 1; n <= 3; n++) {
          const sent: SendResult = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: lastSlot,
            branch: false,
            content: `Review message ${n}`
          })
          if (sent._tag !== "Posted") throw new Error("queued")
          lastSlot = sent.entry.slotId
        }
        return { chat, lastSlot }
      })
    )
    await page.goto(`${url}/chats/${chat.id}`)
    // Vite compiles the lazy chat/Markdown modules on this first navigation.
    await expect(page.locator(`article[data-slot="${lastSlot}"]`)).toBeInViewport({ timeout: 120_000 })
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    )
    expect(errors.filter((error) => error.includes("flushSync"))).toEqual([])
  } finally {
    await vite.close()
  }
})

const openHistory = async (page: Page) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chat, anchor, lastSlot } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Native scroll ordering" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      let parent: SlotId | null = null
      const slots: SlotId[] = []
      for (let n = 0; n < 80; n++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Message ${n + 1}. ` + "The synthetic road follows the harbor. ".repeat(12)
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        parent = sent.entry.slotId
        slots.push(sent.entry.slotId)
      }
      return { chat, anchor: slots[20]!, lastSlot: parent }
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const list = page.getByTestId("messages")
  await expect(list.locator(`article[data-slot="${lastSlot}"]`)).toBeInViewport()
  await expect(page.getByText("No model chosen", { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await expect
    .poll(() => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThanOrEqual(1)
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  return { chat, anchor, list }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`preserves a wheel jump before its scroll event: ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      // Native scroll events are deferred. Hold that notification while a chat update
      // commits, making the ordering deterministic without delaying the actual scroll.
      await page.addInitScript(() => {
        document.addEventListener(
          "scroll",
          (event) => {
            const list = event.target
            if (!(list instanceof HTMLElement) || list.dataset.holdMessageScroll === undefined) return
            // A later poll of scrollTop can miss zero once older messages are prepended.
            if (list.scrollTop === 0) list.dataset.holdMessageScroll = "reached-top"
            event.stopImmediatePropagation()
          },
          true
        )
      })
      const { chat, anchor, list } = await openHistory(page)
      await list.hover()
      await list.evaluate((node) => (node.dataset.holdMessageScroll = "waiting"))
      await page.mouse.wheel(0, -100_000)
      await expect(list).toHaveAttribute("data-hold-message-scroll", "reached-top")
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.RenameChat({ chatId: chat.id, name: "Updated during the native jump" })
      )
      await expect(page.getByRole("heading", { name: "Updated during the native jump" })).toBeVisible()
      const row = page.locator(`article[data-slot="${anchor}"]`)
      await expect(row).toBeInViewport()
      await expect
        .poll(() =>
          page.evaluate((anchor) => {
            const list = document.querySelector('[data-testid="messages"]')!
            const row = document.querySelector(`article[data-slot="${anchor}"]`)
            return row ? Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top - 16) : Infinity
          }, anchor)
        )
        .toBeLessThanOrEqual(2)
    })

for (const width of [1440, 390])
  test(`a pending end scroll yields to the wheel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const { list } = await openHistory(page)
    await list.hover()

    // Shrinking the viewport triggers an end scroll. Hold the reconciliation frame
    // scheduled by that scroll so we can change its target after a real wheel turn.
    await list.evaluate((node) => {
      const originalStyle = node.style.cssText
      const scrollTo = node.scrollTo
      const requestFrame = window.requestAnimationFrame
      node.scrollTo = (...args: unknown[]) => {
        Reflect.apply(scrollTo, node, args)
        if ((args[0] as ScrollToOptions | undefined)?.behavior !== "auto") return
        node.scrollTo = scrollTo
        window.requestAnimationFrame = (callback) => {
          window.requestAnimationFrame = requestFrame
          return requestAnimationFrame(() => {
            node.addEventListener("resume-end-scroll", () => requestAnimationFrame(callback), { once: true })
            node.dataset.endScroll = "pending"
          })
        }
      }
      node.addEventListener("restore-list-height", () => (node.style.cssText = originalStyle), { once: true })
      node.style.height = `${node.clientHeight - 160}px`
      node.style.flex = "none"
    })
    await expect(list).toHaveAttribute("data-end-scroll", "pending")

    const fromEnd = () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
    await page.mouse.wheel(0, -400)
    await expect.poll(fromEnd).toBeGreaterThan(390)
    await list.dispatchEvent("restore-list-height")
    const offset = await list.evaluate(async (node) => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      return node.scrollTop
    })
    expect(await fromEnd()).toBeGreaterThan(200)

    await list.dispatchEvent("resume-end-scroll")
    const after = await list.evaluate(async (node) => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      return node.scrollTop
    })
    expect(after).toBe(offset)
  })

for (const width of [1440, 390])
  test(`keeps keyboard focus visible after shrinking the chat viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1200 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const marker = "Earlier message link"
    const chat = await asPage(page, server(), (api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Focus during chat resize" })
        yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: [
            `[${marker}](#earlier)`,
            ...Array.from({ length: 17 }, (_, i) => `Paragraph ${i + 1}.`),
            "[Later message link](#later)"
          ].join("\n\n")
        })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}`)
    const list = page.getByTestId("messages")
    const link = list.getByRole("link", { name: marker })
    const later = list.getByRole("link", { name: "Later message link" })
    await expect(link).toBeInViewport()
    await expect(later).toBeInViewport()
    await expect(page.getByText("No model chosen", { exact: true })).toBeVisible()
    expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0)

    await page.setViewportSize({ width, height: 760 })
    await expect(link).not.toBeInViewport()
    await expect(later).toBeInViewport()
    await later.press("Shift+Tab")
    await expect(link).toBeFocused()
    await expect(link).toBeInViewport()
  })
