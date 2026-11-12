// Separate contexts per character in the app (spec/CHARACTER-CONTEXT.md §9.2 units CU1–CU5), on a
// synthetic three-character chat (Mira, Tobin, Wren) with the fake provider: This chat's Context
// setting. Each check at 1440 and 390, light and dark, with the layout audit of what it touched.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { choices, nextChip } from "./support/strip.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, DECISION_TIMEOUT_MS: "60000" })
let cookie: string
let provider: FakeProvider
let decide: Server
let decisionConnection = ""
/** The characters the scene check says left during the latest message. */
const leaving = new Set<string>()

const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider({ reply: "*nods* The lantern gutters." })
  // The scene check's model: a character named in `leaving` left, everyone else is still there.
  decide = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      const body = JSON.parse(raw) as { questions: Record<string, { instructions?: string }> }
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          const name = /^(\w+) is in the scene/.exec(question.instructions ?? "")?.[1] ?? ""
          return [id, { noul: leaving.has(name) ? 0.01 : 0.99 }]
        })
      )
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 320, output_tokens: 1 } }))
    })
  })
  await new Promise<void>((resolve) => decide.listen(0, "127.0.0.1", resolve))
  const decideUrl = `http://127.0.0.1:${(decide.address() as AddressInfo).port}`
  decisionConnection = await admin((api) =>
    Effect.gen(function* () {
      for (const name of ["Mira", "Tobin", "Wren"]) yield* api.CreateCard({ label: name, name })
      const chat = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-contexts-chat-0042"
      })
      yield* api.RefreshModels({ connectionId: chat.id })
      const model = (yield* api.ListModels({ connectionId: chat.id, includeHidden: false })).find(
        (m) => m.key === "fake-small"
      )!
      yield* api.SetGenerationDefaults({ defaults: { model: { connection: chat.id, model: model.id }, preset: null } })
      const connection = yield* api.CreateConnection({
        kind: "system-one",
        settings: {
          name: "Jev",
          baseUrl: `${decideUrl}/decide`,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-contexts-decide-0042"
      })
      const jev = yield* api.AddUserModel({ connectionId: connection.id, key: "typesafe/jev-1.13", overrides: {} })
      yield* api.SetDecisionSettings({ connectionId: connection.id, model: jev.id, points: {} })
      return connection.id
    })
  )
})

test.afterAll(async () => {
  await provider.stop()
  await new Promise((resolve) => decide.close(resolve))
})

/** The three characters' ids, by name. */
const castIds = () =>
  admin((api) =>
    Effect.map(api.ListCards(), (cards) => {
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
      return { mira: id("Mira"), tobin: id("Tobin"), wren: id("Wren") }
    })
  )

/** A new chat of Mira, Tobin and Wren, with the user's first line; one reply per send. */
const threeCharacters = () =>
  admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const id = (name: string) => cards.find((card) => card.name === name)!.entityId as EntityId
      const started = yield* api.StartChat({
        cards: [id("Mira"), id("Tobin"), id("Wren")],
        persona: null,
        greeting: null,
        greeters: [],
        first: { _tag: "Send", content: "*The inn's door creaks open.*", speakerEntityId: null }
      })
      yield* api.ChangeCast({ chatId: started.chat.id, slotId: null, change: { _tag: "ReplySingle", on: true } })
      return {
        chatId: started.chat.id as ChatId,
        slotId: started.entry.slotId as SlotId,
        forkId: started.chat.currentForkId
      }
    })
  )

const look = async (page: Page, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`This chat's Context setting at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const { chatId, slotId } = await threeCharacters()
      const read = () => admin((api) => api.GetCast({ chatId, slotId }))
      await page.goto(`${server().url}/chats/${chatId}`)
      let settings = await openPanel(page, "This chat")
      const context = () => settings.getByRole("radiogroup", { name: "Context" })
      await expect(context().getByRole("radio", { name: /^One shared context/ })).toBeChecked()
      await expect(context().getByRole("radio", { name: /^Separate contexts/ })).not.toBeChecked()
      // The explanation: what it does, when, what the model sees, with an example.
      await settings.getByRole("button", { name: "About Context", exact: true }).click()
      await expect(
        page.getByText("Example: you mark Wren away", { exact: false }).filter({ visible: true })
      ).toBeVisible()
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `contexts-setting-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="This chat"]'
      })
      await context()
        .getByRole("radio", { name: /^Separate contexts/ })
        .click()
      await expect.poll(async () => (await read()).contextPerSpeaker).toBe("separate")
      await expect(settings.getByText(/^Costs more: once a character misses part of the chat/)).toBeVisible()
      await expectLayout(page, info, `contexts-setting-separate-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="This chat"]'
      })
      // Server state: it survives a reload.
      await page.reload()
      settings = await openPanel(page, "This chat")
      await expect(context().getByRole("radio", { name: /^Separate contexts/ })).toBeChecked()
      await context()
        .getByRole("radio", { name: /^One shared context/ })
        .click()
      await expect.poll(async () => (await read()).contextPerSpeaker).toBe("shared")
      await expect(settings.getByText(/^Costs more/)).toHaveCount(0)
    })
  }

/** Closes the phone's sheet over the chat, if one is open. */
const closeSheet = async (page: Page) => {
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("tablist", { name: "Chat panel" }) })
  if (await sheet.isVisible()) await sheet.getByRole("button", { name: "Close", exact: true }).click()
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the Cast tab's Away and Narrator at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const { chatId, slotId } = await threeCharacters()
      const ids = await castIds()
      const read = () => admin((api) => api.GetCast({ chatId, slotId }))
      await page.goto(`${server().url}/chats/${chatId}`)
      let cast = await openPanel(page, "Cast")
      const row = (name: string) => cast.getByRole("listitem", { name, exact: true })
      const awayButton = () => row("Wren").getByRole("button", { name: "Mark Wren away", exact: true })
      // Away sits beside Mute, with the same pattern, and explains itself on hover.
      await awayButton().hover()
      await expect(page.getByText("Click when Wren leaves the scene", { exact: false }).first()).toBeVisible()
      await awayButton().click()
      await expect.poll(async () => (await read()).away).toEqual([ids.wren])
      await expect(row("Wren").getByText("Away", { exact: true })).toBeVisible()
      await expect(row("Wren").getByRole("button", { name: "Mark Wren back", exact: true })).toBeVisible()
      await expect(cast.getByRole("heading", { name: /3 characters · 1 away/ })).toBeVisible()
      // Away isn't Mute.
      await expect(row("Wren").getByRole("button", { name: "Mute Wren", exact: true })).toBeVisible()
      // Mira becomes the narrator: no Away mark on her row.
      await row("Mira").getByRole("button", { name: "More for Mira", exact: true }).click()
      const item = page.getByRole("menuitemcheckbox", { name: /^Narrator/ })
      await expect(item).not.toBeChecked()
      await item.click()
      await expect.poll(async () => (await read()).roles).toEqual({ [ids.mira]: "narrator" })
      await expect(row("Mira").getByText("Narrator", { exact: true })).toBeVisible()
      await expect(row("Mira").getByRole("button", { name: /^Mark Mira/ })).toHaveCount(0)
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `contexts-cast-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="Cast"]'
      })
      // Server state: a reload keeps both.
      await page.reload()
      cast = await openPanel(page, "Cast")
      await expect(row("Wren").getByText("Away", { exact: true })).toBeVisible()
      await expect(row("Mira").getByText("Narrator", { exact: true })).toBeVisible()
      await closeSheet(page)
      // Next lists Wren as away, and so does the speaker switcher.
      await nextChip(page).click()
      const next = choices(page, "Who replies next")
      await expect(next.getByText("Away: replies only when picked", { exact: true })).toBeVisible()
      await expectLayout(page, info, `contexts-next-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: /^Speaking as / }).click()
      await expect(
        page.getByRole("option", { name: "Wren", exact: true }).getByText("away", { exact: true })
      ).toBeVisible()
      await page.keyboard.press("Escape")
      // Back again.
      cast = await openPanel(page, "Cast")
      await row("Wren").getByRole("button", { name: "Mark Wren back", exact: true }).click()
      await expect.poll(async () => (await read()).away).toBeUndefined()
      await expect(row("Wren").getByText("Away", { exact: true })).toHaveCount(0)
    })
  }

/** The scene check on or off; `leaving` names who it says left. */
const sceneCheck = (on: boolean) =>
  admin((api) =>
    Effect.gen(function* () {
      const [model] = yield* api.ListModels({ connectionId: decisionConnection as never, includeHidden: false })
      yield* api.SetDecisionSettings({
        connectionId: decisionConnection as never,
        model: model!.id,
        points: { presence: { on, threshold: 0.85 } }
      })
    })
  )

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the timeline's away rows and Undo of the scene check at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      await sceneCheck(true)
      leaving.clear()
      leaving.add("Wren")
      try {
        const { chatId, forkId, slotId } = await threeCharacters()
        const ids = await castIds()
        await admin((api) =>
          api.Generate({ chatId, parentSlotId: slotId, branch: false, speakerEntityId: ids.mira })
        )
        // The branch's tip, the reply, once it's there.
        let leaf: SlotId | null = null
        await expect
          .poll(async () => {
            const path = await admin((api) =>
              api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 2 })
            )
            leaf = path.entries.length === 2 ? path.leafSlotId : null
            return leaf
          })
          .not.toBeNull()
        const marks = () => admin((api) => api.GetAwayMarks({ chatId, forkId: forkId as never, slotId: leaf }))
        // The reply completes, then the scene check marks Wren away at it.
        await expect
          .poll(async () => (await marks()).map((mark) => [mark.entityId, mark.away, mark.by]), { timeout: 30_000 })
          .toEqual([[ids.wren, true, "decision"]])
        leaving.clear()
        await page.goto(`${server().url}/chats/${chatId}`)
        const rows = page.locator("[data-away-row]")
        const left = rows.filter({ hasText: "Wren left · scene check" })
        await expect(left).toBeVisible()
        // The scene check's own request doesn't break the chat's cache estimate (it used to).
        await expect(page.getByText("Something went wrong.")).toHaveCount(0)
        // In this one-shared-context chat too, the Cast row shows the scene check's Away, with
        // the control that clears it beside Mute.
        let castPanel = await openPanel(page, "Cast")
        const wrenRow = castPanel.getByRole("listitem", { name: "Wren", exact: true })
        await expect(wrenRow.getByText("Away", { exact: true })).toBeVisible()
        await expect(wrenRow.getByRole("button", { name: "Mark Wren back", exact: true })).toBeVisible()
        await expect(wrenRow.getByRole("button", { name: "Mute Wren", exact: true })).toBeVisible()
        await closeSheet(page)
        // The row explains itself on hover: who decided, what follows.
        await left.getByText("Wren left · scene check").hover()
        await expect(
          page.getByText("A decision model judged that Wren left", { exact: false }).filter({ visible: true })
        ).toBeVisible()
        const undo = left.getByRole("button", { name: "Undo", exact: true })
        await undo.hover()
        await expect(page.getByText("Wren was there after all", { exact: false }).filter({ visible: true })).toBeVisible()
        await page.mouse.move(0, 0)
        await expectLayout(page, info, `contexts-away-row-${width}-${theme}`, { scope: "[data-away-row]" })
        await undo.click()
        await expect(left).toHaveCount(0)
        await expect.poll(async () => (await admin((api) => api.GetCast({ chatId, slotId: leaf }))).away).toBeUndefined()
        // The user's own mark: a row with no Undo (the Cast tab takes it back).
        castPanel = await openPanel(page, "Cast")
        await expect(wrenRow.getByText("Away", { exact: true })).toHaveCount(0)
        await castPanel
          .getByRole("listitem", { name: "Mira", exact: true })
          .getByRole("button", { name: "Mark Mira away", exact: true })
          .click()
        await closeSheet(page)
        const mine = rows.filter({ hasText: "Mira left · you" })
        await expect(mine).toBeVisible()
        await expect(mine.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0)
        await expectLayout(page, info, `contexts-away-row-user-${width}-${theme}`, { scope: "[data-away-row]" })
        // Server state: a reload shows the same rows.
        await page.reload()
        await expect(rows.filter({ hasText: "Mira left · you" })).toBeVisible()
        await expect(rows.filter({ hasText: "Wren left" })).toHaveCount(0)
      } finally {
        leaving.clear()
        await sceneCheck(false)
      }
    })
  }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the preset's gap line and join line at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const preset = await admin((api) => api.CreatePreset({ label: `Contexts preset ${width} ${theme}` }))
      await page.goto(`${server().url}/library/${preset.id}`)
      await page.getByText("Show the 13 utility prompts", { exact: true }).click()
      const gap = page.getByRole("textbox", { name: /^Where a character wasn't present/ })
      const join = page.getByRole("textbox", { name: /^Where a merged storyline is new to a character/ })
      await expect(gap).toBeVisible()
      await expect(join).toBeVisible()
      // Each shows its default while unset: the gap line's text, the join line's nothing.
      await expect(page.getByText(/^Default: "\[\{\{char\}\} wasn't present for \{\{absentCount\}\} messages/)).toBeVisible()
      await expect(page.getByText("Default: nothing", { exact: true })).toBeVisible()
      await expectLayout(page, info, `contexts-preset-${width}-${theme}`, { scope: "details[open]" })
      await gap.fill("[{{char}} missed {{absentCount}} messages.]")
      await page.locator("body").click({ position: { x: 1, y: 1 } })
      await expect
        .poll(() =>
          admin((api) => api.OpenEditor({ refId: preset.id })).then(
            (snapshot) => snapshot.drafts.find((draft) => draft.key.field.includes("absent_gap_prompt"))?.content
          )
        )
        .toBe("[{{char}} missed {{absentCount}} messages.]")
    })
  }
