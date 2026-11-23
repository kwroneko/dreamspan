// The space between the last message and the composer stays put while typing (owner,
// 2026-11-23: "It twitches every character typed", more often in guidance mode). Every
// animation frame while 40 characters are typed into text that takes several lines, the gap
// from the last message's bottom to the composer's top is measured, at the bottom of a chat
// that scrolls, with and without a slow connection, for a message, for guidance, and for a new
// version's guidance after a reload with it open.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { setGuidance } from "./support/composer.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let cookie: string
const rpc = <A>(run: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, run)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider()
  await rpc((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic gap",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "synthetic"
      })
      yield* api.RefreshModels({ connectionId: connection.id })
      const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: models[0]!.id }, preset: null }
      })
    })
  )
})
test.afterAll(async () => {
  await provider?.stop()
})

/** A chat long enough to scroll, ending with Aria's reply written with guidance. */
const longChat = () =>
  rpc((api) =>
    Effect.gen(function* () {
      const aria = (yield* api.CreateCard({ label: "Aria", name: "Aria" })).entityId
      const sam = (yield* api.CreateCard({ label: "Sam", name: "Sam" })).entityId
      const chat = yield* api.CreateChat({ title: "Harbor at dusk" })
      for (const id of [aria, sam])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [sam] } })
      let parent = null as Parameters<typeof api.SendMessage>[0]["parentSlotId"]
      for (let i = 0; i < 14; i++) {
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Line ${i}. The tide rolls in over the old stones.\n\nMore of line ${i}.`,
          speakerEntityId: sam
        })
        if (sent._tag !== "Posted") throw new Error("Expected a posted message")
        parent = sent.entry.slotId
      }
      const reply = yield* api.Generate({ chatId: chat.id, parentSlotId: parent, branch: false, direction: "Tide." })
      if (reply._tag !== "Posted") throw new Error("Expected a posted reply")
      return { chatId: chat.id, slotId: reply.entry.slotId }
    })
  )

const box = (page: Page) => page.getByTestId("composer")
const toggle = (page: Page) => page.getByRole("switch", { name: "Guidance", exact: true })
const bar = (page: Page) => page.getByTestId("guidance-edit-bar")

/** Every RPC frame held for `ms` each way, as over a slow connection. */
const slowConnection = (page: Page, ms: number) =>
  page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => void setTimeout(() => upstream.send(data), ms))
    upstream.onMessage((data) => void setTimeout(() => socket.send(data), ms))
  })

/** Text of several lines, its last line short, so 40 more characters don't wrap. */
const LONG =
  "Aria walks along the harbor wall as the light fades, counting the boats that come in, " +
  "listening for the bell of the old lighthouse and wondering whether the ferry will run tonight. The night is calm.\n\n" +
  "Sam waits by the boats."
/** One line close to the box's width at 1560 px, so the characters typed wrap it onto a second. */
const NEAR_WRAP =
  "Aria walks along the harbor wall as the light fades, counting the boats that come in, " +
  "listening for the bell of the old lighthouse and wondering whether the ferry runs tonight"

/** The gap from the lowest message to the composer now. */
const gap = (page: Page) =>
  page.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer-box"]')!.closest(".chat-column")!
    const rows = [...document.querySelectorAll("article[data-slot]")]
    return Math.round(
      composer.getBoundingClientRect().top - Math.max(...rows.map((r) => r.getBoundingClientRect().bottom))
    )
  })

/** The gap on every animation frame while 40 characters are typed at the end of the box. */
const gapsWhileTyping = async (page: Page) => {
  await box(page).click()
  await box(page).press("End")
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    const w = window as unknown as { gaps_: Array<number>; stop_: boolean }
    w.gaps_ = []
    w.stop_ = false
    // Read just after each frame is painted (a task queued from its animation frame), so the
    // gap is what was on screen, not a layout the frame's resize observers then corrected.
    const measure = () => {
      const composer = document.querySelector('[data-testid="composer-box"]')!.closest(".chat-column")!
      const rows = [...document.querySelectorAll("article[data-slot]")]
      const bottom = Math.max(...rows.map((r) => r.getBoundingClientRect().bottom))
      w.gaps_.push(Math.round(composer.getBoundingClientRect().top - bottom))
    }
    const tick = () => {
      setTimeout(measure, 0)
      if (!w.stop_) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await box(page).pressSequentially(" and the gulls call out over the water.", { delay: 130 })
  await page.waitForTimeout(1200)
  return page.evaluate(() => {
    const w = window as unknown as { gaps_: Array<number>; stop_: boolean }
    w.stop_ = true
    return w.gaps_
  })
}

for (const latency of [0, 150]) {
  for (const mode of ["message", "guidance", "new version after a reload", "a line wrap"] as const) {
    test(`the gap above the composer holds while typing: ${mode}, ${latency} ms each way`, async ({ page }) => {
      if (latency > 0) await slowConnection(page, latency)
      const { chatId } = await longChat()
      if (mode === "guidance") await rpc((api) => setGuidance(api, chatId, true))
      await page.setViewportSize({ width: 1560, height: 900 })
      await page.emulateMedia({ colorScheme: "dark" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(toggle(page)).toBeEnabled()
      await page.waitForTimeout(800)
      // The list's end padding, as it stands with nothing typed.
      const resting = await gap(page)
      expect(resting).toBeGreaterThan(8)
      if (mode === "new version after a reload") {
        await page.getByRole("button", { name: "Edit this guidance" }).click()
        await expect(bar(page)).toBeVisible()
        await box(page).fill(LONG)
        await expect
          .poll(async () => (await rpc((api) => api.OpenComposer({ chatId, forkId: null }))).content, {
            timeout: 15000
          })
          .toBe(LONG)
        await page.reload()
        await expect(bar(page)).toBeVisible()
        await expect(box(page)).toHaveValue(LONG)
      } else await box(page).fill(mode === "a line wrap" ? NEAR_WRAP : LONG)
      const gaps = await gapsWhileTyping(page)
      const seen = [...new Set(gaps)]
      expect(seen, `gaps seen over ${gaps.length} frames: ${seen.join(", ")}`).toEqual([resting])
    })
  }
}
