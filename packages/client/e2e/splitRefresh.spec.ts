// Keep this at 1440: protocol/memory regression, with a request fuse outside the renderer.
// Run browsers in a memory-capped scope as well. All fixtures are synthetic.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider, STORY_REPLY, WORKSHOP_ANSWER, WORKSHOP_FIRST } from "./support/workshopProvider.ts"

test.skip(({ browserName }) => browserName !== "chromium", "Heap and DOM counters require Chromium CDP")

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

test.beforeAll(async () => {
  provider = await startWorkshopProvider()
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          providerSettings: { toolLoading: "every" },
          name: "Synthetic split regression",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

/** Stop forwarding at the bound even if the renderer is too busy to run an assertion. */
const readFuse = async (page: Page) => {
  const stats = { armed: false, reads: 0, tripped: false, slotFrames: 0 }
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((message) => {
      if (stats.armed) {
        // One WebSocket frame can batch several RPC requests.
        stats.reads += message.toString().match(/"tag"\s*:\s*"ReadPath"/g)?.length ?? 0
        if (stats.reads > 24) stats.tripped = true
      }
      if (stats.tripped) {
        socket.close({ code: 1008, reason: "ReadPath regression bound" })
        upstream.close()
      } else upstream.send(message)
    })
    upstream.onMessage((message) => {
      if (stats.armed && message.toString().includes('"_tag":"Slot"')) stats.slotFrames++
      socket.send(message)
    })
  })
  return stats
}

const steady = async (page: Page, stats: Awaited<ReturnType<typeof readFuse>>) => {
  const cdp = await page.context().newCDPSession(page)
  const samples: Array<{ heap: number; nodes: number; reads: number }> = []
  try {
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500)
      expect(stats.tripped).toBe(false)
      await cdp.send("HeapProfiler.collectGarbage")
      const heap = await cdp.send("Runtime.getHeapUsage")
      const dom = await cdp.send("Memory.getDOMCounters")
      samples.push({ heap: heap.usedSize, nodes: dom.nodes, reads: stats.reads })
    }
    expect(stats.reads).toBeLessThanOrEqual(24)
    expect(samples.at(-1)!.reads - samples[0]!.reads).toBeLessThanOrEqual(2)
    expect(samples.at(-1)!.heap).toBeLessThan(samples[0]!.heap + 4 * 1024 * 1024)
    expect(samples.at(-1)!.nodes).toBeLessThan(samples[0]!.nodes + 200)
    await test.info().attach("split-read-memory-samples", {
      body: JSON.stringify({ stats, samples }, null, 2),
      contentType: "application/json"
    })
  } finally {
    await cdp.detach()
  }
}

test("swiping an earlier workshop reply keeps bounded reads, heap and DOM at 1440", async ({ page }) => {
  test.setTimeout(120_000)
  const stats = await readFuse(page)
  const workshop = await admin((api) =>
    api.CreateWorkshop({
      title: "Synthetic split regression",
      grants: [
        { capability: "library.cards", mode: "allow" },
        { capability: "library.presets", mode: "allow" }
      ]
    })
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${workshop.id}`)
  await page.getByLabel("Message", { exact: true }).fill("Make me a lighthouse keeper.")
  await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
  await expect(page.getByRole("article").filter({ hasText: WORKSHOP_ANSWER })).toHaveCount(1, { timeout: 60_000 })
  const opening = page.getByRole("article").filter({ hasText: WORKSHOP_FIRST })
  // Clean changes on the newest reply are reverted automatically. Make this reply earlier
  // in the chat so the swipe can keep its changes and branch from its parent.
  const later = "A later workshop message."
  await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: workshop.id })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: later })
    })
  )
  await expect(page.getByRole("article").filter({ hasText: later })).toBeVisible()
  await showActions(opening)
  stats.armed = true
  await opening.getByRole("button", { name: "Generate another swipe", exact: true }).click()
  const warning = page.getByRole("dialog", { name: "This reply changed things outside the chat" })
  await expect(warning).toBeVisible()
  await warning.getByRole("button", { name: "Keep & swipe", exact: true }).click()
  await expect.poll(() => stats.slotFrames).toBeGreaterThan(0)
  await steady(page, stats)
  await page.getByRole("button", { name: "Chat panel", exact: true }).first().click()
  await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
  expect(stats.tripped).toBe(false)
})

test("story tabs on different branches can regenerate an earlier shared message at 1440", async ({ page, context }) => {
  test.setTimeout(120_000)
  const fixture = await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Synthetic story branches" })
      const first = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Synthetic opening."
      })
      if (first._tag !== "Posted") return yield* Effect.die("unexpected queue")
      const last = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "Synthetic ending."
      })
      if (last._tag !== "Posted") return yield* Effect.die("unexpected queue")
      const child = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId,
        atSlotId: last.entry.slotId
      })
      return { chat, child: child.fork }
    })
  )
  const other = await context.newPage()
  const original = await readFuse(page)
  const changed = await readFuse(other)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const [tab, fork] of [
    [page, fixture.chat.currentForkId],
    [other, fixture.child.id]
  ] as const) {
    await tab.setViewportSize({ width: 1440, height: 900 })
    await tab.goto(`${server().url}/chats/${fixture.chat.id}?fork=${fork}`)
    await expect(tab.getByRole("article").filter({ hasText: "Synthetic ending." })).toHaveCount(1)
  }
  original.armed = changed.armed = true
  const opening = other.getByRole("article").filter({ hasText: "Synthetic opening." })
  // Human-written turns offer this in More actions; model replies use the version arrow.
  await messageMenu(opening, "Generate a swipe")
  await expect(other.getByRole("article").filter({ hasText: STORY_REPLY })).toHaveCount(1)
  await expect.poll(() => original.reads).toBeGreaterThan(0)
  await expect(page.getByRole("article").filter({ hasText: "Synthetic opening." })).toHaveCount(1)
  await expect(page.getByRole("article").filter({ hasText: "Synthetic ending." })).toHaveCount(1)
  await steady(page, original)
  expect(changed.tripped).toBe(false)
  await other.close()
})
