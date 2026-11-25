import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { Chat } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
const call = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
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
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
const watch = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })
const edit = (api: Api, refId: RefId, content: string, key = "description") =>
  Effect.gen(function* () {
    const field = textField([key])
    const before = yield* api.OpenEditor({ refId })
    const draft = yield* api.SaveEditorDraft({
      refId,
      field,
      content,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: before.ref.headRevisionId
    })
    return yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: before.ref.rowVersion,
      fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
      message: null
    })
  })

const send = (api: Api, chat: Chat, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false, content })
    )
    return yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
  })
const path = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    return (yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: current.activeLeafSlotId,
      range: { _tag: "Bottom" },
      limit: 100
    })).entries
  })

it.live("keeps setup effects canonical across multi-message regeneration and message-local step edits", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let step = 0
    const calls = [
      ["create_card", { name: "Before" }],
      ["send_message", { message: "First setup message." }],
      ["edit_card", { card: "Before", changes: [{ field: "description", text: "Changed before second post." }] }],
      ["create_card", { name: "Middle" }],
      ["send_message", { message: "Second setup message." }],
      ["create_card", { name: "After" }]
    ] as const
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          if (!request.body?.tools) return sse(res, completionChunks(["Story."], {}))
          const next = calls[step++]
          sse(res, next ? call(next[0], next[1], `setup_${step}`) : completionChunks(["Setup complete."], {}))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: {},
      preset: { openai_max_context: 32768 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    yield* send(api, chat, "Build three cards.")
    yield* eventually(() =>
      events.some(
        (e) => e._tag === "Version" && e.version.status === "complete" && e.version.content === "Setup complete."
      )
    )
    const replies = (yield* path(api, chat)).filter((e) =>
      ["First setup message.", "Second setup message.", "Setup complete."].includes(e.version.content)
    )
    assert.lengthOf(replies, 3)
    const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
    assert.lengthOf(effects, 4)
    const expected = [["setup_1"], ["setup_3", "setup_4"], ["setup_6"]]
    for (const [i, reply] of replies.entries()) {
      const steps = yield* api.GetRolloutSteps({ versionId: reply.version.id })
      assert.deepStrictEqual(
        steps.flatMap((s) => (s.kind === "tool" ? [s.id] : [])),
        expected[i]
      )
      const run = yield* api.GetRunTranscript({ versionId: reply.version.id })
      assert.deepStrictEqual(
        run.entries.flatMap((e) => (e.role === "toolResult" && e.step !== undefined ? [[e.toolCallId, e.step]] : [])),
        expected[i]!.map((id, at) => [id, at])
      )
      assert.isTrue(
        expected[i]!.every((id) => effects.some((e) => e.toolCallId === id && e.rolloutId === effects[0]!.rolloutId))
      )
    }
    const creation = effects.find((e) => e.toolCallId === "setup_1")!
    const laterEdit = effects.find((e) => e.toolCallId === "setup_3")!
    const middle = replies[1]!
    const regenerated = yield* api.Regenerate({ slotId: middle.slotId, expectedRowVersion: middle.rowVersion })
    yield* eventually(() => finished(events, regenerated.version.id) !== undefined)
    assert.deepStrictEqual(
      yield* api.ListRolloutEffects({ chatId: chat.id }),
      effects,
      "regeneration retains all independent changes without duplicate undo records"
    )
    assert.isTrue((yield* path(api, chat)).some((e) => e.version.id === replies[0]!.version.id))
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: middle.slotId })
    const edited = yield* api.ResumeFromStep({
      versionId: middle.version.id,
      expectedRowVersion: slot.entry.rowVersion,
      step: 1,
      edit: { kind: "result", text: "Confirmed Middle exists." }
    })
    yield* eventually(() => finished(events, edited.version.id) !== undefined)
    assert.strictEqual(mock.requests().at(-1)!.body!.messages instanceof Array, true)
    assert.include(JSON.stringify(mock.requests().at(-1)!.body), "Confirmed Middle exists.")
    assert.deepStrictEqual(yield* api.ListRolloutEffects({ chatId: chat.id }), effects)
    const refId = creation.undo!.refId as RefId
    const head = (yield* api.OpenEditor({ refId })).ref.headRevisionId
    assert.strictEqual(head, laterEdit.undo!.head)
    yield* api.UndoRolloutEffect(creation)
    const afterUndo = yield* api.ListRolloutEffects({ chatId: chat.id })
    const binnedEdit = afterUndo.find((e) => e.toolCallId === laterEdit.toolCallId)!
    assert.isNotNull(binnedEdit.undoneAt)
    assert.deepStrictEqual(binnedEdit.undoResult, { binnedWithCreation: true })
    assert.isFalse((yield* api.ListLibrary({ kind: "card" })).some((c) => c.label === "Before"))
    assert.isTrue((yield* api.ListLibrary({ kind: "card" })).some((c) => c.label === "After"))
    const bin = yield* api.ListBin({ limit: 50, before: null })
    yield* api.RestoreBinItem({ itemId: bin.find((item) => item.title === "Before")!.id })
    const restored = yield* api.OpenEditor({ refId })
    assert.strictEqual(restored.ref.headRevisionId, head)
    assert.strictEqual(restored.doc.description, "Changed before second post.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

for (const change of ["undo", "edit", "ancestor-undo", "ancestor-edit", "unchanged", "agent-edit"] as const) {
  it.live(`rechecks setup effects before continuity: ${change}`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let creates = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            if (!request.body?.tools) return sse(res, completionChunks(["Story."], {}))
            const at = creates++
            sse(
              res,
              at === 0
                ? call("create_card", { name: "Continuity keeper" }, "keeper_1")
                : change === "agent-edit" && at === 1
                  ? call(
                      "edit_card",
                      { card: "Continuity keeper", changes: [{ field: "description", text: "Agent update." }] },
                      "keeper_edit"
                    )
                  : completionChunks(["Turn complete."], {})
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: {},
        preset: { openai_max_context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const first = yield* send(api, chat, "Make a keeper")
      yield* eventually(() => finished(events, first.entry.version.id) !== undefined)
      if (change.startsWith("ancestor")) {
        const second = yield* send(api, chat, "Carry on")
        yield* eventually(() => finished(events, second.entry.version.id) !== undefined)
      }
      const effect = (yield* api.ListRolloutEffects({ chatId: chat.id }))[0]!
      if (change.endsWith("undo")) yield* api.UndoRolloutEffect(effect)
      else if (change === "edit" || change === "ancestor-edit")
        yield* edit(api, effect.undo!.refId as RefId, "The owner changed the card.")
      const before = mock.requests().length
      const next = yield* send(api, chat, "New user message survives fallback")
      yield* eventually(() => finished(events, next.entry.version.id) !== undefined)
      const user = yield* api.Whoami()
      const material = yield* (yield* Reader).RolloutMaterial({ userId: user.id, versionId: next.entry.version.id })
      const snapshot = JSON.parse(material.snapshot)
      const body = JSON.stringify(mock.requests()[before]!.body)
      assert.include(body, "New user message survives fallback")
      if (change === "unchanged" || change === "agent-edit") {
        assert.isDefined(snapshot.continuity.parent)
        assert.include(body, "keeper_1")
      } else {
        assert.isUndefined(snapshot.continuity.parent)
        assert.match(snapshot.continuity.reason, /undone|library|changed/i)
        assert.notInclude(body, "keeper_1", "stale tool success is not carried")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
}

it.live("resumes stopped multi-message setup work without repeating committed calls", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let step = 0
    let held = false
    const calls = [
      ["create_card", { name: "Stopped first" }],
      ["send_message", { message: "Created the first card." }],
      ["create_card", { name: "Stopped second" }]
    ] as const
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          if (!request.body?.tools) return sse(res, completionChunks(["Story."], {}))
          const next = calls[step++]
          if (step === 4) {
            held = true
            res.writeHead(200, { "content-type": "text/event-stream" })
            return
          }
          sse(res, next ? call(next[0], next[1], `stopped_${step}`) : completionChunks(["Resumed setup complete."], {}))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: {},
      preset: { openai_max_context: 32768 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    yield* send(api, chat, "Make two cards.")
    yield* eventually(() => held)
    const working = (yield* path(api, chat)).at(-1)!
    yield* api.StopGeneration({ versionId: working.version.id })
    yield* eventually(() => finished(events, working.version.id) !== undefined)
    const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: working.slotId })
    const resumed = yield* api.ResumeVersion({
      versionId: working.version.id,
      expectedRowVersion: slot.entry.rowVersion
    })
    yield* eventually(() => finished(events, resumed.version.id) !== undefined)
    assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
    assert.deepStrictEqual(yield* api.ListRolloutEffects({ chatId: chat.id }), effects)
    assert.deepStrictEqual(
      (yield* api.GetRolloutSteps({ versionId: resumed.version.id })).flatMap((s) => (s.kind === "tool" ? [s.id] : [])),
      ["stopped_3"]
    )
    assert.lengthOf(
      (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label.startsWith("Stopped ")),
      2
    )
    yield* api.UndoRolloutEffect(effects.find((e) => e.toolCallId === "stopped_1")!)
    assert.lengthOf(
      (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label.startsWith("Stopped ")),
      1
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("enforces the mutation and argument limits independently in a carried turn with reused call ids", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let turn = 0
    const batch = (items: ReadonlyArray<{ name: string; args: unknown; id: string }>) => {
      const chunks = call("create_card", {}, "unused")
      chunks[0]!.choices[0]!.delta = {
        role: "assistant",
        tool_calls: items.map((item, index) => ({
          index,
          id: item.id,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.args) }
        }))
      }
      return chunks
    }
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          if (!request.body?.tools) return sse(res, completionChunks(["Story."], {}))
          const at = turn++
          sse(
            res,
            at === 0
              ? batch(
                  Array.from({ length: 33 }, (_, i) => ({
                    name: "create_card",
                    args: { name: `Bounded first ${i}` },
                    id: `batch_${i}`
                  }))
                )
              : at === 2
                ? batch([
                    { name: "create_card", args: { name: "Carried keeper" }, id: "batch_0" },
                    { name: "create_card", args: { name: "Unexpected field", permission: true }, id: "bad-field" },
                    {
                      name: "create_card",
                      args: { name: "Oversized", description: "x".repeat(65_537) },
                      id: "bad-size"
                    }
                  ])
                : completionChunks(["Batch complete."], {})
          )
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: { context: 128_000 },
      preset: { openai_max_context: 128_000 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    const first = yield* send(api, chat, "Make a bounded batch.")
    yield* eventually(() => finished(events, first.entry.version.id) !== undefined)
    const firstEffects = yield* api.ListRolloutEffects({ chatId: chat.id, limit: 200 })
    assert.lengthOf(firstEffects, 32)
    const firstSteps = yield* api.GetRolloutSteps({ versionId: first.entry.version.id })
    assert.isTrue(firstSteps.some((s) => s.kind === "tool" && s.id === "batch_32" && s.status === "error"))
    // The second turn has its own mutation budget; historical successes are context, not
    // receipts for this run. The same call id may therefore make a distinct new change.
    const second = yield* send(api, chat, "Carry on with one more keeper.")
    yield* eventually(() => finished(events, second.entry.version.id) !== undefined)
    const me = yield* api.Whoami()
    const material = yield* (yield* Reader).RolloutMaterial({ userId: me.id, versionId: second.entry.version.id })
    assert.isDefined(JSON.parse(material.snapshot).continuity.parent)
    const effects = yield* api.ListRolloutEffects({ chatId: chat.id, limit: 200 })
    assert.lengthOf(effects, 33)
    const current = effects.filter((e) => e.rolloutId === material.rolloutId)
    assert.lengthOf(current, 1)
    assert.strictEqual(current[0]!.toolCallId, "batch_0")
    const steps = (yield* api.GetRolloutSteps({ versionId: second.entry.version.id })).filter((s) => s.kind === "tool")
    assert.deepStrictEqual(
      steps.map((s) => [s.id, s.status]),
      [
        ["batch_0", "done"],
        ["bad-field", "error"],
        ["bad-size", "error"]
      ]
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
