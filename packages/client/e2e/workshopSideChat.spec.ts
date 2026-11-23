// The workshop beside a story (spec/WORKSHOP.md §4, W9). The second test keeps to 1440 and Chromium:
// two chats' sessions on one page, each regenerating, with a ReadPath fuse outside the renderer
// and heap/DOM samples (as splitRefresh.spec.ts). Run browsers in a memory-capped scope. All
// fixtures are synthetic.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import {
  makeStory,
  SIDE_ANSWER,
  sidePanel,
  useSideChatProvider,
  workshopSideChatBranchTests,
  workshopSideChatChangesTests,
  workshopSideChatEffectsTests,
  workshopSideChatTests
} from "./support/workshopSideChat.ts"
import { STORY_REPLY } from "./support/workshopProvider.ts"

workshopSideChatTests()
workshopSideChatEffectsTests()
workshopSideChatBranchTests()
workshopSideChatChangesTests()

/** Stop forwarding at the bound even if the renderer is too busy to run an assertion. */
const readFuse = async (page: Page) => {
  const stats = { armed: false, reads: 0, tripped: false, slotFrames: 0, replay: false }
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    let closed = false
    socket.onClose(() => {
      closed = true
    })
    socket.onMessage((message) => {
      const pathRead = /"tag"\s*:\s*"ReadPath"/.test(message.toString())
      if (stats.armed) {
        // One WebSocket frame can batch several RPC requests.
        stats.reads += message.toString().match(/"tag"\s*:\s*"ReadPath"/g)?.length ?? 0
        if (stats.reads > 24) stats.tripped = true
      }
      if (stats.tripped) {
        socket.close({ code: 1008, reason: "ReadPath regression bound" })
        upstream.close()
      } else if (stats.armed && stats.replay && pathRead) {
        // Let another event arrive while a path read is outstanding, deterministically.
        setTimeout(() => {
          if (!closed && !stats.tripped) upstream.send(message)
        }, 250)
      } else upstream.send(message)
    })
    upstream.onMessage((message) => {
      if (stats.armed && message.toString().includes('"_tag":"Slot"')) stats.slotFrames++
      socket.send(message)
      // Reconnects may deliver an event again. Both deliveries must have finite replays.
      if (stats.armed && stats.replay && message.toString().includes('"_tag":"Slot"')) socket.send(message)
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
    await storyReply.getByRole("button", { name: "Generate another swipe", exact: true }).click()
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
    await answer.getByRole("button", { name: "Generate another swipe", exact: true }).click()
    await expect.poll(() => stats.slotFrames).toBeGreaterThan(0)
    await steady(page, stats, "workshop")
    await expect(side.getByRole("article")).toHaveCount(sideCount)
    await expect(storyList.getByRole("article")).toHaveCount(storyCount)
    await expect(storyList.getByText(SIDE_ANSWER)).toHaveCount(0)
    expect(stats.tripped).toBe(false)

    // The former replay loop needs shared messages shown on another branch, and an event
    // during an outstanding read. A last-message swipe on the same fork never exercised it.
    stats.armed = false
    const forks = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const child = (chatId: typeof story.id) =>
          Effect.gen(function* () {
            const chat = yield* api.GetChat({ chatId })
            return yield* api.CreateFork({ chatId, fromForkId: chat.currentForkId, atSlotId: chat.activeLeafSlotId })
          })
        return [yield* child(story.id), yield* child(workshop.id)] as const
      })
    )
    await page.goto(
      `${server().url}/chats/${story.id}?fork=${story.currentForkId}&panel=workshop&workshop=${workshop.id}&side.fork=${workshop.currentForkId}`
    )
    await expect(storyList.getByRole("article").filter({ hasText: STORY_REPLY })).toHaveCount(1)
    await expect(side.getByRole("article").filter({ hasText: SIDE_ANSWER })).toHaveCount(1)
    stats.replay = true
    for (const [index, chat] of [story, workshop].entries()) {
      stats.reads = 0
      stats.slotFrames = 0
      stats.armed = true
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: chat.id,
            forkId: forks[index]!.fork.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })
          const entry = path.entries.at(-1)!
          yield* api.Regenerate({
            slotId: entry.slotId,
            forkId: forks[index]!.fork.id,
            expectedRowVersion: entry.rowVersion
          })
        })
      )
      await expect.poll(() => stats.reads).toBeGreaterThan(0)
      await page.waitForTimeout(1500)
      await steady(page, stats, index === 0 ? "story-other-branch" : "workshop-other-branch")
      await expect(storyList.getByRole("article")).toHaveCount(storyCount)
      await expect(side.getByRole("article")).toHaveCount(sideCount)
      stats.armed = false
    }
  })
})
