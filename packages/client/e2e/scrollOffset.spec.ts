// The development probe from review-suitegreen5: a short history clamps the initial
// estimate, and correcting that offset must not flush React during its layout effect.
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import type { SendResult } from "@rp/shared/chatApi.ts"
import { createServer } from "vite"
import { asUser } from "./support/rpc.ts"
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
    await page.setViewportSize({ width: 1440, height: 1000 })
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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`preserves a native jump before its scroll event: ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      // Native scroll events are deferred. Hold that notification while a chat update
      // commits, making the ordering deterministic without delaying the actual scroll.
      await page.addInitScript(() => {
        document.addEventListener(
          "scroll",
          (event) => {
            const held = (window as unknown as { __holdMessageScroll?: boolean }).__holdMessageScroll
            if (held && event.target instanceof HTMLElement && event.target.dataset.testid === "messages")
              event.stopImmediatePropagation()
          },
          true
        )
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const { chat, anchor } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
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
          return { chat, anchor: slots[20]! }
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      const list = page.getByTestId("messages")
      await expect(list.locator("article").last()).toBeInViewport()
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      await list.evaluate((element) => {
        ;(window as unknown as { __holdMessageScroll: boolean }).__holdMessageScroll = true
        element.scrollTop = 0
      })
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.RenameChat({ chatId: chat.id, name: "Updated during the native jump" })
      )
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
