// The workshop beside a story (spec/WORKSHOP.md §4, W9). The second test keeps to 1440 and Chromium:
// two chats' sessions on one page, each regenerating, with a ReadPath fuse outside the renderer
// and heap/DOM samples (as splitRefresh.spec.ts). Run browsers in a memory-capped scope. All
// fixtures are synthetic.
import { expect, type Page, test } from "@playwright/test"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import {
  makeStory,
  SIDE_ANSWER,
  sidePanel,
  useSideChatProvider,
  workshopSideChatTests
} from "./support/workshopSideChat.ts"
import { STORY_REPLY } from "./support/workshopProvider.ts"

workshopSideChatTests()

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

const steady = async (page: Page, stats: Awaited<ReturnType<typeof readFuse>>, label: string) => {
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
    await test.info().attach(`side-chat-${label}-read-memory-samples`, {
      body: JSON.stringify({ stats, samples }, null, 2),
      contentType: "application/json"
    })
  } finally {
    await cdp.detach()
  }
}

test.describe("two chats on one page", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Heap and DOM counters require Chromium CDP")
  const server = serverPerFile(withAdmin)
  useSideChatProvider(server)

  test("regenerating in the story or the workshop beside it reads a bounded number of times at 1440", async ({
    page
  }) => {
    test.setTimeout(150_000)
    const story = await makeStory(server, "Synthetic two sessions")
    const workshop = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.CreateWorkshop({ attachTo: story.id })
    )
    const stats = await readFuse(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${story.id}?panel=workshop&workshop=${workshop.id}`)
    const storyList = page.getByTestId("messages")
    const side = sidePanel(page).locator(`[data-side-chat="${workshop.id}"]`)
    await expect(storyList.getByRole("article").filter({ hasText: STORY_REPLY })).toHaveCount(1, {
      timeout: 30_000
    })
    await side.getByLabel("Message", { exact: true }).fill("Who is in the story?")
    await side.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1, { timeout: 60_000 })
    const sideCount = await side.getByRole("article").count()
    const storyCount = await storyList.getByRole("article").count()

    // The story's reply again: the workshop's list doesn't hear it.
    const storyReply = storyList.getByRole("article").filter({ hasText: STORY_REPLY })
    await showActions(storyReply)
    stats.armed = true
    await storyReply.getByRole("button", { name: "Generate another version", exact: true }).click()
    await expect.poll(() => stats.slotFrames).toBeGreaterThan(0)
    await steady(page, stats, "story")
    await expect(storyList.getByRole("article")).toHaveCount(storyCount)
    await expect(side.getByRole("article")).toHaveCount(sideCount)
    await expect(side.getByText(STORY_REPLY)).toHaveCount(0)

    // The workshop's answer again: the story's list doesn't hear it.
    stats.reads = 0
    stats.slotFrames = 0
    const answer = side.getByRole("article").filter({ hasText: SIDE_ANSWER })
    await showActions(answer)
    await answer.getByRole("button", { name: "Generate another version", exact: true }).click()
    await expect.poll(() => stats.slotFrames).toBeGreaterThan(0)
    await steady(page, stats, "workshop")
    await expect(side.getByRole("article")).toHaveCount(sideCount)
    await expect(storyList.getByRole("article")).toHaveCount(storyCount)
    await expect(storyList.getByText(SIDE_ANSWER)).toHaveCount(0)
    expect(stats.tripped).toBe(false)
  })
})
