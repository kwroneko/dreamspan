// What the model may change (spec/AGENTIC.md §4.3) in the browser: the card editor's Model may
// change list (side panel and full editor), saved with the card; the chat's Model may change
// section under Reply mode, starting from the card's and note's own settings, overriding them and
// Reset back to them; and a note the model wrote, listed in Notes only where the reply that wrote
// it is shown, and never in the library's note list (the note editor's switcher). A
// scripted loopback provider writes one note per reply. Layout audit on each surface, at 1440 and
// 390, light and dark. Every card and note here is made up.
import { mkdirSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let adminCookie = ""
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)
const shots = process.env.SCREENSHOT_DIR
test.setTimeout(180_000)

/** A provider whose every agent reply writes "Note N" (N counting replies since `reset`), then answers. */
const startNoteProvider = async () => {
  let replies = 0
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "notes",
      object: "chat.completion.chunk",
      model: "agent-small",
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: 50, completion_tokens: 5 }
    })}\n\n`
  const send = (res: ServerResponse, parts: Array<string>) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end([...parts, "data: [DONE]\n\n"].join(""))
  }
  const http = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ object: "list", data: [{ id: "agent-small", object: "model" }] }))
    }
    let raw = ""
    req.on("data", (c: Buffer) => (raw += c.toString()))
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string }>; tools?: unknown }
      if (body.tools && !body.messages.some((m) => m.role === "tool")) {
        replies++
        const args = { title: `Note ${replies}`, content: `Mira's hand is bandaged (${replies}).` }
        return send(res, [
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${replies}`,
                type: "function",
                function: { name: "write_note", arguments: JSON.stringify(args) }
              }
            ]
          }),
          chunk({}, "tool_calls")
        ])
      }
      send(res, [chunk({ role: "assistant", content: "Mira nods." }), chunk({}, "stop")])
    })
  })
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done))
  return {
    baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    reset: () => void (replies = 0),
    stop: () => new Promise<void>((done) => http.close(() => done()))
  }
}

let provider: Awaited<ReturnType<typeof startNoteProvider>>
test.beforeAll(async () => {
  provider = await startNoteProvider()
})
// Each test's replies count from 1: a worker runs several of them.
test.beforeEach(async () => {
  provider.reset()
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.afterAll(async () => {
  await provider.stop()
})

const importCard = async (page: Page, name: string) => {
  const data = {
    name,
    description: `${name} keeps the lighthouse ledger.`,
    personality: "Careful, warm.",
    scenario: "A stormy night at the lighthouse.",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "",
    extensions: {}
  }
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}

/** Waits for the reply at `slotId` to finish. */
const settled = (chatId: ChatId, slotId: SlotId) =>
  admin((api) =>
    Effect.gen(function* () {
      for (let i = 0; i < 200; i++) {
        const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
        const entry = path.entries.find((e) => e.slotId === slotId)
        if (entry && entry.version.status !== "generating") return entry
        yield* Effect.sleep("100 millis")
      }
      return yield* Effect.die("the reply didn't finish")
    })
  )

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`what the model may change, in the card and the chat, at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (!shots) return
        mkdirSync(shots, { recursive: true })
        await page.waitForTimeout(200)
        await page.screenshot({ path: resolve(shots, `${name}-${width}-${theme}.png`), animations: "disabled" })
      }
      const name = `Mira ${width} ${theme}`
      const card = await importCard(page, name)
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic notes",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "agent-small", overrides: {} })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
          const started = yield* api.StartChat({
            cards: [card.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "The lamp went out.", speakerEntityId: null }
          })
          const chatId = started.chat.id
          // A note of the user's own, which the library lists beside the model's, which it doesn't.
          yield* api.CreateChatNote({ chatId, title: `Lamp oil ${width} ${theme}`, content: "The lamp needs oil." })
          const modes = yield* api.ListReplyModes({})
          const narrator = modes.modes.find((m) => m.id === "narrator")!
          yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "ReplyMode", mode: "narrator" } })
          yield* api.ChangeCast({
            chatId,
            slotId: null,
            change: { _tag: "AgentTools", tools: [...narrator.tools, "write_note", "edit_note", "edit_card"] }
          })
          const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
          const reply = yield* api.Generate({ chatId, parentSlotId: path.entries.at(-1)!.slotId, branch: false })
          if (reply._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return { chatId, slotId: reply.entry.slotId }
        })
      )
      const first = await settled(fixture.chatId, fixture.slotId)
      // A swipe of the reply, which writes a note of its own.
      const swipe = await admin((api) => api.Regenerate({ slotId: first.slotId, expectedRowVersion: first.rowVersion }))
      await settled(fixture.chatId, fixture.slotId)

      // The card's own list, in the side-panel editor: Scenario ticked and saved with the card.
      await page.goto(`${server().url}/chats/${fixture.chatId}?panel=card:${card.entityId}`)
      const tab = page.getByRole("tabpanel").filter({ has: page.locator('[data-card-tabs="panel"]') })
      await expect(tab.getByRole("tablist", { name: "Card fields" })).toBeVisible({ timeout: 30_000 })
      const own = tab.getByRole("group", { name: "Model may change" })
      await own.scrollIntoViewIfNeeded()
      await expect(own.getByRole("checkbox")).toHaveCount(6)
      await expect(own.getByRole("checkbox", { name: "Scenario" })).not.toBeChecked()
      await own.getByRole("checkbox", { name: "Scenario" }).click()
      await expect(own.getByRole("checkbox", { name: "Scenario" })).toBeChecked()
      await saveRevision(tab)
      const doc = await admin((api) =>
        Effect.map(api.OpenEditor({ refId: card.id }), (opened) => opened.doc["agent_editable_fields"])
      )
      expect(doc).toEqual(["scenario"])
      await shot("card-panel")
      await expectLayout(page, info, `card-model-may-change-${width}-${theme}`, {
        scope: "[data-agent-editable-fields]"
      })

      // The chat's section: the card's choice, the note the shown reply wrote, and a change of its own.
      const settings = await openPanel(page, "This chat")
      const chat = settings.getByRole("group", { name: "Model may change" })
      const fields = chat.getByRole("group", { name: `${name}'s card` })
      await expect(fields.getByRole("checkbox", { name: "Scenario" })).toBeChecked()
      await expect(fields.getByRole("checkbox", { name: "Description" })).not.toBeChecked()
      const notes = chat.getByRole("group", { name: "Chat notes" })
      await expect(notes.getByRole("checkbox", { name: "Note 2" })).toBeChecked()
      await expect(notes.getByRole("checkbox", { name: "Note 1" })).toHaveCount(0)
      // No Reset while every box follows its note's or card's own setting.
      await expect(chat.getByRole("button", { name: "Reset" })).toHaveCount(0)
      await fields.getByRole("checkbox", { name: "Description" }).click()
      await expect(fields.getByRole("checkbox", { name: "Description" })).toBeChecked()
      const permissions = await admin((api) =>
        api.GetAgentPermissions({ chatId: fixture.chatId, slotId: fixture.slotId })
      )
      expect(permissions.cards[0]!.fields.find((f) => f.field === "description")).toEqual({
        field: "description",
        on: true,
        own: false,
        chosen: true
      })
      // The chat's choice has a Reset beside it, explained on hover; the note unticked has one too.
      const reset = fields.getByRole("button", { name: "Reset" })
      await expect(reset).toHaveCount(1)
      await expect(reset).toHaveAccessibleDescription(
        `Goes back to ${name}'s card setting: the model may not change its Description.`
      )
      await notes.getByRole("checkbox", { name: "Note 2" }).click()
      await expect(notes.getByRole("checkbox", { name: "Note 2" })).not.toBeChecked()
      await expect(notes.getByRole("button", { name: "Reset" })).toHaveCount(1)
      await chat.scrollIntoViewIfNeeded()
      await reset.hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText("Goes back to")
      await shot("chat-model-may-change")
      await expectLayout(page, info, `chat-model-may-change-${width}-${theme}`, { scope: "[data-agent-permissions]" })
      await page.mouse.move(0, 0)
      // Reset: the boxes follow the card's and the note's own settings again.
      const box = await fields.getByRole("checkbox", { name: "Description" }).boundingBox()
      await reset.click()
      await expect(fields.getByRole("checkbox", { name: "Description" })).not.toBeChecked()
      await expect(fields.getByRole("button", { name: "Reset" })).toHaveCount(0)
      // The box didn't move when its Reset went.
      expect(await fields.getByRole("checkbox", { name: "Description" }).boundingBox()).toEqual(box)
      await notes.getByRole("button", { name: "Reset" }).click()
      await expect(notes.getByRole("checkbox", { name: "Note 2" })).toBeChecked()
      await expect(chat.getByRole("button", { name: "Reset" })).toHaveCount(0)
      const after = await admin((api) => api.GetAgentPermissions({ chatId: fixture.chatId, slotId: fixture.slotId }))
      expect(after.cards[0]!.fields.find((f) => f.field === "description")).toEqual({
        field: "description",
        on: false,
        own: false,
        chosen: false
      })
      // Linking a note keeps a chat override. Its box is disabled, but Reset must still
      // drop that override: switch_note uses the same permission for its local activation.
      const lampBox = notes.getByRole("checkbox", { name: `Lamp oil ${width} ${theme}` })
      await lampBox.click()
      await expect(lampBox).toBeChecked()
      const lampNote = await admin((api) =>
        Effect.gen(function* () {
          const entries = yield* api.ListChatNotes({ chatId: fixture.chatId, slotId: fixture.slotId })
          const lamp = entries.find((n) => n.ref.label === `Lamp oil ${width} ${theme}`)!
          yield* api.CreateSharedNote({
            title: `Shared lamp ${width} ${theme}`,
            content: "The lamp needs oil.",
            fromNoteRefId: lamp.ref.id,
            chatNote: { chatId: fixture.chatId, slotId: fixture.slotId }
          })
          return lamp.ref
        })
      )
      await expect(lampBox).toBeDisabled()
      await expect(notes.getByRole("button", { name: "Reset" })).toHaveCount(1)
      await lampBox.scrollIntoViewIfNeeded()
      await shot("chat-linked-note-reset")
      await expectLayout(page, info, `linked-note-reset-${width}-${theme}`, { scope: "[data-agent-permissions]" })
      await notes.getByRole("button", { name: "Reset" }).click()
      await expect(notes.getByRole("button", { name: "Reset" })).toHaveCount(0)
      await expect(lampBox).not.toBeChecked()
      await expect(lampBox).toBeDisabled()
      const linkedReset = await admin((api) =>
        api.GetAgentPermissions({ chatId: fixture.chatId, slotId: fixture.slotId })
      )
      expect(linkedReset.notes.find((n) => n.entityId === lampNote.entityId)).toMatchObject({
        linked: true,
        on: false,
        own: false,
        chosen: false
      })
      await admin((api) =>
        api.UnlinkNote({
          noteRefId: lampNote.id,
          chatNote: { chatId: fixture.chatId, slotId: fixture.slotId }
        })
      )
      // Card swap, the chat's card layout: a switch of its own, with or without tools.
      const swap = settings.getByRole("region", { name: "Card swap" })
      await expect(swap.getByRole("switch", { name: "Card swap" })).not.toBeChecked()
      await swap.getByRole("switch", { name: "Card swap" }).click()
      await expect(swap.getByRole("switch", { name: "Card swap" })).toBeChecked()
      await swap.scrollIntoViewIfNeeded()
      await shot("card-swap-setting")
      await expectLayout(page, info, `card-swap-setting-${width}-${theme}`, { scope: '[aria-label="Card swap"]' })
      if (width === 390) await closePanel(page)

      // Notes: only the shown swipe's note; the other swipe shown, only its own.
      const notesTab = await openPanel(page, "Notes")
      await expect(notesTab.getByRole("region", { name: "Note Note 2" })).toBeVisible()
      await expect(notesTab.getByRole("region", { name: "Note Note 1" })).toHaveCount(0)
      await shot("notes")
      await expectLayout(page, info, `notes-agent-${width}-${theme}`, { scope: '[role="tabpanel"]' })
      await admin((api) =>
        api.SelectVersion({ slotId: first.slotId, versionId: first.version.id, expectedVersionId: swipe.version.id })
      )
      await expect(notesTab.getByRole("region", { name: "Note Note 1" })).toBeVisible()
      await expect(notesTab.getByRole("region", { name: "Note Note 2" })).toHaveCount(0)

      // The library's note list (the note editor's switcher) has the user's note, not the model's.
      const listed = await admin((api) => api.ListLibrary({ kind: "note" }))
      expect(listed.map((ref) => ref.label)).toContain(`Lamp oil ${width} ${theme}`)
      expect(listed.map((ref) => ref.label)).not.toContain("Note 1")
      expect(listed.map((ref) => ref.label)).not.toContain("Note 2")
      const lamp = listed.find((ref) => ref.label === `Lamp oil ${width} ${theme}`)!
      await page.goto(`${server().url}/library/${lamp.id}`)
      const switcher = page.getByRole("combobox", { name: "Switch note" })
      await expect(switcher).toBeVisible({ timeout: 30_000 })
      await switcher.click()
      const options = page.getByRole("option")
      await expect(options.filter({ hasText: `Lamp oil ${width} ${theme}` })).toHaveCount(1)
      await expect(options.filter({ hasText: /^Note [12]/ })).toHaveCount(0)
      await shot("note-switcher")
      await expectLayout(page, info, `note-switcher-${width}-${theme}`, { scope: '[role="listbox"]' })
      await page.keyboard.press("Escape")

      // The full editor has the same list, as saved.
      if (width === 1440) {
        await page.goto(`${server().url}/library/${card.id}`)
        const large = page.getByRole("group", { name: "Model may change" })
        await expect(large.getByRole("checkbox", { name: "Scenario" })).toBeChecked({ timeout: 30_000 })
        await large.scrollIntoViewIfNeeded()
        await shot("card-full")
        await expectLayout(page, info, `card-full-model-may-change-${width}-${theme}`, {
          scope: "[data-agent-editable-fields]"
        })
      }
    })
