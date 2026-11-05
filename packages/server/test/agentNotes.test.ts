// The note and card tools (spec/AGENTIC.md §4.3, §4.5, §4.6), run by a scripted model in the
// narrator mode: notes the agent writes and edits, what it may change (the note's flag, its own
// notes, the chat's override), and a card's field changed through notes in the owner's costume
// example, each attached to the reply so a swipe takes it back.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { textField, valueField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const chunk = (delta: unknown, finish: string | null) => ({
  id: "cmpl-n",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})
const call = (id: string, name: string, args: unknown) => [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null),
  chunk({}, "tool_calls"),
  { id: "cmpl-n", object: "chat.completion.chunk", model: "served-model", choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }
]

type Script = ReadonlyArray<readonly [string, unknown]>

/** A model that runs the current script, a call per request, then sends a plain reply. */
const scriptedModel = () => {
  let script: Script = []
  const handler = (request: Recorded, res: ServerResponse) => {
    const done = ((request.body?.messages ?? []) as Array<{ role: string }>).filter((m) => m.role === "tool").length
    const next = script[done]
    sse(res, next ? call(`call_${done}`, next[0], next[1]) : call(`call_${done}`, "send_message", { message: "Mira nods." }))
  }
  return { handler, run: (next: Script) => (script = next) }
}

type Api = Effect.Success<ReturnType<typeof client>>

/** A chat note with this text, which the agent may change or not, made from the editor. */
const chatNote = (api: Api, chatId: ChatId, title: string, content: string, editable: boolean) =>
  Effect.gen(function* () {
    const ref = yield* api.CreateChatNote({ chatId, title })
    const save = (field: string, value: string) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: ref.id as RefId })
        const existing = opened.drafts.find((d) => d.key.field === field)
        yield* api.SaveEditorDraft({
          draftId: null,
          expectedSession: null,
          refId: ref.id as RefId,
          field,
          content: value,
          expectedRowVersion: existing?.rowVersion ?? null,
          baseRevisionId: existing?.status === "active" ? null : opened.ref.headRevisionId
        })
      })
    yield* save(textField(["content"]), content)
    if (editable) yield* save(valueField(["agent_editable"]), "true")
    const opened = yield* api.OpenEditor({ refId: ref.id as RefId })
    yield* api.CommitEditorDrafts({
      refId: ref.id as RefId,
      expectedRowVersion: opened.ref.rowVersion,
      fields: opened.drafts
        .filter((d) => d.status === "active")
        .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
      message: null
    })
    return ref
  })

/** Each tool step's result, in order. */
const stepResults = (api: Api, versionId: VersionId) =>
  api.GetRolloutSteps({ versionId }).pipe(Effect.map((steps) => steps.flatMap((s) => (s.kind === "tool" ? [s.result] : []))))

describe("agent note tools", () => {
  it.live("write_note and edit_note change only what the chat allows, and a swipe takes it back", () => {
    const config = testConfig()
    const model = scriptedModel()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(model.handler)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      const locked = yield* chatNote(api, chat.id, "Locked", "Mira owes Tobin.", false)
      yield* chatNote(api, chat.id, "Private", "Tobin owes Mira.", false)
      const me = yield* api.Whoami()
      const writer = yield* Writer
      // The chat lets the agent change "Locked", though the note itself doesn't.
      yield* writer.AddStateEvent({
        userId: me.id as UserId,
        chatId: chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "agent.permission", value: { note: locked.entityId, on: true } }
      })

      model.run([
        ["write_note", { title: "Injury", content: "Mira's left hand is bandaged." }],
        ["write_note", { title: "injury", content: "Again." }],
        ["edit_note", { note: "Injury", find: "left", replace: "right" }],
        ["edit_note", { note: "Private", find: "owes", replace: "pays" }],
        ["edit_note", { note: "Locked", content: "Mira and Tobin are even." }],
        ["list_notes", {}]
      ])
      const reader = yield* Reader
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      const results = yield* stepResults(api, swipe.version.id)
      assert.deepStrictEqual(results.slice(0, 5), [
        "Wrote “Injury”: it's on from the next message on.",
        "A note called “injury” exists: change it with edit_note.",
        "Changed “Injury” from the next message on.",
        "You may not change “Private”.",
        "Changed “Locked” from the next message on."
      ])
      // Read mid-reply: the note it wrote, on, with the change it made.
      assert.include(results[5] ?? "", "“Injury” (the chat's; on; you may change it)")

      const notesAt = Effect.gen(function* () {
        const entries = yield* reader.ChatNoteEntries({
          userId: me.id,
          chatId: chat.id,
          slotId: version.slotId as SlotId,
          cards: []
        })
        const switches = new Map(
          (yield* reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId })).flatMap((e) =>
            e.data.key === "note.activate" || e.data.key === "note.deactivate"
              ? [[e.data.value.note as string, e.data.key === "note.activate"] as const]
              : []
          )
        )
        return Object.fromEntries(
          entries.map((e) => [String(e.doc["title"]), [String(e.doc["content"]), switches.get(e.ref.entityId) ?? false]])
        )
      })
      assert.deepStrictEqual(yield* notesAt, {
        Injury: ["Mira's right hand is bandaged.", true],
        Locked: ["Mira and Tobin are even.", false],
        Private: ["Tobin owes Mira.", false]
      })

      // The first version shown again: the agent's note is off and the edit undone there.
      yield* api.SelectVersion({ slotId: version.slotId, versionId: version.id, expectedVersionId: swipe.version.id })
      const back = yield* notesAt
      assert.deepStrictEqual(back["Locked"], ["Mira owes Tobin.", false])
      assert.isFalse(back["Injury"]![1])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("edit_card changes a costume through notes: the field once, the tail after, a swipe undoing both", () => {
    const config = testConfig()
    const model = scriptedModel()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(model.handler)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        mira: {
          description: "Mira keeps the ledger.\n\nShe wears a grey travelling coat.\n\nShe hums while she works.",
          agent_editable_fields: ["description"]
        },
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const chats = () => mock.requests().filter((r) => Array.isArray(r.body?.["messages"]))
      const text = (r: Recorded) =>
        ((r.body?.["messages"] ?? []) as Array<{ role: string; content: unknown }>).map((m) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        )
      /** A user message, then a reply that runs `script`: its version and its first request. */
      const turn = (parent: SlotId, script: Script) =>
        Effect.gen(function* () {
          model.run(script)
          const from = chats().length
          const sent = yield* posted(
            api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: false, content: "Go on." })
          )
          const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
          yield* eventually(() => finished(events, entry.version.id) !== undefined)
          return { version: entry.version, request: text(chats()[from]!) }
        })
      /** The request up to the message with the card's definition: what the cache keeps if unchanged. */
      const top = (request: ReadonlyArray<string>) =>
        request.slice(0, request.findIndex((m) => m.includes("Mira keeps the ledger.")) + 1).join("\n")

      const before = text(chats()[0]!)
      assert.include(top(before), "She wears a grey travelling coat.")
      const edit = yield* turn(version.slotId as SlotId, [
        ["edit_card", { character: "Mira", field: "personality", find: "x", replace: "y" }],
        ["edit_card", { character: "Mira", field: "description", find: "Her coat", replace: "A gown" }],
        [
          "edit_card",
          { character: "Mira", field: "description", find: "She wears a grey travelling coat.", replace: "She wears a red ball gown." }
        ]
      ])
      assert.deepStrictEqual(yield* stepResults(api, edit.version.id), [
        "You may not change Mira's personality.",
        "The passage isn't in it: give it exactly as it stands. (Mira's description)",
        "Changed Mira's description from the next message on."
      ])
      // The next request: the description without the passage, in its place; the costume at the tail.
      const after = yield* turn(edit.version.slotId as SlotId, [])
      assert.include(top(after.request), "She hums while she works.")
      assert.notInclude(after.request.join("\n"), "grey travelling coat")
      assert.notStrictEqual(top(after.request), top(before))
      const tailAt = after.request.findIndex((m) => m.includes("[Mira's current description: She wears a red ball gown.]"))
      assert.isAbove(tailAt, after.request.findIndex((m) => m.includes("Go on.")), "the costume goes at the tail")

      // Changed again: only the tail note changes, so the top of the request stays as it was.
      const again = yield* turn(after.version.slotId as SlotId, [
        ["edit_card", { character: "Mira", field: "description", find: "red ball gown", replace: "muddy ball gown" }]
      ])
      assert.deepStrictEqual(yield* stepResults(api, again.version.id), ["Changed Mira's description from the next message on."])
      const later = yield* turn(again.version.slotId as SlotId, [])
      assert.strictEqual(top(later.request), top(after.request))
      assert.include(later.request.join("\n"), "[Mira's current description: She wears a muddy ball gown.]")
      assert.notInclude(later.request.join("\n"), "red ball gown")

      // A swipe of the reply that made the change: the description is whole again, and no costume note.
      model.run([])
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: edit.version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      const restored = yield* turn(later.version.slotId as SlotId, [])
      assert.include(top(restored.request), "She wears a grey travelling coat.")
      assert.notInclude(restored.request.join("\n"), "ball gown")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
