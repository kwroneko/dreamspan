import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { chromium, expect, type Locator, type Page, test as base } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { messageMenu } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"
import { asPage } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const paragraph = (n: number) => `On watch at the lighthouse, log entry ${n}.`

const test = base.extend<{
  initialParagraphs: number
  provider: { baseUrl: string; append: (first: number, last: number) => void; finish: () => void }
}>({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--enable-blink-features=MiddleClickAutoscroll"]
  },
  initialParagraphs: [40, { option: true }],
  provider: async ({ initialParagraphs }, runTest) => {
    let reply: ServerResponse
    let requests = 0
    const chunk = (delta: object, finishReason: "stop" | null = null) => {
      reply.write(
        `data: ${JSON.stringify({
          id: `scrollbar-follow-${requests}`,
          object: "chat.completion.chunk",
          model: "synthetic",
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        })}\n\n`
      )
    }
    const append = (first: number, last: number) => {
      const content = Array.from({ length: last - first + 1 }, (_, i) => `${paragraph(first + i)}\n\n`).join("")
      chunk({ content })
    }
    const upstream = createServer((request, response) => {
      if (request.url !== "/v1/chat/completions") return response.writeHead(404).end()
      request.resume().on("end", () => {
        reply = response
        reply.writeHead(200, { "content-type": "text/event-stream" })
        requests++
        chunk({ role: "assistant" })
        append(1, requests === 1 ? initialParagraphs : 60)
      })
    })
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done))
    const { port } = upstream.address() as AddressInfo
    try {
      await runTest({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        append,
        finish: () => {
          chunk({}, "stop")
          reply.end("data: [DONE]\n\n")
        }
      })
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>((done) => upstream.close(() => done()))
    }
  }
})

test.skip(({ browserName }) => browserName !== "chromium", "Uses Chromium's native scrollbar thumb")
const viewportWidth = Number(process.env.FOLLOW_TEST_WIDTH ?? 1440)
test.use({ viewport: { width: viewportWidth, height: 850 } })

const openStream = async (page: Page, baseUrl: string, initialParagraphs = 40, fromHome = false) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chatId, lastSlot, otherId } = await asPage(page, server(), (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "synthetic", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      const other = yield* api.CreateChat({ title: "Other chat" })
      const chat = yield* api.CreateChat({ title: "Streaming chat" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Keep watch."
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      return { chatId: chat.id, lastSlot: sent.entry.slotId, otherId: other.id }
    })
  )
  if (fromHome) {
    await page.goto(server().url)
    if (page.viewportSize()?.width === 390)
      await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    await page.locator(`a[data-chat-id="${chatId}"]:visible`).click()
  } else {
    await page.goto(`${server().url}/chats/${chatId}`)
  }
  const list = page.getByTestId("messages")
  await expect(list.getByText("Keep watch.")).toBeVisible()
  await asPage(page, server(), (api) => api.Generate({ chatId, parentSlotId: lastSlot, branch: false }))
  const reply = list.getByRole("article", { name: "Reply" })
  await expect(reply).toContainText(paragraph(initialParagraphs))
  const fromEnd = () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
  await expect.poll(fromEnd).toBeLessThanOrEqual(2)
  return { chatId, list, reply, fromEnd, otherId }
}

const grabThumb = async (page: Page, list: Locator) => {
  const { x, y, gutter } = await list.evaluate((node) => {
    const box = node.getBoundingClientRect()
    return { x: box.right - 4, y: box.bottom - 8, gutter: box.width - node.clientWidth }
  })
  expect(gutter).toBeGreaterThan(4)
  await page.mouse.move(x, y)
  await page.mouse.down()
  return { x, y }
}

const dragUp = async (page: Page, list: Locator) => {
  const { x, y } = await grabThumb(page, list)
  await page.mouse.move(x, y - 80)
  return { x, y }
}

for (const width of [1440, 390]) {
  test(`grabbing the stationary thumb keeps following reply growth at ${width}px`, async ({ page, provider }) => {
    await page.setViewportSize({ width, height: 850 })
    const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
    // Let initial positioning and its history save settle before grabbing the native thumb.
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await expect.poll(() => page.evaluate(() => history.state?.chatReading?.slot)).toBeNull()
    await grabThumb(page, list)

    provider.append(41, 41)
    await expect(reply).toContainText(paragraph(41))
    const heldGap = await list.evaluate(
      (node) =>
        new Promise<number>((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => done(node.scrollHeight - node.scrollTop - node.clientHeight))
          )
        )
    )
    await page.mouse.up()

    provider.append(42, 70)
    await expect(reply).toContainText(paragraph(70))
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    expect(heldGap).toBeLessThanOrEqual(2)
  })

  test(`Back returns to the end after a stationary thumb release resumes follow at ${width}px`, async ({
    page,
    provider
  }) => {
    await page.setViewportSize({ width, height: 850 })
    const { chatId, list, reply, fromEnd, otherId } = await openStream(page, provider.baseUrl)
    const { x, y } = await dragUp(page, list)
    await expect.poll(fromEnd).toBeGreaterThan(100)
    await page.mouse.up()
    // The completed drag saved the article. The next drag replaces it on stationary release.
    const slot = await reply.getAttribute("data-slot")
    expect(slot).toBeTruthy()
    await expect.poll(() => page.evaluate(() => history.state?.chatReading?.slot)).toBe(slot)
    await page.mouse.down()
    await page.mouse.move(x, y + 30)
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await page.mouse.up()
    await expect.poll(() => endMarker(page)).toBeNull()

    if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
    await page.locator(`a[data-chat-id="${otherId}"]:visible`).click()
    await expect(page.getByRole("heading", { name: "Other chat" })).toBeVisible()

    provider.append(41, 70)
    provider.finish()
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
    await expect(reply).toContainText(paragraph(70))
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
  })
}

test("releasing a thumb held at the end resumes follow after reply growth", async ({ page, provider }) => {
  const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
  const { x, y } = await dragUp(page, list)
  await expect.poll(fromEnd).toBeGreaterThan(100)
  await page.mouse.move(x, y)
  await expect.poll(fromEnd).toBeLessThanOrEqual(1)
  const held = await list.evaluate((node) => node.scrollTop)

  provider.append(41, 41)
  await expect(reply).toContainText(paragraph(41))
  await expect.poll(fromEnd).toBeGreaterThan(20)
  expect(await list.evaluate((node) => node.scrollTop)).toBe(held)
  await page.mouse.up()

  provider.append(42, 70)
  await expect(reply).toContainText(paragraph(70))
  await expect.poll(fromEnd).toBeLessThanOrEqual(2)
})

test("releasing the thumb at the fractional native end follows at 80% zoom and device scale 2", async ({
  provider
}) => {
  // Chrome settings require a persistent context. An empty profile path creates a temporary one.
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    ignoreDefaultArgs: ["--hide-scrollbars"],
    viewport: { width: viewportWidth, height: 850 },
    deviceScaleFactor: 2
  })
  try {
    const page = context.pages()[0]!
    await page.goto("chrome://settings/appearance")
    await page.getByRole("combobox", { name: "Page zoom" }).selectOption({ label: "80%" })
    const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
    expect(await page.evaluate(() => devicePixelRatio)).toBeCloseTo(1.6)
    // Find a fractional viewport height where the browser's clamped offset and its
    // rounded height readings disagree by more than one CSS pixel.
    const nativeGap = await list.evaluate((node) => {
      node.style.flex = "none"
      for (let step = 0; step <= 64; step++) {
        node.style.height = `${486 + step / 16}px`
        node.scrollTop = node.scrollHeight
        const gap = node.scrollHeight - node.scrollTop - node.clientHeight
        if (gap > 1 && gap <= 2) return gap
      }
      return 0
    })
    expect(nativeGap).toBeGreaterThan(1)
    const { x, y } = await dragUp(page, list)
    await expect.poll(fromEnd).toBeGreaterThan(100)
    await page.mouse.move(x, y + 30)
    await expect.poll(fromEnd).toBe(nativeGap)
    await page.mouse.up()

    provider.append(41, 70)
    await expect(reply).toContainText(paragraph(70))
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
  } finally {
    await context.close()
  }
})

test("Back restores a short scrollbar release while the reply grows in another chat", async ({ page, provider }) => {
  const { chatId, list, reply, fromEnd, otherId } = await openStream(page, provider.baseUrl)
  const { x, y } = await dragUp(page, list)
  await expect.poll(fromEnd).toBeGreaterThan(100)
  // Approach the end a thumb pixel at a time to land inside the former 48 px bottom range.
  for (let dy = 20; dy >= 0; dy--) {
    await page.mouse.move(x, y - dy)
    await list.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    if ((await fromEnd()) <= 26) break
  }
  await page.mouse.up()
  const gap = await fromEnd()
  expect(gap).toBeGreaterThan(18)
  expect(gap).toBeLessThanOrEqual(26)
  const offset = () =>
    reply.evaluate(
      (node) => node.getBoundingClientRect().top - node.closest('[data-testid="messages"]')!.getBoundingClientRect().top
    )
  const before = await offset()
  // Wait for the debounced history write before switching chats.
  await page.waitForTimeout(250)
  expect(await fromEnd()).toBe(gap)
  if (page.viewportSize()?.width === 390)
    await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
  await page.locator(`a[data-chat-id="${otherId}"]:visible`).click()
  await expect(page.getByRole("heading", { name: "Other chat" })).toBeVisible()

  provider.append(41, 120)
  provider.finish()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
  await expect(reply).toContainText(paragraph(120))
  await expect.poll(offset).toBeCloseTo(before, 0)
})

const endMarker = (page: Page) => page.evaluate(() => history.state?.chatReading?.slot)

const pressShiftTrack = async (page: Page, list: Locator) => {
  const { x, y, bottom, gutter } = await list.evaluate((node) => {
    const box = node.getBoundingClientRect()
    return {
      x: box.right - 4,
      y: box.top + box.height / 5,
      bottom: box.bottom - 2,
      gutter: box.width - node.clientWidth
    }
  })
  expect(gutter).toBeGreaterThan(4)
  await page.mouse.move(x, y)
  await page.keyboard.down("Shift")
  await page.mouse.down()
  return { x, bottom }
}

for (const width of [1440, 390]) {
  test(`a Shift-track press dragged back to the end resumes follow at ${width}px`, async ({ page, provider }) => {
    await page.setViewportSize({ width, height: 850 })
    const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
    await expect.poll(() => endMarker(page)).toBeNull()

    const { x, bottom } = await pressShiftTrack(page, list)
    await expect.poll(fromEnd).toBeGreaterThan(300)
    await page.mouse.move(x, bottom, { steps: 8 })
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await page.mouse.up()
    await page.keyboard.up("Shift")
    await expect(reply.getByText(paragraph(40), { exact: true })).toBeInViewport()
    // Let the released gesture settle before sending the next burst.
    await page.waitForTimeout(300)

    provider.append(41, 100)
    await expect(reply).toContainText(paragraph(100))
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await expect(reply.getByText(paragraph(100), { exact: true })).toBeInViewport()
  })

  test(`a Shift-track click released in history keeps its reading position at ${width}px`, async ({
    page,
    provider
  }) => {
    await page.setViewportSize({ width, height: 850 })
    const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
    await expect.poll(() => endMarker(page)).toBeNull()

    await pressShiftTrack(page, list)
    await expect.poll(fromEnd).toBeGreaterThan(300)
    await page.mouse.up()
    await page.keyboard.up("Shift")
    await expect.poll(() => endMarker(page)).toEqual(expect.any(String))
    const offset = await list.evaluate((node) => node.scrollTop)

    provider.append(41, 100)
    await expect(reply).toContainText(paragraph(100))
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeCloseTo(offset, 0)
    expect(await fromEnd()).toBeGreaterThan(300)
  })
}

test("fp6 #1: a native scrollbar track click keeps its place when a reply grows on press", async ({
  page,
  provider
}) => {
  const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
  await expect.poll(() => endMarker(page)).toBeNull()
  const track = await list.evaluate((node) => {
    const box = node.getBoundingClientRect()
    node.addEventListener(
      "pointerdown",
      () => {
        // Deliver reply growth between the app's pointerdown and the native page scroll.
        const before = node.scrollHeight
        const content = node.firstElementChild as HTMLElement
        content.style.height = `${content.offsetHeight + 16}px`
        node.dataset.growthOnPress = String(node.scrollHeight - before)
      },
      { once: true }
    )
    return { x: box.right - 4, y: box.top + box.height / 5, gutter: box.width - node.clientWidth }
  })
  expect(track.gutter).toBeGreaterThan(4)
  await page.mouse.click(track.x, track.y)
  await expect(list).toHaveAttribute("data-growth-on-press", "16")
  await expect.poll(fromEnd).toBeGreaterThan(200)
  await expect.poll(() => endMarker(page)).toBe(await reply.getAttribute("data-slot"))
  const offset = await list.evaluate((node) => node.scrollTop)

  provider.append(41, 70)
  await expect(reply).toContainText(paragraph(70))
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeCloseTo(offset, 0)
  expect(await fromEnd()).toBeGreaterThan(200)
})

test("fp6 #2: browser Forward restores a wheel movement immediately followed by Back to Home", async ({
  page,
  provider
}) => {
  const { chatId, list, reply, fromEnd } = await openStream(page, provider.baseUrl, 40, true)
  await expect.poll(() => endMarker(page)).toBeNull()
  await list.hover()
  const outgoing = await list.evaluateHandle((node) => ({
    captured: new Promise<{ offset: number; slot: string | null }>((resolve) => {
      const back = () => {
        if (node.scrollHeight - node.clientHeight - node.scrollTop < 200) return
        node.removeEventListener("scroll", back)
        const reply = node.querySelector('article[aria-label="Reply"]')!
        resolve({
          offset: reply.getBoundingClientRect().top - node.getBoundingClientRect().top,
          slot: history.state?.chatReading?.slot
        })
        // Start the browser traversal on the wheel's own scroll, before the reading save.
        history.back()
      }
      node.addEventListener("scroll", back)
    })
  }))
  await page.mouse.wheel(0, -320)
  await expect(page).toHaveURL((url) => url.pathname === "/")
  const before = await outgoing.evaluate((reading) => reading.captured)
  expect(before.slot).toBeNull()

  provider.append(41, 100)
  provider.finish()
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
  await expect(reply).toContainText(paragraph(100))
  await expect.poll(fromEnd).toBeGreaterThan(200)
  await expect
    .poll(() =>
      reply.evaluate(
        (node) =>
          node.getBoundingClientRect().top - node.closest('[data-testid="messages"]')!.getBoundingClientRect().top
      )
    )
    .toBeCloseTo(before.offset, 0)
})

test.describe("latest message link", () => {
  const initialParagraphs = 12
  // Keep the end visible even after the composer and its footer finish laying out.
  test.use({ initialParagraphs, viewport: { width: viewportWidth, height: 1000 } })

  test("fp6 #3: Send follows a new reply from a message link with the end visible", async ({ page, provider }) => {
    const { chatId, list, reply, fromEnd } = await openStream(page, provider.baseUrl, initialParagraphs)
    provider.finish()
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    const slot = await reply.getAttribute("data-slot")
    await page.goto(`${server().url}/chats/${chatId}?slot=${slot}`)
    await expect(reply.getByText(paragraph(initialParagraphs), { exact: true })).toBeInViewport()
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check the next light.")
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await page.getByRole("button", { name: "Send", exact: true }).click()

    const next = list.getByRole("article", { name: "Reply" }).last()
    await expect(next).toContainText(paragraph(60))
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await expect(next.getByText(paragraph(60), { exact: true })).toBeInViewport()
  })
})

test("fp5 #1: a wheel toward the end ignores a transient layout clamp", async ({ page, provider }) => {
  const { list, reply, fromEnd } = await openStream(page, provider.baseUrl)
  await list.hover()
  await expect.poll(() => endMarker(page)).toBeNull()
  // Run the layout change after the app sees wheel-down, before the scroll event observes the clamp.
  await list.evaluate((node) => {
    node.addEventListener(
      "wheel",
      () => {
        const before = node.scrollTop
        const height = node.clientHeight
        const style = node.style.cssText
        node.style.flex = "none"
        node.style.height = `${height + 200}px`
        const clamped = node.scrollTop
        node.style.cssText = style
        node.dataset.clamp = String(before - clamped)
      },
      { once: true }
    )
  })
  await page.mouse.wheel(0, 20)
  await expect(list).toHaveAttribute("data-clamp", "200")
  await page.waitForTimeout(250)
  provider.append(41, 70)
  await expect(reply).toContainText(paragraph(70))
  await expect.poll(fromEnd).toBeLessThanOrEqual(2)
})

test.describe("composition toolbar", () => {
  test.use({ initialParagraphs: 3 })

  test("fp5 #2: clicking Swipe shown padding keeps following a reply started in another tab", async ({
    page,
    context,
    provider
  }) => {
    const { chatId, list, reply, fromEnd } = await openStream(page, provider.baseUrl, 3)
    const slot = (await reply.getAttribute("data-slot")) as SlotId
    provider.finish()
    await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
    const peer = await context.newPage()
    await page.bringToFront()
    await list.hover()
    await page.mouse.wheel(0, 20)
    await expect.poll(() => endMarker(page)).toBeNull()
    await messageMenu(reply, "Write your own swipe")
    const toolbar = list.getByRole("region", { name: "Swipe shown" }).locator(":scope > div").first()
    await expect(toolbar).toBeInViewport()
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await toolbar.click({ position: { x: 4, y: 4 } })

    await expect.poll(() => endMarker(page)).toBeNull()
    await asPage(peer, server(), (api) => api.Generate({ chatId, parentSlotId: slot, branch: false }))
    const next = list.getByRole("article", { name: "Reply" }).last()
    await expect(next).toContainText(paragraph(60))
    await expect.poll(fromEnd).toBeLessThanOrEqual(2)
    await expect.poll(() => endMarker(page)).toBeNull()
  })
})

test("fp5 #3: native middle-click autoscroll continues after release until canceled", async ({ page, provider }) => {
  const { list, fromEnd } = await openStream(page, provider.baseUrl)
  await expect.poll(() => endMarker(page)).toBeNull()
  const box = (await list.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height * 0.65
  await page.mouse.click(x, y, { button: "middle" })
  await page.mouse.move(x, y - 100)
  await expect.poll(fromEnd).toBeGreaterThan(200)
  await page.mouse.click(x, y - 100)
  const stopped = await list.evaluate((node) => node.scrollTop)
  await expect.poll(() => endMarker(page)).not.toBeNull()
  provider.append(41, 70)
  await expect(list.getByText(paragraph(70), { exact: true })).toBeAttached()
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeCloseTo(stopped, 0)
})

test("fp5 #4: Back restores a wheel movement immediately followed by a sidebar click at 1440px", async ({
  page,
  provider
}) => {
  const { chatId, list, reply, fromEnd, otherId } = await openStream(page, provider.baseUrl)
  await expect.poll(() => endMarker(page)).toBeNull()
  const link = page.locator(`a[data-chat-id="${otherId}"]:visible`)
  await expect(link).toBeVisible()
  const box = (await link.boundingBox())!
  await list.hover()
  const outgoing = await page.evaluateHandle(
    ({ x, y }) => {
      const link = document.elementFromPoint(x, y)?.closest("a")
      return {
        captured: new Promise<{ gap: number; offset: number; slot: string | null }>((resolve) => {
          link?.addEventListener(
            "click",
            () => {
              const list = document.querySelector('[data-testid="messages"]')!
              const reply = list.querySelector('article[aria-label="Reply"]')!
              resolve({
                gap: list.scrollHeight - list.clientHeight - list.scrollTop,
                offset: reply.getBoundingClientRect().top - list.getBoundingClientRect().top,
                slot: history.state?.chatReading?.slot
              })
            },
            { capture: true, once: true }
          )
        })
      }
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  )
  await page.mouse.wheel(0, -280)
  await page.waitForFunction(() => {
    const list = document.querySelector('[data-testid="messages"]')!
    return list.scrollHeight - list.clientHeight - list.scrollTop > 200
  })
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const before = await outgoing.evaluate((reading) => reading.captured)
  expect(before.gap).toBeGreaterThan(200)
  expect(before.slot).toBeNull()
  await expect(page.getByRole("heading", { name: "Other chat" })).toBeVisible()

  provider.append(41, 70)
  provider.finish()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
  await expect(reply).toContainText(paragraph(70))
  await expect.poll(fromEnd).toBeGreaterThan(200)
  await expect
    .poll(() =>
      reply.evaluate(
        (node) =>
          node.getBoundingClientRect().top - node.closest('[data-testid="messages"]')!.getBoundingClientRect().top
      )
    )
    .toBeCloseTo(before.offset, 0)
})

test("fp5 #5: Back within a chat restores the saved end of a message link", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chatId, linked, hit, last } = await asPage(page, server(), (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Same chat history" })
      let parent: SlotId | null = null
      let linked: SlotId | null = null
      let hit: SlotId | null = null
      for (let i = 1; i <= 25; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Ledger ${i}. ${i === 7 ? "Amber telescope. " : ""}${"The next boat passed the lighthouse. ".repeat(20)}`
        })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        parent = sent.entry.slotId
        if (i === 4) linked = parent
        if (i === 7) hit = parent
      }
      return { chatId: chat.id, linked: linked!, hit: hit!, last: parent! }
    })
  )
  await page.goto(`${server().url}/chats/${chatId}?slot=${linked}`)
  const list = page.getByTestId("messages")
  await expect(list.locator(`article[data-slot="${linked}"]`)).toBeInViewport()
  await list.hover()
  const gap = () => list.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 1800)
      return gap()
    })
    .toBeLessThanOrEqual(2)
  await expect.poll(() => endMarker(page)).toBeNull()

  await openPanel(page, "History edits")
  const panel = page.locator("[data-history-panel]")
  await panel.getByRole("textbox", { name: "Find", exact: true }).fill("Amber telescope")
  await panel.getByRole("button", { name: "Next", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`slot=${hit}`))
  await expect(list.locator(`article[data-slot="${hit}"]`)).toBeInViewport()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`slot=${linked}`))
  await expect
    .poll(() => list.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThanOrEqual(2)
  await expect(list.locator(`article[data-slot="${last}"]`)).toBeInViewport()
})
