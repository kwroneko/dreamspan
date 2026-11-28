// The timeline's change markers (features/chat/stateMarkers.ts, StateRows.tsx), on a synthetic
// chat of Mira and Tobin with every kind of change recorded at its messages: each kind's line,
// several changes of one message as one line that opens, what each means on hover and the link to
// where it's set, a change on one branch never showing on its sibling, a new branch keeping what
// came before it, a change taken back leaving no line, the Interface switches, a workshop showing
// only its own kinds, and a long chat staying at its newest message. At 1440 and 390, light and
// dark, with the layout audit of the messages.
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { expectLayout } from "./layoutAudit.ts"
import { closePanel, openPanel } from "./panel.ts"
import { type FakeProvider, startProvider } from "./provider.ts"
import { loginCookie, withCookie } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export function stateMarkerTests() {
  const density = process.env.STATE_MARKER_DENSITY === "compact" ? "compact" : "comfortable"
  const server = serverPerFile(withAdmin)
  let cookie: string
  let provider: FakeProvider
  let connection = ""
  const models: Record<string, string> = {}

  const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

  const shoot = async (page: Page, name: string) => {
    const dir = process.env.SCREENSHOT_DIR
    if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
  }

  test.beforeAll(async () => {
    cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
    provider = await startProvider({ reply: "*nods* The lantern gutters." })
    await admin((api) =>
      Effect.gen(function* () {
        for (const name of ["Mira", "Tobin", "Wren"]) yield* api.CreateCard({ label: name, name })
        const made = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Local model",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "sk-markers-chat-0042"
        })
        connection = made.id
        yield* api.RefreshModels({ connectionId: made.id })
        for (const model of yield* api.ListModels({ connectionId: made.id, includeHidden: false }))
          models[model.key] = model.id
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: made.id, model: models["fake-small"] as never }, preset: null }
        })
        yield* api.CreateLorebook({ label: "Harbour lore" })
        yield* api.CreatePreset({ label: "Terse" })
      })
    )
  })

  test.afterAll(async () => {
    await provider.stop()
  })

  const line = (i: number) => `Synthetic harbour line ${i}.`

  /**
   * Mira and Tobin, four lines of the user's, and at each a change: Tobin muted; Wren added, a note
   * switched on, a model kept and separate contexts, together; a preset kept and a lorebook added.
   * Then a branch from the second line, and one change on each branch at that line.
   */
  const story = (mediaId?: string) =>
    admin((api) =>
      Effect.gen(function* () {
        const cards = yield* api.ListCards()
        const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
        const chat = yield* api.CreateChat({ title: "Synthetic harbour" })
        const chatId = chat.id as ChatId
        const forkId = chat.currentForkId as ForkId
        for (const name of ["Mira", "Tobin"])
          yield* api.ChangeCast({ chatId, forkId, slotId: null, change: { _tag: "Join", entityId: id(name) } })
        const slots: Array<SlotId> = []
        for (let i = 1; i <= 4; i++) {
          const sent = yield* api.SendMessage({
            chatId,
            parentSlotId: slots.at(-1) ?? null,
            branch: false,
            content: mediaId && i === 3 ? "" : line(i),
            ...(mediaId && i === 3 ? { images: [{ mediaId, altText: "Synthetic marker image" }] } : {}),
            reply: false
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          slots.push(sent.entry.slotId as SlotId)
        }
        const change = (slotId: SlotId, c: Parameters<typeof api.ChangeCast>[0]["change"], fork = forkId) =>
          api.ChangeCast({ chatId, forkId: fork, slotId, change: c })
        const note = yield* api.CreateChatNote({
          chatId,
          forkId,
          title: "Mood",
          content: "The harbour is tense tonight."
        })
        const book = (yield* api.ListLibrary({ kind: "lorebook" })).find((ref) => ref.label === "Harbour lore")!
        const preset = (yield* api.ListLibrary({ kind: "preset" })).find((ref) => ref.label === "Terse")!
        // Whatever making the note switched, it's off where the chat starts.
        yield* change(null as never, { _tag: "Note", entityId: note.entityId, active: false })
        yield* change(slots[0]!, { _tag: "Presence", entityId: id("Tobin"), present: false })
        yield* change(slots[1]!, { _tag: "Join", entityId: id("Wren") })
        yield* change(slots[1]!, { _tag: "Note", entityId: note.entityId, active: true })
        yield* change(slots[1]!, {
          _tag: "Model",
          connection: connection as never,
          model: models["fake-large"] as never
        })
        yield* change(slots[1]!, { _tag: "ContextPerSpeaker", view: "separate" })
        yield* change(slots[2]!, { _tag: "Preset", ref: preset.id })
        yield* change(slots[2]!, { _tag: "Lorebook", ref: book.id, active: true })
        const made = yield* api.CreateFork({ chatId, fromForkId: forkId, atSlotId: slots[1]! })
        const sibling = made.fork.id as ForkId
        yield* change(slots[1]!, { _tag: "CardsRotation", on: true }, sibling)
        yield* change(slots[1]!, { _tag: "ReplySingle", on: true })
        return { chatId, forkId, sibling, slots, mira: id("Mira") }
      })
    )

  const look = async (page: Page, width: number, theme: "light" | "dark") => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await admin((api) => api.SetDisplayPrefs({ prefs: { chatDensity: density } }))
  }

  const marker = (page: Page, slot: SlotId) => page.locator(`[data-state-markers="${slot}"]`)
  const MESSAGES = '[data-testid="messages"]'

  if (density === "compact")
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const)
        test(`compact markers clear one-line, image, newest and hovered footers at ${width} ${theme}`, async ({
          page
        }, info) => {
          await look(page, width, theme)
          const png = await page.evaluate(() => {
            const canvas = document.createElement("canvas")
            canvas.width = 320
            canvas.height = 120
            const ctx = canvas.getContext("2d")!
            ctx.fillStyle = "#32808a"
            ctx.fillRect(0, 0, 320, 120)
            return canvas.toDataURL("image/png").split(",")[1]!
          })
          const upload = await page.request.post(`${server().url}/chat/image`, {
            headers: { "content-type": "application/octet-stream" },
            data: Buffer.from(png, "base64")
          })
          expect(upload.ok()).toBe(true)
          const { mediaId } = (await upload.json()) as { mediaId: string }
          const { chatId, forkId, slots, mira } = await story(mediaId)
          await admin((api) =>
            api.ChangeCast({
              chatId,
              forkId,
              slotId: slots[3]!,
              change: { _tag: "Presence", entityId: mira, present: false }
            })
          )
          await page.goto(`${server().url}/chats/${chatId}?fork=${forkId}`)
          await expect(page.locator(MESSAGES)).toHaveAttribute("data-chat-density", "compact")
          for (const [i, scene] of [
            [0, "one-line"],
            [2, "image"],
            [3, "newest"],
            [1, "expanded"]
          ] as const) {
            const row = page.locator(`article[data-slot="${slots[i]}"]`)
            const mark = marker(page, slots[i]!)
            if (scene === "expanded" || scene === "image")
              await mark.getByRole("button", { name: /^\d+ changes/ }).click()
            await mark.scrollIntoViewIfNeeded()
            await row.hover({ position: { x: 100, y: (await row.boundingBox())!.height - 10 } })
            const footer = row.locator(".message-footer")
            if (width === 1440 || scene === "newest") await expect(footer).toHaveCSS("opacity", "1")
            const footerBox = (await footer.boundingBox())!
            const markerBox = (await mark.boundingBox())!
            expect(markerBox.y).toBeGreaterThanOrEqual(footerBox.y + footerBox.height)
            await expect(mark.getByRole("button", { name: /^Open / }).first()).toBeInViewport()
            expect(await mark.evaluate((el) => getComputedStyle(el).paddingTop)).toBe("4px")
            await expectLayout(page, info, `compact-marker-${scene}-${width}-${theme}`, {
              scope: MESSAGES,
              hovered: true
            })
            await shoot(page, `compact-marker-${scene}-${width}-${theme}`)
          }
        })

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`each kind of change, grouped, explained and linked at ${width} ${theme}`, async ({ page }, info) => {
        await look(page, width, theme)
        const { chatId, forkId, slots } = await story()
        await page.goto(`${server().url}/chats/${chatId}?fork=${forkId}`)
        // One change: its line, what it means on hover, and where it's set.
        const muted = marker(page, slots[0]!)
        await expect(muted).toHaveText(/Tobin muted/)
        await muted.getByText("Tobin muted", { exact: true }).hover()
        await expect(
          page
            .getByText("From the next reply on, Tobin isn't picked to reply.", { exact: false })
            .filter({ visible: true })
        ).toBeVisible()
        // Several at one message: one line, which opens.
        const several = marker(page, slots[1]!)
        const toggle = several.getByRole("button", { name: /^5 changes/ })
        await expect(toggle).toHaveAttribute("aria-expanded", "false")
        await expect(several.getByRole("listitem")).toHaveCount(0)
        await page.mouse.move(0, 0)
        await expectLayout(page, info, `markers-closed-${width}-${theme}`, { scope: MESSAGES })
        await shoot(page, `markers-closed-${width}-${theme}`)
        await toggle.focus()
        await page.keyboard.press("Enter")
        await expect(toggle).toHaveAttribute("aria-expanded", "true")
        await expect(several.getByRole("listitem")).toHaveText([
          /^Wren joined/,
          /^Note on: Mood/,
          /^Model set for this chat: Local model · fake-large/,
          /^Context: one shared → separate per character/,
          /^One reply at a time: off → on/
        ])
        await expect(marker(page, slots[2]!).getByRole("button", { name: /^2 changes/ })).toHaveText(
          /Prompt preset set for this chat: Terse · Lorebook on: Harbour lore/
        )
        await several.getByText(/^Model set for this chat:/).hover()
        await expect(
          page
            .getByText("From now on, new and regenerated replies in this chat use Local model · fake-large.", {
              exact: true
            })
            .filter({ visible: true })
        ).toBeVisible()
        await several.getByText("Note on: Mood", { exact: true }).hover()
        await expect(
          page
            .getByText("From the next reply on, this note is sent to the model", { exact: false })
            .filter({ visible: true })
        ).toBeVisible()
        await page.mouse.move(0, 0)
        await expectLayout(page, info, `markers-open-${width}-${theme}`, { scope: MESSAGES })
        await shoot(page, `markers-open-${width}-${theme}`)
        // It stays open across a reload of the rows (the list is virtual), and never looks like a message.
        await expect(page.getByRole("article").filter({ hasText: "Wren joined" })).toHaveCount(0)
        // The link opens where it's set; the URL names the tab.
        const link = several.getByRole("button", { name: "Open Notes: Note on: Mood", exact: true })
        await link.hover()
        await expect(
          page.getByText("Opens Notes, where this is set.", { exact: true }).filter({ visible: true })
        ).toBeVisible()
        await link.focus()
        await page.keyboard.press("Enter")
        await expect(page).toHaveURL(/panel=notes/)
        await expect(page.getByRole("tabpanel", { name: "Notes" })).toBeVisible()
        await closePanel(page)
      })

      test(`per branch, inherited, taken back and hidden at ${width} ${theme}`, async ({ page }, info) => {
        await look(page, width, theme)
        const { chatId, forkId, sibling, slots, mira } = await story()
        // The branch made at the second line: what came before it, and its own change there.
        await page.goto(`${server().url}/chats/${chatId}?fork=${sibling}`)
        await expect(marker(page, slots[0]!)).toHaveText(/Tobin muted/)
        const there = marker(page, slots[1]!)
        await there.getByRole("button", { name: /^5 changes/ }).click()
        await expect(there.getByRole("listitem")).toHaveText([
          /^Wren joined/,
          /^Note on: Mood/,
          /^Model set for this chat/,
          /^Context: one shared → separate per character/,
          /^Card swap: off → on/
        ])
        await expect(there).not.toContainText("One reply at a time")
        await expectLayout(page, info, `markers-branch-${width}-${theme}`, { scope: MESSAGES })
        await shoot(page, `markers-branch-${width}-${theme}`)
        // The branch it was made from: its own change there, and none of the sibling's.
        await page.goto(`${server().url}/chats/${chatId}?fork=${forkId}`)
        const here = marker(page, slots[1]!)
        await expect(here.getByRole("button", { name: /^5 changes/ })).toHaveText(/One reply at a time: off → on/)
        await expect(here).not.toContainText("Card swap")
        // A change at the newest line shows at once; taken back there, its line goes.
        const newest = marker(page, slots[3]!)
        await expect(newest).toHaveCount(0)
        const cast = await openPanel(page, "Cast")
        await cast.getByRole("button", { name: "Mute Mira", exact: true }).click()
        await expect
          .poll(async () => (await admin((api) => api.GetCast({ chatId, forkId, slotId: slots[3]! }))).absent)
          .toContain(mira)
        if (width === 390) await closePanel(page)
        await expect(newest).toHaveText(/Mira muted/)
        await shoot(page, `markers-newest-${width}-${theme}`)
        const again = width === 390 ? await openPanel(page, "Cast") : cast
        await again.getByRole("button", { name: "Unmute Mira", exact: true }).click()
        await expect(newest).toHaveCount(0)
        // The Interface switch hides a kind, here and after a reload.
        await expect(marker(page, slots[0]!)).toHaveText(/Tobin muted/)
        const settings = await openPanel(page, "Display")
        const shown = settings.getByRole("group", { name: "Changes shown in the chat" })
        await expect(shown.getByRole("switch")).toHaveCount(8)
        await shown.getByRole("switch", { name: "Who was muted", exact: true }).click()
        await expect(marker(page, slots[0]!)).toHaveCount(0)
        await expectLayout(page, info, `markers-settings-${width}-${theme}`, {
          scope: '[role="tabpanel"][aria-label="Display"]'
        })
        await page.reload()
        await expect(marker(page, slots[1]!)).toBeVisible()
        await expect(marker(page, slots[0]!)).toHaveCount(0)
        const back = await openPanel(page, "Display")
        await back.getByRole("switch", { name: "Who was muted", exact: true }).click()
        if (width === 390) await closePanel(page)
        await expect(marker(page, slots[0]!)).toHaveText(/Tobin muted/)
      })
    }

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`a workshop shows only its own kinds at ${width} ${theme}`, async ({ page }, info) => {
        await look(page, width, theme)
        const made = await admin((api) =>
          Effect.gen(function* () {
            const chat = yield* api.CreateWorkshop({ title: "Synthetic marker workshop" })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: chat.activeLeafSlotId,
              branch: false,
              content: line(1),
              reply: false
            })
            if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
            const slotId = sent.entry.slotId as SlotId
            const at = { chatId: chat.id, forkId: chat.currentForkId, slotId }
            yield* api.ChangeCast({
              ...at,
              change: { _tag: "Model", connection: connection as never, model: models["fake-large"] as never }
            })
            yield* api.ChangeCast({ ...at, change: { _tag: "ReplySingle", on: true } })
            return { chatId: chat.id as ChatId, slotId }
          })
        )
        await page.goto(`${server().url}/chats/${made.chatId}`)
        const row = marker(page, made.slotId)
        await expect(row).toHaveText(/Model set for this chat: Local model · fake-large/)
        await expect(row).not.toContainText("One reply at a time")
        await expectLayout(page, info, `markers-workshop-${width}-${theme}`, { scope: MESSAGES })
        await shoot(page, `markers-workshop-${width}-${theme}`)
      })

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`5,100 messages, delayed markers and expanded groups at ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(180_000)
        await look(page, width, theme)
        const chat = await admin((api) => api.CreateChat({ title: "Synthetic dense marker scale" }))
        const made = await new Promise<{ last: SlotId }>((resolve, reject) => {
          const worker = new Worker(new URL("./stateMarkerFixtureWorker.ts", import.meta.url), {
            workerData: {
              dbPath: join(server().dataDir, "dreamspan.db"),
              chatId: chat.id,
              forkId: chat.currentForkId,
              count: 5100
            }
          })
          let value: { last: SlotId } | undefined
          worker.once("message", (result: { last: SlotId }) => {
            value = result
          })
          worker.once("error", reject)
          worker.once("exit", (code) =>
            code === 0 && value ? resolve(value) : reject(new Error(`fixture exited ${code}`))
          )
        })
        let reads = 0
        let release: (() => void) | undefined
        let sentAt = 0
        let firstMs = 0
        await page.routeWebSocket(/\/rpc$/, (socket) => {
          const upstream = socket.connectToServer()
          let requestId: unknown
          upstream.onMessage((data) => {
            if (
              typeof data === "string" &&
              requestId !== undefined &&
              (JSON.parse(data) as { requestId?: unknown }).requestId === requestId &&
              firstMs === 0
            )
              firstMs = performance.now() - sentAt
            socket.send(data)
          })
          socket.onMessage((data) => {
            const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: unknown }) : null
            if (request?.tag === "GetStateMarks") {
              reads++
              if (reads === 1) {
                requestId = request.id
                release = () => {
                  sentAt = performance.now()
                  upstream.send(data)
                }
                return
              }
            }
            upstream.send(data)
          })
        })
        await page.goto(`${server().url}/chats/${chat.id}`)
        const last = page.getByRole("article").filter({ hasText: line(5100) })
        await expect(last).toBeInViewport()
        await expect.poll(() => release !== undefined).toBe(true)
        release!()
        const probeStart = performance.now()
        await admin((api) => api.GetChat({ chatId: chat.id }))
        const probeMs = performance.now() - probeStart
        expect(probeMs).toBeLessThan(5000)
        const newest = marker(page, made.last)
        await expect(newest.getByRole("button", { name: /^2 changes/ })).toBeVisible()
        await expect(last).toBeInViewport()
        await expect(newest).toBeInViewport()
        await newest.getByRole("button", { name: /^2 changes/ }).focus()
        await page.keyboard.press("Space")
        await expect(newest.getByRole("listitem")).toHaveCount(2)
        const list = page.locator(MESSAGES)
        await list.hover()
        for (let i = 0; i < 12; i++) {
          await page.mouse.wheel(0, -300)
          await page.waitForTimeout(100)
        }
        // Opening panels and loading new cast batches while scrolling must not rescan events.
        const settledReads = reads
        const panel = await openPanel(page, "Display")
        await expect(panel.getByRole("group", { name: "Changes shown in the chat" })).toBeVisible()
        await closePanel(page)
        await page.waitForTimeout(250)
        expect(reads).toBe(settledReads)
        expect(reads).toBe(1)
        // The measured virtual row includes its marker, and adjacent rows keep the density's gap.
        const geometry = await list.evaluate((el) => {
          const rows = [...el.querySelectorAll<HTMLElement>(".chat-row[data-index]")].sort(
            (a, b) => Number(a.dataset.index) - Number(b.dataset.index)
          )
          return rows.map((row, i) => {
            const box = row.getBoundingClientRect()
            const mark = row.querySelector("[data-state-markers]")?.getBoundingClientRect()
            const next = rows[i + 1]
            return {
              overflow: mark ? mark.bottom - box.bottom : 0,
              gap: next ? next.getBoundingClientRect().top - box.bottom : null
            }
          })
        })
        expect(geometry.length).toBeGreaterThan(2)
        for (const row of geometry) {
          expect(row.overflow).toBeLessThanOrEqual(1)
          if (row.gap !== null) expect(Math.abs(row.gap - (density === "compact" ? 4 : 6))).toBeLessThan(1)
        }
        await expectLayout(page, info, `markers-dense-${width}-${theme}`, { scope: MESSAGES })
        await shoot(page, `markers-dense-${width}-${theme}`)
        console.log(
          "MARKER_BROWSER",
          JSON.stringify({ width, theme, messages: 5100, events: 10200, reads, firstMs, probeMs })
        )
        // An older linked message must retain its position when marks above it arrive late.
        reads = 0
        release = undefined
        firstMs = 0
        const anchorId = `${chat.id}-scale-2500` as SlotId
        await page.goto(`${server().url}/chats/${chat.id}?slot=${anchorId}`)
        const anchor = page.locator(`article[data-slot="${anchorId}"]`)
        await expect(anchor).toBeInViewport()
        await expect.poll(() => release !== undefined).toBe(true)
        // Let the link's initial two-frame positioning finish; marks remain held.
        await page.evaluate(async () => {
          for (let i = 0; i < 4; i++) await new Promise<void>((done) => requestAnimationFrame(() => done()))
        })
        const before = (await anchor.boundingBox())!.y
        release!()
        await expect(marker(page, anchorId)).toBeVisible()
        await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(4)
        expect(reads).toBe(1)
        console.log(
          "MARKER_BROWSER_WARM",
          JSON.stringify({ width, theme, firstMs, anchorShift: Math.abs((await anchor.boundingBox())!.y - before) })
        )
      })
}
