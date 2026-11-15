// The timeline's change markers (features/chat/stateMarkers.ts, StateRows.tsx), on a synthetic
// chat of Mira and Tobin with every kind of change recorded at its messages: each kind's line,
// several changes of one message as one line that opens, what each means on hover and the link to
// where it's set, a change on one branch never showing on its sibling, a new branch keeping what
// came before it, a change taken back leaving no line, the Interface switches, a workshop showing
// only its own kinds, and a long chat staying at its newest message. At 1440 and 390, light and
// dark, with the layout audit of the messages.
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
const story = () =>
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
          content: line(i),
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
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

const marker = (page: Page, slot: SlotId) => page.locator(`[data-state-markers="${slot}"]`)
const MESSAGES = '[data-testid="messages"]'

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
      await toggle.click()
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
      await link.click()
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
      const settings = await openPanel(page, "Interface")
      const shown = settings.getByRole("group", { name: "Changes shown in the chat" })
      await expect(shown.getByRole("switch")).toHaveCount(7)
      await shown.getByRole("switch", { name: "Who was muted", exact: true }).click()
      await expect(marker(page, slots[0]!)).toHaveCount(0)
      await expectLayout(page, info, `markers-settings-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="Interface"]'
      })
      await page.reload()
      await expect(marker(page, slots[1]!)).toBeVisible()
      await expect(marker(page, slots[0]!)).toHaveCount(0)
      const back = await openPanel(page, "Interface")
      await back.getByRole("switch", { name: "Who was muted", exact: true }).click()
      if (width === 390) await closePanel(page)
      await expect(marker(page, slots[0]!)).toHaveText(/Tobin muted/)
    })
  }

test("a workshop shows only the kinds that mean something there", async ({ page }) => {
  await look(page, 1440, "light")
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
})

test("a long chat with a change at every fifth message stays at its newest message", async ({ page }, info) => {
  await look(page, 1440, "light")
  const made = await admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const tobin = cards.find((card) => card.name === "Tobin")!.entityId as EntityId
      const chat = yield* api.CreateChat({ title: "Synthetic long harbour" })
      const chatId = chat.id as ChatId
      for (const entityId of [cards.find((card) => card.name === "Mira")!.entityId as EntityId, tobin])
        yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Join", entityId } })
      const slots: Array<SlotId> = []
      for (let i = 1; i <= 120; i++) {
        const sent = yield* api.SendMessage({
          chatId,
          parentSlotId: slots.at(-1) ?? null,
          branch: false,
          content: line(i),
          reply: false
        })
        if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
        slots.push(sent.entry.slotId as SlotId)
        if (i % 5 === 0)
          yield* api.ChangeCast({
            chatId,
            slotId: sent.entry.slotId as SlotId,
            change: { _tag: "Presence", entityId: tobin, present: i % 10 !== 0 }
          })
      }
      return { chatId, slots }
    })
  )
  await page.goto(`${server().url}/chats/${made.chatId}`)
  const last = page.getByRole("article").filter({ hasText: line(120) })
  await expect(marker(page, made.slots[119]!)).toHaveText(/Tobin muted/)
  // The lines arrive after the rows were first measured: the newest message is still in view.
  await expect(last).toBeInViewport()
  await expect(marker(page, made.slots[119]!)).toBeInViewport()
  // Scrolling up through them keeps the message under the pointer steady: no jump as rows mount.
  const list = page.locator(MESSAGES)
  await list.hover()
  for (let i = 0; i < 12; i++) {
    const before = await list.evaluate((node) => {
      const top = node.getBoundingClientRect().top
      const rows = [...node.querySelectorAll("article")]
      const row = rows.find((one) => one.getBoundingClientRect().top > top + 40)
      return row ? { text: row.textContent?.slice(0, 80) ?? "", y: row.getBoundingClientRect().top } : null
    })
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(120)
    if (before === null) continue
    const y = await list.evaluate((node, text) => {
      const row = [...node.querySelectorAll("article")].find((one) => (one.textContent ?? "").startsWith(text))
      return row ? row.getBoundingClientRect().top : null
    }, before.text)
    if (y !== null) expect(Math.abs(y - before.y - 300)).toBeLessThan(40)
  }
  await expect(page.locator("[data-state-markers]").first()).toBeVisible()
  await expectLayout(page, info, "markers-long", { scope: MESSAGES })
})
