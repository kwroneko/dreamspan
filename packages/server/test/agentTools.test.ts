// The read tools over the chat's history (spec/AGENTIC.md §4.5), run by a scripted model in the
// narrator mode. Causal: the reply being written, and a later version of its message, are
// never found; only the messages before it are.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import { textField, valueField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { foldState, noteSwitches } from "@rp/shared/state.ts"
import { DatabaseSync } from "node:sqlite"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const call = (id: string, name: string, args: unknown) => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [],
    usage: { prompt_tokens: 90, completion_tokens: 5 }
  }
]

const script: ReadonlyArray<readonly [string, unknown]> = [
  ["search_chat", { query: "Ansel" }],
  ["search_chat", { query: "late" }],
  ["read_messages", { from: 1 }],
  ["expand_summary", { messages: "1–2" }],
  ["send_message", { message: "Ansel waves." }]
]

/** Each request takes the next call of the script, by how many results it already has. */
const scripted = (request: Recorded, res: ServerResponse) => {
  const done = ((request.body?.messages ?? []) as Array<{ role: string }>).filter((m) => m.role === "tool").length
  const [name, args] = script[Math.min(done, script.length - 1)]!
  sse(res, call(`call_${done}`, name, args))
}

describe("agent read tools", () => {
  it.live("search, read and summaries see only the messages before the reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scripted)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Ansel waves.")
      const results = (versionId: typeof version.id) =>
        api
          .GetRolloutSteps({ versionId })
          .pipe(Effect.map((steps) => steps.map((s) => (s.kind === "tool" ? [s.tool, s.result] : [s.kind]))))
      const expected = [
        ["search_chat", "No earlier messages match “Ansel”."],
        ["search_chat", "Message 1, Mira: *Mira looks up.* Late again, Tobin."],
        [
          "read_messages",
          "Message 1, Mira: *Mira looks up.* Late again, Tobin.\n\nMessage 2, Tobin: The road flooded."
        ],
        ["expand_summary", "This chat has no summaries."]
      ]
      assert.deepStrictEqual(yield* results(version.id), expected)

      // A second version of the reply's message: the first one, after its parent, isn't seen.
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      assert.strictEqual(finished(events, swipe.version.id)!.content, "Ansel waves.")
      assert.deepStrictEqual(yield* results(swipe.version.id), expected)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("set_presence holds while its version is shown, and a receipt makes it once", () => {
    const config = testConfig()
    let away = true
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const done = ((request.body?.messages ?? []) as Array<{ role: string }>).filter(
              (m) => m.role === "tool"
            ).length
            if (away && done === 0) sse(res, call("call_0", "set_presence", { character: "mira", present: false }))
            else sse(res, call(`call_${done}`, "send_message", { message: "Mira slips out." }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events, mira, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      const steps = yield* api.GetRolloutSteps({ versionId: version.id })
      assert.deepInclude(steps[0], {
        tool: "set_presence",
        status: "done",
        result: "Mira is away from the next message on.",
        effect: "chat_state"
      })
      assert.isTrue(
        events.some((e) => e._tag === "State"),
        "tool effects invalidate the live cast and notes"
      )
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const absentAt = Effect.map(
        reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId }),
        (e) => foldState(e).absent
      )
      assert.deepStrictEqual(yield* absentAt, [mira.entityId])

      // A later fork inherits the shown effect, and then keeps its own state when the
      // source fork swipes or deletes the message that produced it.
      const sourceFork = chat.currentForkId!
      const { fork: peer } = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: sourceFork,
        atSlotId: version.slotId
      })
      const peerAbsent = Effect.map(
        reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId, forkId: peer.id }),
        (e) => foldState(e).absent
      )
      assert.deepStrictEqual(yield* peerAbsent, [mira.entityId])

      // Its receipt: the same call again writes nothing and answers as before.
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const { rollout_id } = db.prepare("SELECT rollout_id FROM versions WHERE id = ?").get(version.id) as {
        rollout_id: string
      }
      db.close()
      const writer = yield* Writer
      const again = yield* writer.ApplyRolloutEffect({
        userId: me.id,
        rolloutId: rollout_id,
        toolCallId: "call_0",
        events: [{ key: "presence.set", value: { entity: mira.entityId, present: true } }],
        result: "other"
      })
      assert.deepStrictEqual(again, { result: "Mira is away from the next message on.", replayed: true })
      assert.deepStrictEqual(yield* absentAt, [mira.entityId])

      // A swipe that doesn't send her away: shown, it takes the first one's effect with it.
      away = false
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId, forkId: sourceFork })
      const swipe = yield* api.Regenerate({
        slotId: entry.slotId,
        expectedRowVersion: entry.rowVersion,
        forkId: sourceFork
      })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      const sourceAbsent = reader
        .StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId, forkId: sourceFork })
        .pipe(Effect.map((e) => foldState(e).absent))
      assert.deepStrictEqual(yield* sourceAbsent, [])
      assert.deepStrictEqual(yield* peerAbsent, [mira.entityId])
      // Selecting the effected swipe again restores the effect, then deleting the
      // message removes it only from the source fork.
      yield* api.SelectVersion({
        slotId: version.slotId,
        versionId: version.id,
        expectedVersionId: swipe.version.id,
        forkId: sourceFork
      })
      assert.deepStrictEqual(yield* sourceAbsent, [mira.entityId])
      yield* api.DeleteMessage({ slotId: version.slotId, forkId: sourceFork })
      assert.deepStrictEqual(yield* sourceAbsent, [])
      assert.deepStrictEqual(yield* peerAbsent, [mira.entityId])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("list_notes lists the chat's notes; switch_note changes only one the agent may change", () => {
    const config = testConfig()
    let phase: "plain" | "notes" = "plain"
    return Effect.gen(function* () {
      const notesScript: ReadonlyArray<readonly [string, unknown]> = [
        ["list_notes", {}],
        ["switch_note", { note: "Locked", on: false }],
        ["switch_note", { note: "weather", on: false }],
        ["send_message", { message: "Rain stops." }]
      ]
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const done = ((request.body?.messages ?? []) as Array<{ role: string }>).filter(
              (m) => m.role === "tool"
            ).length
            if (phase === "plain") return sse(res, call(`call_${done}`, "send_message", { message: "Hi." }))
            const [name, args] = notesScript[Math.min(done, notesScript.length - 1)]!
            sse(res, call(`call_${done}`, name, args))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      // Two chat notes, on: one the agent may change, one it may not.
      const note = (title: string, content: string, editable: boolean) =>
        Effect.gen(function* () {
          const ref = yield* api.CreateChatNote({ chatId: chat.id, title })
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
      const weather = yield* note("Weather", "It rains all day.", true)
      yield* note("Locked", "Mira owes Tobin.", false)
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const shown = Effect.map(reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId }), (e) =>
        noteSwitches(e).get(weather.entityId)
      )
      const before = yield* shown

      phase = "notes"
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      const steps = yield* api.GetRolloutSteps({ versionId: swipe.version.id })
      const results = steps.map((s) => (s.kind === "tool" ? s.result : null))
      assert.include(results[0] ?? "", "“Weather” (the chat's; ")
      assert.include(results[0] ?? "", "you may change it")
      assert.notInclude(results[0]?.split("\n").find((l) => l.startsWith("“Locked”")) ?? "", "you may change it")
      assert.strictEqual(results[1], "You may not change “Locked”.")
      assert.strictEqual(results[2], "“Weather” is off from the next message on.")
      assert.isFalse(yield* shown)
      assert.notStrictEqual(before, false)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
