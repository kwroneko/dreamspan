// The chat column's width and the composer in it (composer2, owner 2026-11-01): the account's
// Chat width (ST's Chat Width) sets the column for the messages, the composer and the notices,
// live while its slider is dragged, saved once on release, followed by reload and by another
// browser. The composer's text has a row of its own, close to the column's whole width; what
// says how the box stands sits on it, the queue directly above it, the next-reply strip under
// it. Every card and message here is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { CHAT_WIDTH } from "@rp/shared/chatApi.ts"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
let cookie: string
const rpc = <A>(run: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, run)
const shots = process.env.RP_SCREENS
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider({ reply: "Ethan nods slowly and turns back to the window, rain tracing the glass." })
  await rpc((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic width",
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

/** A chat with Avani (played) and Ethan: a few long turns, Ethan's last written with guidance. */
const study = (title: string) =>
  rpc((api) =>
    Effect.gen(function* () {
      const ethan = (yield* api.CreateCard({ label: `Ethan ${title}`, name: "Ethan" })).entityId
      const avani = (yield* api.CreateCard({ label: `Avani ${title}`, name: "Avani" })).entityId
      const chat = yield* api.CreateChat({ title })
      for (const id of [ethan, avani])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [avani] } })
      let parent: SlotId | null = null
      for (let i = 0; i < 4; i++) {
        const sent: { _tag: string; entry?: { slotId: SlotId } } = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content:
            `Turn ${i + 1}. ` +
            "The study smells of old paper and cold tea; the lamp throws a long yellow oval across the desk. ".repeat(
              i % 2 === 0 ? 3 : 6
            ),
          speakerEntityId: (i % 2 === 0 ? avani : ethan) as EntityId
        })
        if (sent._tag !== "Posted" || !sent.entry) throw new Error("Expected a posted message")
        parent = sent.entry.slotId
      }
      const reply = yield* api.Generate({
        chatId: chat.id,
        parentSlotId: parent,
        branch: false,
        speakerEntityId: ethan as EntityId,
        direction: "Ethan answers without looking up."
      })
      if (reply._tag !== "Posted") throw new Error("Expected a posted reply")
      return { chatId: chat.id, slotId: reply.entry.slotId }
    })
  )

const settled = (chatId: ChatId) =>
  expect
    .poll(async () => {
      const path = await rpc((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 30 }))
      return path.entries.every((entry) => entry.version.status !== "generating")
    })
    .toBe(true)

const box = (page: Page) => page.getByTestId("composer")
const composerBox = (page: Page) => page.getByTestId("composer-box")
/** The message list's column: what the composer and the notices line up with. */
const column = (page: Page) => page.getByTestId("messages").locator("> div")
const bounds = async (locator: Locator) => (await locator.boundingBox())!
const noSideScroll = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

const open = async (page: Page, width: number, height: number, theme: "light" | "dark", chatId: ChatId) => {
  await page.setViewportSize({ width, height })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(box(page)).toBeEditable()
  await expect(page.getByRole("button", { name: "Generate Avani", exact: true })).toBeEnabled()
}

const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ animations: "disabled", path: join(shots, `${name}.png`) })
}

/** The composer's box and text against the column: lined up, and the text close to its whole width. */
const checkComposer = async (page: Page, width: number) => {
  const col = await bounds(column(page))
  const frame = await bounds(composerBox(page))
  const input = await bounds(box(page))
  // The column is the account's width, less a gutter on a narrower screen, and the whole of a phone's.
  const expected = width < 640 ? width : Math.min(CHAT_WIDTH.default, (await bounds(page.locator("main"))).width - 32)
  expect(Math.abs(col.width - expected)).toBeLessThanOrEqual(1)
  // The box lines up with the messages (a phone keeps its 8 px edge).
  const inset = width < 640 ? 8 : 0
  expect(Math.abs(frame.x - (col.x + inset))).toBeLessThanOrEqual(1)
  expect(Math.abs(frame.x + frame.width - (col.x + col.width - inset))).toBeLessThanOrEqual(1)
  // The text is the composer's main part: never beside the controls, at least 85% of the column.
  if (width >= 1440) expect(input.width / col.width).toBeGreaterThanOrEqual(0.85)
  else expect(input.width / col.width).toBeGreaterThanOrEqual(0.8)
  const send = await bounds(page.getByRole("button", { name: /^(Send|.+ replies)/ }).first())
  expect(send.y).toBeGreaterThanOrEqual(input.y + input.height - 1)
  // The strip is under the box, not between it and what describes it.
  const strip = await bounds(nextReply(page))
  expect(strip.y).toBeGreaterThanOrEqual(frame.y + frame.height)
  await noSideScroll(page)
  return { col, frame, input }
}

for (const [width, height] of [
  [3840, 2160],
  [1920, 1080],
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const) {
    test(`the composer fills the chat column; banner and queue sit on the box (${width}px ${theme})`, async ({
      page
    }) => {
      await rpc((api) => api.SetDisplayPrefs({ prefs: { chatWidth: CHAT_WIDTH.default, guidance: false } }))
      const { chatId } = await study(`Study ${width} ${theme}`)
      await settled(chatId)
      await open(page, width, height, theme, chatId)
      const { input } = await checkComposer(page, width)
      await shoot(page, `composer-${width}-${theme}`)

      // Editing a reply's guidance: the bar is the box's first line, the text directly under it.
      const reply = page.getByRole("article").filter({ hasText: "Guidance: Ethan answers without looking up." })
      await reply.getByRole("button", { name: "New version with this guidance" }).click()
      const bar = page.getByTestId("guidance-edit-bar")
      await expect(bar).toContainText("Guidance for a new version of Ethan's reply")
      const frame = await bounds(composerBox(page))
      const barAt = await bounds(bar)
      const textAt = await bounds(box(page))
      expect(barAt.y).toBeGreaterThanOrEqual(frame.y)
      expect(barAt.y - frame.y).toBeLessThanOrEqual(8)
      expect(textAt.y - (barAt.y + barAt.height)).toBeGreaterThanOrEqual(0)
      expect(textAt.y - (barAt.y + barAt.height)).toBeLessThanOrEqual(12)
      expect(Math.abs(textAt.width - input.width)).toBeLessThanOrEqual(1)
      await noSideScroll(page)
      await shoot(page, `guidance-edit-${width}-${theme}`)
      await bar.getByRole("button", { name: "Close: back to new messages" }).click()
      await expect(bar).toHaveCount(0)

      // A message sent while a reply is being written waits in the queue, directly above the box.
      provider.hold()
      try {
        await box(page).fill("Avani sets the letter on the desk.")
        await box(page).press("Enter")
        await expect(box(page)).toHaveAttribute("placeholder", "Queue…")
        await box(page).fill("She waits for him to read it.")
        await box(page).press("Enter")
        const queue = page.getByRole("list", { name: "Queued messages" })
        await expect(queue).toBeVisible()
        const queueAt = await bounds(queue)
        const boxAt = await bounds(composerBox(page))
        expect(boxAt.y - (queueAt.y + queueAt.height)).toBeGreaterThanOrEqual(0)
        expect(boxAt.y - (queueAt.y + queueAt.height)).toBeLessThanOrEqual(8)
        await noSideScroll(page)
        await shoot(page, `queued-${width}-${theme}`)
      } finally {
        provider.release()
      }
      await expect(page.getByRole("list", { name: "Queued messages" })).toHaveCount(0, { timeout: 30_000 })
      await settled(chatId)
    })
  }

test("the chat width follows its slider live, saves on release, and follows the account", async ({ page, browser }) => {
  // A chat made and settled, two browsers at 3840 px and a reload: 55-75 s alone at a load of
  // 90-120, so the 60 s default timed it out at whichever step it had reached.
  test.setTimeout(180_000)
  await rpc((api) => api.SetDisplayPrefs({ prefs: { chatWidth: CHAT_WIDTH.default, guidance: false } }))
  const { chatId } = await study("Study slider")
  await settled(chatId)
  const writes: Array<string> = []
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (typeof data === "string" && JSON.parse(data).tag === "SetDisplayPrefs") writes.push(data)
      upstream.send(data)
    })
  })
  await open(page, 3840, 2160, "light", chatId)
  const before = (await bounds(column(page))).width
  expect(Math.round(before)).toBe(CHAT_WIDTH.default)
  const panel = await openPanel(page, "Display")
  const slider = panel.getByRole("slider", { name: "Chat width" })
  await expect(slider).toHaveAttribute("aria-valuetext", `${CHAT_WIDTH.default} px`)
  // With the side panel open, the column still has the account's width where there's room.
  expect(Math.round((await bounds(column(page))).width)).toBe(CHAT_WIDTH.default)

  // Drag: the column follows while the pointer is down, and nothing is saved until it's let go.
  const thumb = await bounds(slider.locator(".."))
  // The slider's control: the track the thumb moves along.
  const track = await bounds(slider.locator("xpath=ancestor::*[contains(@class, 'touch-none')][1]"))
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width * 0.4, thumb.y + thumb.height / 2, { steps: 8 })
  await expect.poll(async () => (await bounds(column(page))).width).toBeGreaterThan(before + 200)
  await expect.poll(async () => (await bounds(composerBox(page))).width).toBeGreaterThan(before + 200)
  expect(writes).toHaveLength(0)
  await page.mouse.move(track.x + track.width * 0.5, thumb.y + thumb.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => writes.length).toBe(1)
  const chosen = Number(await slider.getAttribute("aria-valuenow"))
  expect(chosen).toBeGreaterThan(CHAT_WIDTH.default + 200)
  expect(chosen % CHAT_WIDTH.step).toBe(0)
  await expect.poll(async () => (await rpc((api) => api.GetDisplayPrefs({}))).chatWidth).toBe(chosen)
  const wide = (await bounds(column(page))).width
  expect(Math.abs(wide - chosen)).toBeLessThanOrEqual(1)
  const input = await bounds(box(page))
  expect(input.width / wide).toBeGreaterThanOrEqual(0.85)
  await noSideScroll(page)
  await shoot(page, "slider-3840-light")

  // A key steps it by one notch and saves that.
  await slider.focus()
  await page.keyboard.press("ArrowLeft")
  await expect.poll(async () => (await rpc((api) => api.GetDisplayPrefs({}))).chatWidth).toBe(chosen - CHAT_WIDTH.step)
  await expect.poll(async () => Math.round((await bounds(column(page))).width)).toBe(chosen - CHAT_WIDTH.step)

  // Reload, and another browser signed in to the account: the same width.
  await page.reload()
  await expect(box(page)).toBeEditable()
  await expect.poll(async () => Math.round((await bounds(column(page))).width)).toBe(chosen - CHAT_WIDTH.step)
  const other = await browser.newContext({ viewport: { width: 3840, height: 2160 } })
  try {
    const second = await other.newPage()
    await apiLogin(second.request, server(), ADMIN.handle, ADMIN.password)
    await second.goto(`${server().url}/chats/${chatId}`)
    await expect(box(second)).toBeEditable()
    await expect.poll(async () => Math.round((await bounds(column(second))).width)).toBe(chosen - CHAT_WIDTH.step)
    // A narrower window fills its width, less the gutter, whatever the account's width.
    await second.setViewportSize({ width: 1440, height: 900 })
    await expect
      .poll(async () => Math.round((await bounds(column(second))).width))
      .toBe(Math.round((await bounds(second.locator("main"))).width - 32))
    await expect.poll(() => second.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  } finally {
    await other.close()
  }

  // All the way right is the full width.
  await slider.focus()
  await page.keyboard.press("End")
  await expect(slider).toHaveAttribute("aria-valuetext", "Full width")
  await expect.poll(async () => (await rpc((api) => api.GetDisplayPrefs({}))).chatWidth).toBe(CHAT_WIDTH.max)
  const main = await bounds(page.locator("main"))
  const panelAt = await bounds(page.getByRole("complementary", { name: "Chat panel" }))
  await expect
    .poll(async () => Math.round((await bounds(column(page))).width))
    .toBe(Math.round(main.width - panelAt.width - 32))
  await noSideScroll(page)
  await rpc((api) => api.SetDisplayPrefs({ prefs: { chatWidth: CHAT_WIDTH.default } }))
})

test("with the side panel open at 1440 the text keeps the column's width", async ({ page }) => {
  await rpc((api) => api.SetDisplayPrefs({ prefs: { chatWidth: CHAT_WIDTH.default, guidance: false } }))
  const { chatId } = await study("Study panel")
  await settled(chatId)
  await open(page, 1440, 900, "light", chatId)
  await openPanel(page, "Display")
  const col = await bounds(column(page))
  const panelAt = await bounds(page.getByRole("complementary", { name: "Chat panel" }))
  expect(col.x + col.width).toBeLessThanOrEqual(panelAt.x)
  expect((await bounds(box(page))).width / col.width).toBeGreaterThanOrEqual(0.85)
  const send = await bounds(page.getByRole("button", { name: /^(Send|.+ replies)/ }).first())
  expect(send.x + send.width).toBeLessThanOrEqual(panelAt.x)
  await noSideScroll(page)
  await shoot(page, "panel-1440-light")
})

// The strip's "?" was a text glyph on the font's baseline, visibly off centre in its round chip
// (owner 2026-11-01). Every icon chip and square icon button of the composer and the strip has
// its icon in its middle, at 1x and 2x.
for (const scale of [1, 2])
  test(`the composer's and the strip's icons sit in the middle of their chips (${scale}x)`, async ({ browser }) => {
    await rpc((api) => api.SetDisplayPrefs({ prefs: { chatWidth: CHAT_WIDTH.default, guidance: false } }))
    const { chatId } = await study(`Study icons ${scale}x`)
    await settled(chatId)
    // A third card, so the strip has Next and ▶ Reply now.
    await rpc((api) =>
      Effect.gen(function* () {
        const mira = (yield* api.CreateCard({ label: `Mira ${scale}`, name: "Mira" })).entityId
        yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Join", entityId: mira } })
      })
    )
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1440, height: 900 } })
    try {
      const page = await context.newPage()
      await open(page, 1440, 900, "light", chatId)
      const strip = nextReply(page)
      const chips = [
        strip.getByRole("button", { name: /replies now$/ }),
        page.getByRole("button", { name: "Earlier text of this message", exact: true }),
        page.getByRole("button", { name: "Attach images", exact: true }),
        page.getByRole("switch", { name: "Guidance", exact: true }),
        page.getByRole("button", { name: /^(Send|.+ replies)$/ })
      ]
      for (const chip of chips) {
        await expect(chip).toBeVisible()
        const offset = await chip.evaluate((node) => {
          const outer = node.getBoundingClientRect()
          const icon = node.querySelector("svg")!
          const inner = icon.getBoundingClientRect()
          // The ink, in the icon's own units: its box's middle against the viewBox's.
          const ink = (icon as SVGGraphicsElement).getBBox()
          const view = (icon as SVGSVGElement).viewBox.baseVal
          const unit = inner.width / view.width
          return {
            box: [
              inner.x + inner.width / 2 - (outer.x + outer.width / 2),
              inner.y + inner.height / 2 - (outer.y + outer.height / 2)
            ],
            ink: [
              (ink.x + ink.width / 2 - view.x - view.width / 2) * unit,
              (ink.y + ink.height / 2 - view.y - view.height / 2) * unit
            ],
            name: node.getAttribute("aria-label")
          }
        })
        for (const d of offset.box) expect(Math.abs(d), `${offset.name}: icon box off centre`).toBeLessThanOrEqual(0.5)
        // ▶ is drawn as a play glyph is, a little right of the box's middle so it looks centred.
        if (!offset.name?.endsWith("replies now"))
          for (const d of offset.ink) expect(Math.abs(d), `${offset.name}: ink off centre`).toBeLessThanOrEqual(0.5)
      }
      // Zoomed: the strip's end and the box's control row.
      if (shots && scale === 2) {
        mkdirSync(shots, { recursive: true })
        const zoom = await browser.newContext({ deviceScaleFactor: 4, viewport: { width: 1440, height: 900 } })
        try {
          const big = await zoom.newPage()
          await open(big, 1440, 900, "light", chatId)
          const now = await bounds(nextReply(big).getByRole("button", { name: /replies now$/ }))
          const around = (at: { x: number; y: number; width: number; height: number }, left: number) => ({
            x: at.x - left,
            y: at.y - 8,
            width: at.width + left + 16,
            height: at.height + 16
          })
          await big.screenshot({ path: join(shots, "reply-now-chip-zoom-4x.png"), clip: around(now, 120) })
          const row = await bounds(big.getByTestId("composer-controls"))
          await big.screenshot({ path: join(shots, "composer-controls-zoom-4x.png"), clip: row })
        } finally {
          await zoom.close()
        }
      }
    } finally {
      await context.close()
    }
  })
