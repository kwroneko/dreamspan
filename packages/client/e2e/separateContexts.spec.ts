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
import { level1 } from "./support/summaries.ts"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
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
      response.end(
        JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 320, output_tokens: 1 } })
      )
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
      await expect(
        settings.getByText("One shared context also shares earlier messages", { exact: false })
      ).toBeVisible()
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
      await expect(settings.getByText(/Summaries also run once for each character/)).toBeVisible()
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
        await admin((api) => api.Generate({ chatId, parentSlotId: slotId, branch: false, speakerEntityId: ids.mira }))
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
        await expect(
          page.getByText("Wren was there after all", { exact: false }).filter({ visible: true })
        ).toBeVisible()
        await page.mouse.move(0, 0)
        await expectLayout(page, info, `contexts-away-row-${width}-${theme}`, { scope: "[data-away-row]" })
        await undo.click()
        await expect(left).toHaveCount(0)
        await expect
          .poll(async () => (await admin((api) => api.GetCast({ chatId, slotId: leaf }))).away)
          .toBeUndefined()
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
    test(`Undo of the scene check's "is back" row keeps the character away at ${width} ${theme}`, async ({
      page
    }, info) => {
      await look(page, width, theme)
      await sceneCheck(true)
      leaving.clear()
      leaving.add("Wren")
      try {
        const { chatId, forkId, slotId } = await threeCharacters()
        const ids = await castIds()
        await admin((api) => api.Generate({ chatId, parentSlotId: slotId, branch: false, speakerEntityId: ids.mira }))
        const marksAt = async () => {
          const path = await admin((api) =>
            api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
          )
          return admin((api) => api.GetAwayMarks({ chatId, forkId: forkId as never, slotId: path.leafSlotId }))
        }
        await expect
          .poll(async () => (await marksAt()).map((mark) => [mark.entityId, mark.away, mark.by]), { timeout: 30_000 })
          .toEqual([[ids.wren, true, "decision"]])
        // The scene check now says Wren is back, at Mira's next reply.
        leaving.clear()
        await reply(chatId, forkId!, ids.mira)
        await expect
          .poll(async () => (await marksAt()).map((mark) => [mark.entityId, mark.away, mark.by]), { timeout: 30_000 })
          .toEqual([
            [ids.wren, true, "decision"],
            [ids.wren, false, "decision"]
          ])
        await page.goto(`${server().url}/chats/${chatId}`)
        const back = page.locator("[data-away-row]").filter({ hasText: "Wren is back · scene check" })
        await expect(back).toBeVisible()
        const undo = back.getByRole("button", { name: "Undo", exact: true })
        await undo.hover()
        await expect(page.getByText("Wren hadn't come back", { exact: false }).filter({ visible: true })).toBeVisible()
        await page.mouse.move(0, 0)
        await expectLayout(page, info, `contexts-back-row-${width}-${theme}`, { scope: "[data-away-row]" })
        await undo.click()
        await expect(back).toHaveCount(0)
        // Wren stays away from the first mark on, now by the user's own mark.
        await expect
          .poll(async () => {
            const path = await admin((api) =>
              api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
            )
            return (await admin((api) => api.GetCast({ chatId, slotId: path.leafSlotId }))).away
          })
          .toEqual([ids.wren])
        await expect(page.locator("[data-away-row]").filter({ hasText: "Wren left · scene check" })).toBeVisible()
      } finally {
        leaving.clear()
        await sceneCheck(false)
      }
    })
  }

/** Asks for a reply by `speaker` after the branch's tip and waits until it's written; its version. */
const reply = async (chatId: ChatId, forkId: string, speaker: EntityId) => {
  const before = await admin((api) =>
    api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
  )
  await admin((api) =>
    api.Generate({
      chatId,
      forkId: forkId as never,
      parentSlotId: before.leafSlotId,
      branch: false,
      speakerEntityId: speaker
    })
  )
  let version = ""
  await expect
    .poll(async () => {
      const path = await admin((api) =>
        api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      )
      const last = path.entries.at(-1)!
      version = last.version.id
      return path.entries.length > before.entries.length && last.version.status
    })
    .toBe("complete")
  return {
    version,
    slotId: (
      await admin((api) =>
        api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      )
    ).leafSlotId!
  }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the inspector shows whose context and what it left out at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const { chatId, slotId, forkId } = await threeCharacters()
      const ids = await castIds()
      const cast = (at: SlotId, c: object) => admin((api) => api.ChangeCast({ chatId, slotId: at, change: c as never }))
      await cast(slotId, { _tag: "ContextPerSpeaker", view: "separate" })
      // Wren steps out after the user's line; Mira answers; Wren is back and replies.
      await cast(slotId, { _tag: "Away", entityId: ids.wren, away: true })
      const mira = await reply(chatId, forkId!, ids.mira)
      await cast(mira.slotId, { _tag: "Away", entityId: ids.wren, away: false })
      const wren = await reply(chatId, forkId!, ids.wren)
      await page.goto(`${server().url}/chats/${chatId}/context/${wren.version}`)
      const section = page.getByRole("region", { name: "Whose context" })
      await expect(section.getByText("Separate contexts: written from Wren's view.", { exact: false })).toBeVisible()
      const left = section.getByRole("list", { name: "Left out of Wren's context" })
      await expect(left.getByRole("listitem")).toHaveCount(1)
      await expect(left.getByRole("link", { name: "Message 2 (Mira)", exact: true })).toBeVisible()
      await expect(left.getByText("Wren wasn't present", { exact: true })).toBeVisible()
      // The gap line that stands in for it is labelled among the request's parts.
      await expect(page.getByText(/^Gap line: message 2 left out/).first()).toBeAttached()
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `contexts-inspector-${width}-${theme}`, { scope: '[aria-label="Whose context"]' })
      // Mira's own reply saw everything: nothing was left out of her context.
      await page.goto(`${server().url}/chats/${chatId}/context/${mira.version}`)
      await expect(
        page.getByRole("region", { name: "Whose context" }).getByText("Mira was present for every message it read.", {
          exact: false
        })
      ).toBeVisible()
      // A narrator's reply: the whole chat.
      const last = await admin((api) =>
        api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      )
      await cast(last.leafSlotId!, { _tag: "Role", entityId: ids.tobin, role: "narrator" })
      const tobin = await reply(chatId, forkId!, ids.tobin)
      await page.goto(`${server().url}/chats/${chatId}/context/${tobin.version}`)
      await expect(
        page
          .getByRole("region", { name: "Whose context" })
          .getByText("Tobin is the narrator: this reply saw the whole chat", {
            exact: false
          })
      ).toBeVisible()
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
      await expect(
        page.getByText(/^Default: "\[\{\{char\}\} wasn't present for \{\{absentCount\}\} messages/)
      ).toBeVisible()
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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the inspector lists missed merged rows and keeps its branch at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const destination = await threeCharacters(),
        source = await threeCharacters(),
        ids = await castIds()
      await admin((api) =>
        api.ChangeCast({
          chatId: destination.chatId,
          slotId: destination.slotId,
          change: { _tag: "ContextPerSpeaker", view: "separate" }
        })
      )
      await admin((api) =>
        api.ChangeCast({
          chatId: source.chatId,
          slotId: source.slotId,
          change: { _tag: "Away", entityId: ids.wren, away: true }
        })
      )
      await reply(source.chatId, source.forkId!, ids.mira)
      const request = {
        chatId: destination.chatId,
        forkId: destination.forkId!,
        at: null,
        source: { chatId: source.chatId, forkId: source.forkId! },
        includeLeftOut: true
      }
      const preview = await admin((api) => api.PreviewChatMerge(request))
      const merged = await admin((api) =>
        api.MergeChat({ ...request, title: preview.sourceTitle, framing: null, digest: preview.digest })
      )
      const written = await reply(destination.chatId, destination.forkId!, ids.wren)
      await page.goto(
        `${server().url}/chats/${destination.chatId}/context/${written.version}?fork=${destination.forkId}`
      )
      const section = page.getByRole("region", { name: "Whose context" })
      const missed = section.getByRole("link", { name: /^Merged message 2 from/ })
      await expect(missed).toBeVisible()
      await expect(missed).toHaveAttribute("href", new RegExp(`slot=${merged.entry.slotId}`))
      await expect(missed).toHaveAttribute("href", new RegExp(`fork=${destination.forkId}`))
      await expect(section.getByRole("link", { name: /^Merged message 1 from/ })).toHaveCount(0)
      await expectLayout(page, info, `contexts-merged-inspector-${width}-${theme}`, {
        scope: '[aria-label="Whose context"]'
      })
    })
  }

/**
 * A separate-contexts chat where Wren missed message 2: the shared summaries of 1 and of 2–3,
 * and Wren's own of 2–3, written without the message she missed. Her own and the shared one
 * cover exactly the same messages.
 */
const summarizedChat = async () => {
  const { chatId, slotId, forkId } = await threeCharacters()
  const ids = await castIds()
  const cast = (at: SlotId, c: object) => admin((api) => api.ChangeCast({ chatId, slotId: at, change: c as never }))
  await cast(slotId, { _tag: "ContextPerSpeaker", view: "separate" })
  await cast(slotId, { _tag: "Away", entityId: ids.wren, away: true })
  // Mira answers while Wren is away; Wren is back for Mira's next lines.
  const missed = await reply(chatId, forkId!, ids.mira)
  await cast(missed.slotId, { _tag: "Away", entityId: ids.wren, away: false })
  await reply(chatId, forkId!, ids.mira)
  // The newest message is never summarized.
  await reply(chatId, forkId!, ids.mira)
  await admin((api) => api.SetLcmEnabled({ chatId, enabled: true }))
  const path = await admin((api) =>
    api.ReadPath({ chatId, forkId: forkId as never, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
  )
  const [first, second, third] = path.entries
  const dataDir = server().dataDir
  const opening = await level1(dataDir, chatId, [first!], "The inn's door opened.")
  const shared = await level1(dataDir, chatId, [second!, third!], "Mira nodded, then spoke of the lantern.")
  const own = await level1(dataDir, chatId, [second!, third!], "Wren came back as Mira spoke of the lantern.", {
    audience: [ids.wren],
    missed: [second!]
  })
  return { chatId, forkId: forkId as never, ids, opening, shared, own }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the Summaries panel shows a character's own summaries at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const { chatId } = await summarizedChat()
      await page.goto(`${server().url}/chats/${chatId}`)
      const panel = await openPanel(page, "Summaries")
      const inUse = panel.getByRole("list", { name: "Summaries in use" })
      await expect(inUse.getByRole("listitem")).toHaveCount(2)
      await expect(inUse.getByText("Wren's own", { exact: true })).toHaveCount(0)
      const picker = panel.getByRole("combobox", { name: /^Summaries of/ })
      await expect(picker).toHaveText(/Shared/)
      await picker.click()
      await page.getByRole("option", { name: /^Wren/ }).click()
      await expect(inUse.getByRole("listitem")).toHaveCount(2)
      const own = inUse.getByText("Wren's own", { exact: true })
      await expect(own).toBeVisible()
      await own.hover()
      await expect(page.getByText("Written for Wren alone", { exact: false }).filter({ visible: true })).toBeVisible()
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `contexts-summaries-${width}-${theme}`, {
        scope: '[role="tabpanel"][aria-label="Summaries"]'
      })
      await picker.click()
      await page.getByRole("option", { name: /^Shared/ }).click()
      await expect(inUse.getByText("Wren's own", { exact: true })).toHaveCount(0)
      await expect(inUse.getByRole("listitem")).toHaveCount(2)
    })
  }

/** The coverage rail on or off: an account setting, so each test that turns it on turns it off. */
const railSwitch = async (page: Page, on: boolean) => {
  const toggle = (await openPanel(page, "Summaries")).getByRole("switch", { name: /Coverage rail/ })
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(on))
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`whose summaries are shown is the tab's URL, and the rail draws them by id at ${width} ${theme}`, async ({
      page
    }, info) => {
      await look(page, width, theme)
      const { chatId, ids, opening, shared, own } = await summarizedChat()
      await page.goto(`${server().url}/chats/${chatId}`)
      let panel = await openPanel(page, "Summaries")
      const picker = () => panel.getByRole("combobox", { name: /^Summaries of/ })
      await picker().click()
      await page.getByRole("option", { name: /^Wren/ }).click()
      await expect(page).toHaveURL(new RegExp(`summariesOf=${ids.wren}`))
      await railSwitch(page, true)
      try {
        // Wren's view: the shared summary of 1 and her own of 2–3; the shared one of 2–3, over
        // exactly the same messages, isn't hers, so the rail draws hers there.
        const rail = page.getByTestId("coverage-rail")
        await expect(rail.locator(`[data-summary="${opening.id}"]`)).toHaveCount(1)
        await expect(rail.locator(`[data-summary="${own.id}"]`)).toHaveCount(1)
        await expect(rail.locator(`[data-summary="${shared.id}"]`)).toHaveCount(0)
        if (width === 390) await page.keyboard.press("Escape")
        await rail.locator(`[data-summary="${own.id}"]`).click()
        panel = await openPanel(page, "Summaries")
        await expect(panel.locator(`[data-summary="${own.id}"]`)).toBeVisible()
        await expect(panel.locator(`[data-summary="${shared.id}"]`)).toHaveCount(0)

        // A reload and a second tab with the same URL show Wren's summaries.
        await page.reload()
        panel = await openPanel(page, "Summaries")
        await expect(picker()).toHaveText(/Wren/)
        await expect(panel.getByText("Wren's own", { exact: true }).first()).toBeVisible()
        const second = await page.context().newPage()
        await second.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await second.goto(page.url())
        const other = await openPanel(second, "Summaries")
        await expect(other.getByRole("combobox", { name: /^Summaries of/ })).toHaveText(/Wren/)
        await expect(other.locator(`[data-summary="${own.id}"]`)).toBeVisible()
        await second.close()
        await page.mouse.move(0, 0)
        await expectLayout(page, info, `contexts-summaries-url-${width}-${theme}`, {
          scope: '[role="tabpanel"][aria-label="Summaries"]'
        })

        // Shared: the shared summary of 2–3 is drawn, Wren's isn't, and the URL says nothing.
        await picker().click()
        await page.getByRole("option", { name: /^Shared/ }).click()
        await expect(page).not.toHaveURL(/summariesOf=/)
        if (width === 390) await page.keyboard.press("Escape")
        await expect(rail.locator(`[data-summary="${shared.id}"]`)).toHaveCount(1)
        await expect(rail.locator(`[data-summary="${own.id}"]`)).toHaveCount(0)

        // A character no longer offered (or never one) falls back to Shared, quietly.
        await page.goto(`${server().url}/chats/${chatId}?summariesOf=${ids.tobin}0`)
        panel = await openPanel(page, "Summaries")
        await expect(picker()).toHaveText(/Shared/)
        await expect(page).not.toHaveURL(/summariesOf=/)
        await expect(page.getByText("This view is no longer available", { exact: false })).toHaveCount(0)
        await expect(panel.getByRole("alert")).toHaveCount(0)
      } finally {
        await railSwitch(page, false)
      }
    })
  }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`history search finds and replaces in a character's own summaries at ${width} ${theme}`, async ({
      page
    }, info) => {
      await look(page, width, theme)
      const { chatId, forkId, opening, shared, own } = await summarizedChat()
      await page.goto(`${server().url}/chats/${chatId}?panel=history`)
      await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
      const history = page.locator("[data-history-panel]")
      // Only the summaries, so the counts are theirs.
      await history.getByRole("button", { name: "Messages", exact: true }).click()
      await history.getByRole("button", { name: "Swipes", exact: true }).click()
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("lantern")
      await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("lamp")
      const status = page.getByRole("status").filter({ hasText: "in summaries" })
      // Shared: the shared summary of 2–3.
      await expect(status).toHaveText("0 in messages, 0 in swipes, 1 in summaries")
      await expect(history.getByText("Mira nodded", { exact: false })).toBeVisible()
      await expect(history.getByText("Wren came back", { exact: false })).toHaveCount(0)
      const picker = history.getByRole("combobox", { name: /^Summaries of/ })
      await picker.click()
      await page.getByRole("option", { name: /^Wren/ }).click()
      // Wren's: her own of 2–3 (the shared one of 2–3 holds the message she missed).
      await expect(history.getByText("Wren came back", { exact: false })).toBeVisible()
      await expect(history.getByText("Mira nodded", { exact: false })).toHaveCount(0)
      await expect(status).toHaveText("0 in messages, 0 in swipes, 1 in summaries")
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `contexts-history-${width}-${theme}`, { scope: "[data-history-panel]" })
      await page.getByRole("button", { name: "Replace all", exact: true }).click()
      await expect(page.getByText("History replaced", { exact: true })).toBeVisible()
      const text = (id: string) =>
        admin((api) => Effect.map(api.GetSummary({ forkId, summaryId: id as never }), (s) => s.content))
      await expect.poll(() => text(own.id)).toBe("Wren came back as Mira spoke of the lamp.")
      expect(await text(shared.id)).toBe("Mira nodded, then spoke of the lantern.")
      expect(await text(opening.id)).toBe("The inn's door opened.")
    })
  }

/**
 * A separate-contexts chat long enough to summarize, with Wren away for messages 10–19: the
 * estimate has a pass of her own.
 */
const longChat = async () => {
  const { chatId, slotId } = await threeCharacters()
  const ids = await castIds()
  await admin((api) =>
    Effect.gen(function* () {
      yield* api.ChangeCast({ chatId, slotId, change: { _tag: "ContextPerSpeaker", view: "separate" } })
      let parent = slotId
      for (let n = 2; n <= 40; n++) {
        const sent = yield* api.SendMessage({
          chatId,
          parentSlotId: parent,
          branch: false,
          content: `Message ${n}. ` + "The road ran on past the inn and the river. ".repeat(12)
        })
        if (sent._tag !== "Posted") return yield* Effect.die(new Error("the message was queued"))
        parent = sent.entry.slotId
      }
      // A new chat summarizes by default; turned off, enabling it shows the estimate first.
      yield* api.SetLcmEnabled({ chatId, enabled: false })
      yield* api.ChangeLcmSettings({
        chatId,
        change: { recentTarget: 600, recentMax: 1600, leafInput: 400, leafTarget: 60 }
      })
    })
  )
  const path = await admin((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }))
  await Effect.runPromise(
    fixtureSql(server().dataDir, [
      {
        sql: "UPDATE version_records SET cast_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
        params: [JSON.stringify([ids.mira, ids.tobin, ids.wren].sort()), chatId]
      },
      ...path.entries.slice(9, 19).map((entry) => ({
        sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
        params: [JSON.stringify({ away: [ids.wren] }), entry.version.id]
      }))
    ])
  )
  return { chatId }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the catch-up estimate shows each character's own pass at ${width} ${theme}`, async ({ page }, info) => {
      await look(page, width, theme)
      const { chatId } = await longChat()
      await page.goto(`${server().url}/chats/${chatId}`)
      const panel = await openPanel(page, "Summaries")
      await panel.getByRole("button", { name: "Enable summaries", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Summarize older messages" })
      const estimate = dialog.getByRole("group", { name: "Estimate" })
      const own = estimate.getByRole("list", { name: "Each character's own summaries" })
      await expect(own.getByRole("listitem")).toHaveCount(1)
      await expect(own).toContainText(/^Of these, for Wren alone: \d+ summar/)
      await expectLayout(page, info, `contexts-estimate-${width}-${theme}`, { scope: '[role="dialog"]' })
      await dialog.getByRole("button", { name: "Enable summaries", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      // The catch-up's estimate for what is left names her pass too.
      const catching = (await openPanel(page, "Summaries")).getByRole("region", { name: "Catching up" })
      await catching.getByText("Estimate for what is left", { exact: true }).click()
      await expect(
        catching.getByRole("list", { name: "Each character's own summaries" }).getByRole("listitem")
      ).toContainText("for Wren alone")
      await page.mouse.move(0, 0)
      await expectLayout(page, info, `contexts-catching-up-${width}-${theme}`, {
        scope: '[aria-label="Catching up"]'
      })
    })
  }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`Undo keeps a second tab's branch independent at ${width} ${theme}`, async ({ page, context }, info) => {
      await look(page, width, theme)
      const { chatId, slotId, forkId } = await threeCharacters()
      const ids = await castIds()
      await admin((api) =>
        api.ChangeCast({ chatId, forkId, slotId, change: { _tag: "ContextPerSpeaker", view: "separate" } })
      )
      // Synthetic scene-check result: no model request is needed to seed the shared mark.
      await Effect.runPromise(
        fixtureSql(server().dataDir, [
          { sql: "UPDATE chats SET state_seq=state_seq+1 WHERE id=?", params: [chatId] },
          {
            sql: `INSERT INTO state_events(id,chat_id,slot_id,seq,key,value_json,origin,created_at,fork_id,fork_seq)
              SELECT lower(hex(randomblob(16))), ?, ?, (SELECT coalesce(max(seq),0)+1 FROM state_events WHERE chat_id=?),
                'away.set', ?, 'user', 1, ?, (SELECT state_seq FROM chats WHERE id=?)`,
            params: [
              chatId,
              slotId,
              chatId,
              JSON.stringify({ entity: ids.wren, away: true, source: "decision" }),
              forkId!,
              chatId
            ]
          }
        ])
      )
      const sent = await admin((api) =>
        api.SendMessage({ chatId, forkId, parentSlotId: slotId, branch: false, content: "The shared secret is heron." })
      )
      if (sent._tag !== "Posted") throw new Error("synthetic message queued")
      const peer = await admin((api) => api.CreateFork({ chatId, fromForkId: forkId, atSlotId: sent.entry.slotId }))
      const other = await context.newPage()
      await other.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const reads = { marks: 0, cast: 0, path: 0, next: 0, summaries: 0 }
      let openingCache = false
      const pending = new Set<string>()
      const envelopes = (wire: string) => {
        const parsed: unknown = JSON.parse(wire)
        return (Array.isArray(parsed) ? parsed : [parsed]) as ReadonlyArray<{
          _tag?: string
          id?: string | number
          requestId?: string | number
          tag?: string
        }>
      }
      other.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          const wire = typeof payload === "string" ? payload : payload.toString()
          if (wire.includes('"_tag":"Cache"')) openingCache = true
          for (const message of envelopes(wire)) if (message._tag === "Exit") pending.delete(String(message.requestId))
        })
        socket.on("framesent", ({ payload }) => {
          const wire = typeof payload === "string" ? payload : payload.toString()
          for (const message of envelopes(wire))
            if (
              message._tag === "Request" &&
              ["GetNextContext", "GetLcmState", "GetLcmCoverage"].includes(message.tag ?? "")
            )
              pending.add(String(message.id))
          for (const [key, methods] of Object.entries({
            marks: ["GetAwayMarks"],
            cast: ["GetCast", "GetCasts"],
            path: ["ReadPath"],
            next: ["GetNextContext"],
            summaries: ["GetLcmState", "GetLcmCoverage"]
          })) {
            if (methods.some((method) => wire.includes(`"${method}"`))) reads[key as keyof typeof reads]++
          }
        })
      })
      try {
        await page.goto(`${server().url}/chats/${chatId}?fork=${forkId}`)
        await other.goto(`${server().url}/chats/${chatId}?fork=${peer.fork.id}`)
        const left = (tab: Page) => tab.locator("[data-away-row]").filter({ hasText: "Wren left · scene check" })
        await expect(left(page)).toBeVisible()
        await expect(left(other)).toBeVisible()
        await expect(left(other).getByRole("button", { name: "Undo", exact: true })).toBeVisible()
        // SubscribeChat starts a background estimate; under load it can arrive after
        // the away row. Wait for that snapshot and its reads before measuring Undo.
        await expect.poll(() => reads.marks).toBeGreaterThan(0)
        await expect.poll(() => openingCache).toBe(true)
        await expect.poll(() => pending.size).toBe(0)
        await other.waitForTimeout(800)
        const beforeReads = { ...reads }
        const unchangedRow = await left(other).elementHandle()
        await left(page).getByRole("button", { name: "Undo", exact: true }).click()
        await expect(left(page)).toHaveCount(0)
        await expect(left(other)).toBeVisible()
        await other.waitForTimeout(800)
        expect(await unchangedRow!.evaluate((node) => node.isConnected)).toBe(true)
        expect(reads).toEqual(beforeReads)
        await expectLayout(other, info, `branch-undo-peer-${width}-${theme}`, { scope: "[data-away-row]" })
        const marks = await admin((api) =>
          api.GetAwayMarks({ chatId, forkId: peer.fork.id, slotId: sent.entry.slotId })
        )
        expect(marks.some((m) => m.entityId === ids.wren && m.away && m.by === "decision")).toBe(true)
        const history = await admin((api) => api.ListHistoryEdits({ chatId, forkId: forkId! }))
        expect(history.some((r) => r.title === "Correct scene check")).toBe(true)
        expect(await admin((api) => api.ListHistoryEdits({ chatId, forkId: peer.fork.id }))).toEqual([])
        await page.reload()
        await other.reload()
        await expect(left(page)).toHaveCount(0)
        await expect(left(other)).toBeVisible()
      } finally {
        await other.close()
      }
    })
  }
