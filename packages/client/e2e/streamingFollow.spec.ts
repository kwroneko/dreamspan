import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { asPage } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  FAKE_GENERATOR_TPS: "100",
  FAKE_GENERATOR_TOKENS: "3000",
  FAKE_GENERATOR_SEED: "17"
})

const openHistory = async (page: Page, width: number, compact: boolean, historySize: number) => {
  await page.setViewportSize({ width, height: 850 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chatId, lastSlot } = await asPage(page, server(), (api) =>
    Effect.gen(function* () {
      if (compact) yield* api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } })
      const chat = yield* api.CreateChat({ title: "Continuous reply after long synthetic history" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      let parent: SlotId | null = null
      for (let i = 1; i <= historySize; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Log entry ${i}. ${"The watch passed the lantern along the quay. ".repeat(12)}`
        })
        if (sent._tag !== "Posted") throw new Error("unexpected queue")
        parent = sent.entry.slotId
      }
      return { chatId: chat.id, lastSlot: parent! }
    })
  )

  await page.goto(`${server().url}/chats/${chatId}`)
  const list = page.getByTestId("messages")
  const fromEnd = () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
  await expect(list.getByText(new RegExp(`^Log entry ${historySize}\\.`))).toBeInViewport()
  await expect.poll(fromEnd).toBeLessThanOrEqual(1)
  return { chatId, lastSlot, list, fromEnd }
}

const openStream = async (page: Page, width: number, compact = false) => {
  const { chatId, lastSlot, list, fromEnd } = await openHistory(page, width, compact, 80)
  const startHeight = await list.evaluate((node) => node.scrollHeight)
  await asPage(page, server(), (api) => api.Generate({ chatId, parentSlotId: lastSlot, branch: false }))
  const generating = list.getByRole("article", { name: "Reply" }).getByText("generating", { exact: true })
  await expect(generating).toBeVisible()
  const height = () => list.evaluate((node) => node.scrollHeight)
  await expect.poll(height).toBeGreaterThan(startHeight + 350)
  return { list, fromEnd, height, startHeight, generating }
}

const expectReadingHistory = async ({ fromEnd, height, generating }: Awaited<ReturnType<typeof openStream>>) => {
  await expect.poll(fromEnd).toBeGreaterThan(200)
  const readingHeight = await height()
  await expect.poll(height).toBeGreaterThan(readingHeight + 120)
  await expect(generating).toBeVisible()
  expect(await fromEnd()).toBeGreaterThan(200)
}

for (const width of [390, 1440])
  test(`follows a continuous reply after layout clamps the scroll offset at ${width}px`, async ({ page }) => {
    const stream = await openStream(page, width)
    const { list, fromEnd, height, startHeight, generating } = stream
    // Deliver the browser's scroll event after layout has already moved back. This
    // forces the ordering without scroll input or a write to the scroll position.
    await expect
      .poll(() =>
        list.evaluate((node) => {
          const height = node.clientHeight
          const before = node.scrollTop
          // Check that we're at the end in the same task that changes the layout.
          if (node.scrollHeight - before - height > 1) return 0
          const style = node.style.cssText
          node.style.flex = "none"
          node.style.height = `${height + 200}px`
          const clamped = node.scrollTop
          node.style.cssText = style
          return Math.min(before - clamped, node.scrollHeight - node.scrollTop - node.clientHeight)
        })
      )
      .toBeGreaterThanOrEqual(190)

    await expect.poll(height).toBeGreaterThan(startHeight + 700)
    await expect(generating).toBeVisible()
    await expect.poll(fromEnd, { timeout: 1500 }).toBeLessThanOrEqual(1)

    // A real wheel gesture during the same stream leaves the reader in history.
    await list.hover()
    await page.mouse.wheel(0, -320)
    await expectReadingHistory(stream)
  })

test.describe("touch input", () => {
  test.use({ hasTouch: true })

  test("a touch drag releases follow during a continuous reply", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Uses CDP to send a native touch drag")
    const stream = await openStream(page, 390)
    await expect.poll(stream.fromEnd).toBeLessThanOrEqual(1)
    const box = (await stream.list.boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    const point = (dy: number) => [{ x: box.x + box.width / 2, y: box.y + box.height / 4 + dy }]
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) })
    for (let delta = 32; delta <= 288; delta += 32)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(delta) })
    await expect.poll(stream.fromEnd).toBeGreaterThan(200)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expectReadingHistory(stream)
  })
})

const bottomThumb = async (list: Locator) => {
  const thumb = await list.evaluate((node) => {
    const box = node.getBoundingClientRect()
    return {
      x: box.left + (node.clientWidth + box.width) / 2,
      y: box.bottom - 8,
      gutter: box.width - node.clientWidth
    }
  })
  expect(thumb.gutter).toBeGreaterThan(0)
  return thumb
}

const scrollbarTest = test.extend({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })

scrollbarTest.describe("native scrollbar", () => {
  scrollbarTest.skip(({ browserName }) => browserName !== "chromium", "Uses the Chromium scrollbar thumb geometry")

  scrollbarTest("a scrollbar drag through the end keeps control during a continuous reply", async ({ page }) => {
    const stream = await openStream(page, 1440, true)
    await expect.poll(stream.fromEnd).toBeLessThanOrEqual(1)
    const thumb = await bottomThumb(stream.list)
    await page.mouse.move(thumb.x, thumb.y)
    await page.mouse.down()
    await page.mouse.move(thumb.x, thumb.y - 24, { steps: 3 })
    await expectReadingHistory(stream)
    // Place the growing list exactly at its current end with the thumb still held.
    await stream.list.evaluate((node) => {
      node.scrollTop = node.scrollHeight
      node.dispatchEvent(new Event("scroll"))
    })
    await page.mouse.move(thumb.x, thumb.y - 32, { steps: 3 })
    await page.mouse.up()
    await expectReadingHistory(stream)
  })

  for (const width of [1440, 390])
    scrollbarTest(
      `releasing the scrollbar short of the end keeps the reading position at ${width}px`,
      async ({ page }) => {
        const { list, fromEnd } = await openHistory(page, width, true, 14)
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        await expect.poll(fromEnd).toBeLessThanOrEqual(1)
        const thumb = await bottomThumb(list)
        const y = thumb.y - 20
        const gapAfterPaint = () =>
          list.evaluate(
            (node) =>
              new Promise<number>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve(node.scrollHeight - node.scrollTop - node.clientHeight))
                )
              )
          )

        await page.mouse.move(thumb.x, y)
        await page.mouse.down()
        await page.mouse.move(thumb.x, y - 20)
        await expect.poll(fromEnd).toBeGreaterThan(48)
        // One thumb pixel moves by different distances at each width. Approach the end a pixel at a time.
        let gap = await fromEnd()
        for (let dy = 19; dy >= 0 && gap > 48; dy--) {
          await page.mouse.move(thumb.x, y - dy)
          gap = await gapAfterPaint()
        }
        expect(gap).toBeGreaterThan(5)
        expect(gap).toBeLessThanOrEqual(48)
        await page.mouse.up()
        expect(await gapAfterPaint()).toBe(gap)

        // A later offset change without user input leaves the reader in history.
        await page.waitForTimeout(350)
        await list.evaluate((node) => {
          node.scrollTop += 2
        })
        expect(await gapAfterPaint()).toBe(gap - 2)
      }
    )

  for (const width of [1440, 390])
    scrollbarTest(
      `releasing the scrollbar at the end resumes following a continuous reply at ${width}px`,
      async ({ page }) => {
        const stream = await openStream(page, width, true)
        const { list, fromEnd, height, generating } = stream
        await expect.poll(fromEnd).toBeLessThanOrEqual(1)
        const thumb = await bottomThumb(list)

        await page.mouse.move(thumb.x, thumb.y)
        await page.mouse.down()
        await page.mouse.move(thumb.x, thumb.y - 45, { steps: 3 })
        await expectReadingHistory(stream)

        await page.mouse.move(thumb.x, thumb.y + 60, { steps: 3 })
        await expect.poll(fromEnd, { intervals: [10, 20, 30], timeout: 1500 }).toBeLessThanOrEqual(1)
        await page.mouse.up()

        const releaseHeight = await height()
        await expect.poll(height).toBeGreaterThan(releaseHeight + 240)
        await expect(generating).toBeVisible()
        await expect.poll(fromEnd, { timeout: 1500 }).toBeLessThanOrEqual(1)
      }
    )
})
