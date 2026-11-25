import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { chromium, expect, type Locator, type Page, test as base } from "@playwright/test"
import { Effect } from "effect"
import { asPage } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const paragraph = (n: number) => `On watch at the lighthouse, log entry ${n}.`

const test = base.extend<{
  provider: { baseUrl: string; append: (first: number, last: number) => void; finish: () => void }
}>({
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  provider: async ({}, runTest) => {
    let reply: ServerResponse
    const chunk = (delta: object, finishReason: "stop" | null = null) => {
      reply.write(
        `data: ${JSON.stringify({
          id: "scrollbar-follow",
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
        chunk({ role: "assistant" })
        append(1, 40)
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
test.use({ viewport: { width: 1440, height: 850 } })

const openStream = async (page: Page, baseUrl: string) => {
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
  await page.goto(`${server().url}/chats/${chatId}`)
  const list = page.getByTestId("messages")
  await expect(list.getByText("Keep watch.")).toBeVisible()
  await asPage(page, server(), (api) => api.Generate({ chatId, parentSlotId: lastSlot, branch: false }))
  const reply = list.getByRole("article", { name: "Reply" })
  await expect(reply).toContainText(paragraph(40))
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
    await page.mouse.move(x, y)
    await expect.poll(fromEnd).toBeLessThanOrEqual(1)

    // Let the scroll's history write capture the article while the drag is still active.
    const slot = await reply.getAttribute("data-slot")
    expect(slot).toBeTruthy()
    await expect.poll(() => page.evaluate(() => history.state?.chatReading?.slot)).toBe(slot)
    await page.mouse.up()

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
    viewport: { width: 1440, height: 850 },
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
  await page.locator(`a[data-chat-id="${otherId}"]`).click()
  await expect(page.getByRole("heading", { name: "Other chat" })).toBeVisible()

  provider.append(41, 120)
  provider.finish()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chats/${chatId}`))
  await expect(reply).toContainText(paragraph(120))
  await expect.poll(offset).toBeCloseTo(before, 0)
})
