import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { observePaintedPin } from "../perf/paintedPin.ts"
import { budgets } from "../perf/budgets.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test("the presented-frame pin assertion detects an actual painted jump", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 })
  await page.setContent(
    '<div data-testid="messages" style="height:400px;overflow:auto;position:relative"><div data-index="0" style="height:2000px;position:relative">Synthetic scroll surface</div></div>'
  )
  await page.getByTestId("messages").evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })
  const probe = await observePaintedPin(page)
  await expect.poll(() => probe.result().frames).toBeGreaterThan(0)
  expect(probe.result().missing).toBe(0)
  expect(probe.result().maximumPx).toBeLessThanOrEqual(budgets.pinnedPx)
  const before = probe.result().frames
  await page.getByTestId("messages").evaluate((list) => {
    list.scrollTop -= 300
  })
  await expect.poll(() => probe.result().frames).toBeGreaterThan(before)
  const presented = await probe.stop()
  expect(presented.errors).toEqual([])
  expect(presented.maximumPx).toBeGreaterThan(budgets.pinnedPx)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a cold deep link stays readable while the shell loads: ${width} ${theme}`, async ({ page }, info) => {
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: `Cold navigation ${width} ${theme}` })
          let parent = null as import("@rp/shared/chat.ts").SlotId | null
          let linked = parent
          for (let n = 0; n < 12; n++) {
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              content: `Synthetic cold-open message ${n}.`
            })
            if (sent._tag !== "Posted") throw new Error("unexpected queued fixture message")
            parent = sent.entry.slotId
            if (n === 4) linked = parent
          }
          return { chat, linked: linked! }
        })
      )
      const held: Array<() => void> = []
      let released = false
      let sidebarRowsRequested = false
      await page.routeWebSocket("**/rpc", (socket) => {
        const peer = socket.connectToServer()
        const shell = new Set<string | number>()
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as {
            _tag: string
            id?: string | number
            tag?: string
            payload?: { chat?: string | null; sections?: ReadonlyArray<{ id: string }> }
          }
          if (
            frame._tag === "Request" &&
            frame.id !== undefined &&
            (frame.tag === "WatchShellCards" || frame.tag === "WatchShellForks")
          )
            shell.add(frame.id)
          if (
            frame._tag === "Request" &&
            frame.tag === "WatchShellForks" &&
            frame.payload?.chat === null &&
            frame.payload.sections?.some((section) => section.id === "chats")
          )
            sidebarRowsRequested = true
          peer.send(message)
        })
        peer.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { requestId?: string | number }
          if (!released && frame.requestId !== undefined && shell.has(frame.requestId))
            held.push(() => socket.send(message))
          else socket.send(message)
        })
      })
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chat.id}?slot=${fixture.linked}&side=chats`)
      const article = page.locator(`article[data-slot="${fixture.linked}"]`)
      await expect(article).toBeVisible()
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible()
      // This fixture deliberately has no model. Settle its independent chat
      // readiness notice before measuring the effect of releasing the shell.
      await expect(page.getByText("No model chosen", { exact: true })).toBeVisible()
      const screens = process.env.PERFSHELL_SCREEN_DIR
      if (screens) {
        mkdirSync(screens, { recursive: true })
        await page.screenshot({ path: join(screens, `readable-${width}-${theme}.png`) })
      }
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      const panel =
        width === 390
          ? page.locator(".fixed.inset-0")
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      await expect(panel.getByText(/loading.*chats/i)).toBeVisible()
      await expect.poll(() => held.length).toBeGreaterThan(0)
      // Cards are still held: row subscriptions must not depend on their delivery.
      await expect.poll(() => sidebarRowsRequested).toBe(true)
      // Navigation remains usable while both catalogue responses are held.
      const chatUrl = page.url()
      await panel.getByRole("link", { name: "Settings", exact: true }).click()
      await expect(page).toHaveURL(/\/settings(?:\/|\?|$)/)
      await page.goBack()
      await expect(page).toHaveURL(chatUrl)
      await expect(article).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      await expect(panel.getByText(/loading.*chats/i)).toBeVisible()
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      const before = await page.getByTestId("messages").boundingBox()
      const navigation = await panel.getByRole("link", { name: "Settings", exact: true }).boundingBox()
      await expectLayout(page, info, "cold shell loading")
      await page.screenshot({
        path: screens ? join(screens, `loading-${width}-${theme}.png`) : info.outputPath("loading.png")
      })
      await page.evaluate(() => {
        const states: string[][] = []
        const observer = new MutationObserver(() => {
          const ids = [...document.querySelectorAll<HTMLElement>("[data-shell-list] [data-chat-id]")].map(
            (row) => row.dataset.chatId!
          )
          if (ids.length) states.push(ids)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        Object.assign(window, { __coldShell: { states, observer } })
      })
      released = true
      for (const send of held.splice(0)) send()
      const row = panel.locator(`[data-shell-list] [data-chat-id="${fixture.chat.id}"]`).first()
      await expect(row).toBeVisible()
      await row.hover()
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      const after = await page.getByTestId("messages").boundingBox()
      expect(after).toEqual(before)
      expect(await panel.getByRole("link", { name: "Settings", exact: true }).boundingBox()).toEqual(navigation)
      const order = await page.evaluate(() => {
        const probe = (window as unknown as { __coldShell: { states: string[][]; observer: MutationObserver } })
          .__coldShell
        probe.observer.disconnect()
        return {
          states: probe.states,
          final: [...document.querySelectorAll<HTMLElement>("[data-shell-list] [data-chat-id]")].map(
            (row) => row.dataset.chatId!
          )
        }
      })
      for (const state of order.states) expect(state).toEqual(order.final.slice(0, state.length))
      await expectLayout(page, info, "cold shell loaded")
      await row.click()
      await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(fixture.chat.currentForkId)
      await expect(
        page.locator("article[data-slot]").filter({ hasText: "Synthetic cold-open message 11." })
      ).toBeVisible()
    })
