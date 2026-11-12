import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { Chat, VersionId } from "@rp/shared/chat.ts"
import { Effect, Stream } from "effect"
import { textField } from "@rp/shared/editing.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const call = (name: string, args: unknown, id: string) => [
  {
    id: "multi",
    object: "chat.completion.chunk",
    model: "mock-model",
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
    id: "multi",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
type Api = Effect.Success<ReturnType<typeof client>>
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
const send = (api: Api, chat: Chat, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false, content })
    )
    return yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
  })
const done = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>) =>
  Effect.gen(function* () {
    yield* eventually(() =>
      events.some(
        (e) => e._tag === "Version" && e.version.status === "complete" && e.version.content === "Final message."
      )
    )
    const current = yield* api.GetChat({ chatId: chat.id })
    return yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: current.activeLeafSlotId,
      range: { _tag: "Bottom" },
      limit: 100
    })
  })

describe("workshop messages and continuity", () => {
  it.live("posts two messages and a final answer with separate steps from one run", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const body = request.body!
            if (!body.tools) return sse(res, completionChunks(["Story reply."], {}))
            const messages = body.messages as Array<{ role: string }>
            const count = messages.filter((m) => m.role === "tool").length
            const calls = [
              ["list_library", { kind: "card" }],
              ["send_message", { message: "First message." }],
              ["read_card", { card: "Assistant" }],
              ["send_message", { message: "Second message." }],
              ["read_preset", { preset: "Workshop" }]
            ] as const
            const next = calls[count]
            sse(res, next ? call(next[0], next[1], `multi_${count}`) : completionChunks(["Final message."], {}))
          })
        ),
        (mock) => Effect.promise(() => mock.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        preset: { openai_max_context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const start = yield* send(api, chat, "Do the work.")
      const path = yield* done(api, chat, events)
      const replies = path.entries.filter((e) =>
        ["First message.", "Second message.", "Final message."].includes(e.version.content)
      )
      assert.lengthOf(replies, 3)
      assert.strictEqual(replies[0]!.version.id, start.entry.version.id)
      assert.isFalse(path.entries.some((e) => e.version.status === "generating"))
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const materials = yield* Effect.forEach(replies, (entry) =>
        reader.RolloutMaterial({ userId: me.id, versionId: entry.version.id })
      )
      assert.strictEqual(new Set(materials.map((m) => m.rolloutId)).size, 1)
      for (const [index, entry] of replies.entries()) {
        const steps = yield* api.GetRolloutSteps({ versionId: entry.version.id })
        assert.deepStrictEqual(
          steps.filter((s) => s.kind === "tool").map((s) => s.tool),
          [["list_library"], ["read_card"], ["read_preset"]][index]
        )
        assert.strictEqual(entry.version.steps?.count, 1)
        const inspected = yield* api.GetRunTranscript({ versionId: entry.version.id })
        const local = inspected.entries.flatMap((e) =>
          e.role === "toolResult" && e.step !== undefined ? [[e.tool, e.step]] : []
        )
        assert.deepStrictEqual(
          local,
          [[["list_library", "read_card", "read_preset"][index], 0]],
          "inspector uses the viewed message's step indices"
        )
      }
      const transcript = JSON.parse(materials[0]!.transcript!) as Array<{
        role: string
        details?: { versionId: VersionId }
      }>
      assert.deepStrictEqual(
        transcript.flatMap((m) => (m.details?.versionId ? [m.details.versionId] : [])),
        replies.slice(0, 2).map((e) => e.version.id)
      )
      // Swiping message 2 keeps message 1, leaves the old branch intact, and samples
      // neither earlier tools nor message 1 again.
      const beforeSwipe = mock.requests().length
      const second = replies[1]!
      yield* api.Regenerate({ slotId: second.slotId, expectedRowVersion: second.rowVersion })
      yield* eventually(() =>
        events
          .slice()
          .reverse()
          .some(
            (e) =>
              e._tag === "Version" &&
              e.version.content === "Final message." &&
              e.version.id !== replies[2]!.version.id &&
              e.version.status === "complete"
          )
      )
      const current = yield* api.GetChat({ chatId: chat.id })
      const swiped = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: current.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 100
      })
      assert.strictEqual(
        swiped.entries.find((e) => e.version.content === "First message.")!.version.id,
        replies[0]!.version.id
      )
      assert.isFalse(swiped.entries.some((e) => e.version.id === replies[2]!.version.id))
      assert.strictEqual(
        (yield* reader.GetVersion({ userId: me.id, versionId: replies[2]!.version.id })).content,
        "Final message."
      )
      const kept = mock.requests()[beforeSwipe]!.body!.messages as Array<unknown>
      assert.include(JSON.stringify(kept), "First message.")
      assert.notInclude(JSON.stringify(kept), "Final message.")
      const versions = yield* api.ListVersions({ slotId: second.slotId })
      assert.lengthOf(versions, 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

for (const [kind, cacheMode] of [
  ["openai-chat", "explicit"],
  ["anthropic", "explicit"],
  ["anthropic", "auto"]
] as const) {
  it.live(`${kind} ${cacheMode}: carries the exact previous request and transcript prefix into the next turn`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let number = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (request, res) => {
            const body = request.body!
            const messages = body.messages as Array<{ role: string; content: string | Array<{ type: string }> }>
            const last = messages.at(-1)!
            const answered =
              last.role === "tool" ||
              (Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result"))
            const useTool = Array.isArray(body.tools) && body.tools.length > 0 && !answered
            if (kind === "openai-chat")
              return sse(
                res,
                useTool
                  ? call("read_card", { card: "Assistant" }, `turn_${++number}`)
                  : completionChunks(["Final message."], {})
              )
            const { anthropicSse } = await import("./support/mockProvider.ts")
            const start = {
              type: "message_start",
              message: {
                id: `msg_${++number}`,
                type: "message",
                role: "assistant",
                model: "mock-model",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 1 }
              }
            }
            anthropicSse(
              res,
              useTool
                ? [
                    start,
                    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "thinking_delta", thinking: "Check the library." }
                    },
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "signature_delta", signature: "c3ludGhldGljLXNpZ25hdHVyZQ==" }
                    },
                    { type: "content_block_stop", index: 0 },
                    {
                      type: "content_block_start",
                      index: 1,
                      content_block: { type: "redacted_thinking", data: "c3ludGhldGljLXJlZGFjdGVk" }
                    },
                    { type: "content_block_stop", index: 1 },
                    {
                      type: "content_block_start",
                      index: 2,
                      content_block: { type: "tool_use", id: `toolu_${number}`, name: "read_card", input: {} }
                    },
                    {
                      type: "content_block_delta",
                      index: 2,
                      delta: { type: "input_json_delta", partial_json: '{"card":"Assistant"}' }
                    },
                    { type: "content_block_stop", index: 2 },
                    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
                    { type: "message_stop" }
                  ]
                : [
                    start,
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Final message." } },
                    { type: "content_block_stop", index: 0 },
                    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
                    { type: "message_stop" }
                  ]
            )
          })
        ),
        (mock) => Effect.promise(() => mock.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: {
          kind,
          baseUrl: kind === "anthropic" ? mock.url : `${mock.url}/v1`,
          ...(kind === "anthropic" ? { apiKey: "synthetic-key" } : {})
        },
        model: { cacheBreakpoints: cacheMode },
        preset: { openai_max_context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const first = yield* send(api, chat, "First request.")
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.id === first.entry.version.id && e.version.status === "complete"
        )
      )
      const previous = mock.requests().at(-1)!.body!
      if (kind === "anthropic") {
        assert.include(JSON.stringify(previous.messages), "c3ludGhldGljLXNpZ25hdHVyZQ==")
        assert.include(JSON.stringify(previous.messages), "c3ludGhldGljLXJlZGFjdGVk")
      }
      const before = mock.requests().length
      const second = yield* send(api, chat, "Second request.")
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.id === second.entry.version.id && e.version.status === "complete"
        )
      )
      const next = mock.requests()[before]!.body!
      const prefix = previous.messages as Array<unknown>
      assert.strictEqual(
        JSON.stringify((next.messages as Array<unknown>).slice(0, prefix.length)),
        JSON.stringify(prefix),
        "provider cache prefix bytes"
      )
      assert.strictEqual(JSON.stringify(next.tools), JSON.stringify(previous.tools))
      assert.strictEqual(JSON.stringify(next.system), JSON.stringify(previous.system))
      const tail = (next.messages as Array<unknown>).slice(prefix.length)
      assert.include(JSON.stringify(tail), "Final message.")
      assert.include(JSON.stringify(tail), "Second request.")
      assert.notInclude(JSON.stringify(prefix), "Second request.", "no look-ahead")
      const run = yield* api.GetRunContext({ versionId: second.entry.version.id })
      assert.strictEqual(run.continuity?.parentVersionId, first.entry.version.id)
      const reader = yield* Reader
      const user = yield* api.Whoami()
      const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: second.entry.version.id })
      assert.include(material.transcript!, "Practical and brief.")
      const rebuilt = yield* reader.RebuildContext({ userId: user.id, snapshot: material.snapshot })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt")
        assert.strictEqual(
          JSON.stringify(JSON.parse(rebuilt.snapshot).request),
          JSON.stringify(JSON.parse(material.snapshot).request)
        )
      assert.isTrue(
        (yield* api.GetRunTranscript({ versionId: second.entry.version.id })).entries.some(
          (e) => e.role === "app" && e.text.includes("Second request.")
        )
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
}

it.live("removes the empty working slot after a final empty answer, with no bin entry", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const messages = request.body!.messages as Array<{ role: string }>
          sse(
            res,
            !request.body!.tools
              ? completionChunks(["Story."], {})
              : messages.at(-1)?.role === "tool"
                ? completionChunks([], {})
                : call("send_message", { message: "Only message." }, "only_send")
          )
        })
      ),
      (mock) => Effect.promise(() => mock.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      preset: { openai_max_context: 32768 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    const first = yield* send(api, chat, "One message please.")
    yield* eventually(() => events.some((e) => e._tag === "Reload"))
    const current = yield* api.GetChat({ chatId: chat.id })
    const path = yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: current.activeLeafSlotId,
      range: { _tag: "Bottom" },
      limit: 100
    })
    assert.strictEqual(current.activeLeafSlotId, first.entry.slotId)
    assert.strictEqual(path.entries.at(-1)!.version.content, "Only message.")
    assert.lengthOf(path.entries, 3)
    const { fixtureSql } = yield* Effect.promise(() => import("./support/lcmFixtures.ts"))
    const [rows] = yield* fixtureSql(
      config.dataDir,
      [{ sql: "SELECT count(*) AS n FROM slots WHERE chat_id = ?", params: [chat.id] }],
      { readOnly: true }
    )
    assert.strictEqual(rows![0]!.n, 3)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

for (const ending of ["stop", "failure"] as const)
  it.live(`${ending} after a post preserves it and Resume continues the working message`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let waiting = false
      let resume = false
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            if (!request.body!.tools) return sse(res, completionChunks(["Story."], {}))
            const messages = request.body!.messages as Array<{ role: string }>
            if (messages.at(-1)?.role !== "tool")
              return sse(res, call("send_message", { message: "Already posted." }, "post_before_stop"))
            if (resume) return sse(res, completionChunks(["Resumed answer."], {}))
            waiting = true
            if (ending === "failure") {
              res.writeHead(400, { "content-type": "application/json" })
              res.end(JSON.stringify({ error: { message: "Synthetic request failure." } }))
            } else {
              res.writeHead(200, { "content-type": "text/event-stream" })
              res.flushHeaders()
            }
          })
        ),
        (mock) => Effect.promise(() => mock.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        preset: { openai_max_context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const start = yield* send(api, chat, "Work then wait.")
      yield* eventually(() => waiting)
      const current = yield* api.GetChat({ chatId: chat.id })
      const path = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: current.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 100
      })
      const working = path.entries.at(-1)!
      if (ending === "stop") yield* api.StopGeneration({ versionId: working.version.id })
      else
        yield* eventually(() =>
          events.some(
            (e) => e._tag === "Version" && e.version.id === working.version.id && e.version.status === "failed"
          )
        )
      assert.strictEqual(path.entries.at(-2)!.version.id, start.entry.version.id)
      assert.strictEqual(path.entries.at(-2)!.version.content, "Already posted.")
      assert.strictEqual(path.entries.at(-2)!.version.status, "complete")
      resume = true
      const continued = yield* api.ResumeVersion({
        versionId: working.version.id,
        expectedRowVersion: working.rowVersion
      })
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.id === continued.version.id && e.version.status === "complete"
        )
      )
      const after = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: continued.slotId,
        range: { _tag: "Bottom" },
        limit: 100
      })
      assert.strictEqual(after.entries.at(-1)!.version.content, "Resumed answer.")
      assert.deepStrictEqual(
        after.entries.filter((e) => e.version.content === "Already posted.").map((e) => e.version.id),
        [start.entry.version.id]
      )
      const next = yield* send(api, chat, "New message after Resume.")
      yield* eventually(() =>
        events.some(
          (e) =>
            e._tag === "Version" &&
            e.version.content === "Resumed answer." &&
            e.version.id !== continued.version.id &&
            e.version.status === "complete"
        )
      )
      const run = yield* api.GetRunContext({ versionId: next.entry.version.id })
      assert.isUndefined(run.continuity?.parentVersionId)
      assert.match(run.continuity?.reason ?? "", /resumed or edited/)
      assert.include(JSON.stringify(mock.requests().at(-1)!.body), "New message after Resume.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

for (const change of [
  "edit",
  "insert",
  "delete",
  "swipe",
  "hide",
  "changeset",
  "missing",
  "fenced",
  "budget",
  "preset",
  "model-settings",
  "connection-settings"
] as const)
  it.live(`${change} rebuilds fresh with a visible reason`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = request.body!.messages as Array<{ role: string }>
            sse(
              res,
              !request.body!.tools || messages.at(-1)?.role === "tool"
                ? completionChunks(["Final message."], {})
                : call("read_card", { card: "Assistant" }, "read_before_fallback")
            )
          })
        ),
        (mock) => Effect.promise(() => mock.close())
      )
      const api = yield* client()
      const fixture = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { context: 4096 }
      })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const first = yield* send(api, chat, "First request.")
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.id === first.entry.version.id && e.version.status === "complete"
        )
      )
      const reader = yield* Reader
      const user = yield* api.Whoami()
      const current = yield* api.GetChat({ chatId: chat.id })
      const path = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: current.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 100
      })
      const human = path.entries.find((e) => e.version.content === "First request.")!
      if (change === "model-settings")
        yield* api.EditModel({
          modelId: fixture.model.id,
          expectedRowVersion: fixture.model.rowVersion,
          overrides: { settings: { samplers: { temperature: 0.23 } } }
        })
      if (change === "connection-settings")
        yield* api.UpdateConnection({
          connectionId: fixture.connection.id,
          expectedRowVersion: fixture.connection.rowVersion,
          settings: {
            name: fixture.connection.name,
            baseUrl: fixture.connection.baseUrl,
            compat: fixture.connection.compat,
            cacheTtlS: 900,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
      if (change === "preset") {
        const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: first.entry.version.id })
        const refId = JSON.parse(material.snapshot).inputs.preset.ref
        const field = textField(["prompts", "identifier=main", "content"])
        const editor = yield* api.OpenEditor({ refId })
        const draft = yield* api.SaveEditorDraft({
          refId,
          field,
          content: "Changed workshop instructions.",
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: editor.ref.headRevisionId
        })
        yield* api.CommitEditorDrafts({
          refId,
          expectedRowVersion: editor.ref.rowVersion,
          fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
      }
      if (change === "delete") yield* api.DeleteMessage({ slotId: human.slotId })
      if (change === "edit" || change === "swipe") {
        const { Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
        yield* (yield* Writer).AddSelectedVersion({
          userId: user.id,
          slotId: human.slotId,
          expectedRowVersion: human.rowVersion,
          version: {
            speakerEntityId: human.version.speakerEntityId,
            writer: "human",
            content: "Edited request.",
            status: "complete",
            macroMode: "verbatim",
            origin: "edited",
            sourceVersionId: human.version.id
          }
        })
      }
      if (change === "hide") yield* api.SetMessageHidden({ slotId: human.slotId, hidden: true })
      if (change === "insert")
        yield* api.InsertMessage({
          chatId: chat.id,
          forkId: current.currentForkId!,
          anchor: human.slotId,
          expectedRowVersion: human.rowVersion,
          body: { _tag: "Write", speaker: null, content: "Inserted request." }
        })
      if (change === "changeset") {
        const preview = yield* api.PreviewHistory({
          chatId: chat.id,
          forkId: current.currentForkId!,
          search: {
            pairs: [{ find: "First", replace: "Changed" }],
            matchCase: true,
            wholeWord: false,
            regex: false,
            preserveCase: false,
            messages: true,
            swipes: false,
            summaries: false
          }
        })
        yield* api.ApplyHistoryEdits({
          title: "Synthetic edit",
          applications: [
            {
              chatId: chat.id,
              forkId: current.currentForkId!,
              edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                kind,
                targetId,
                beforeId,
                before,
                after
              }))
            }
          ]
        })
      }
      if (["missing", "fenced", "budget"].includes(change)) {
        const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: first.entry.version.id })
        const statement =
          change === "missing"
            ? {
                sql: "UPDATE rollout_payloads SET transcript_json = NULL WHERE rollout_id = ?",
                params: [material.rolloutId]
              }
            : change === "fenced"
              ? {
                  sql: "UPDATE rollout_payloads SET context_snapshot_json = json_set(context_snapshot_json, '$.assemblerVersion', 1) WHERE rollout_id = ?",
                  params: [material.rolloutId]
                }
              : {
                  sql: "UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?",
                  params: [
                    JSON.stringify(
                      (JSON.parse(material.transcript!) as Array<{ role: string }>).map((m) =>
                        m.role === "toolResult"
                          ? { ...m, content: [{ type: "text", text: "synthetic tool result ".repeat(6000) }] }
                          : m
                      )
                    ),
                    material.rolloutId
                  ]
                }
        if (change === "fenced") {
          const [triggers] = yield* fixtureSql(
            config.dataDir,
            [{ sql: "SELECT sql FROM sqlite_schema WHERE name = 'rollout_snapshot_frozen'" }],
            { readOnly: true }
          )
          yield* fixtureSql(config.dataDir, [
            { sql: "DROP TRIGGER rollout_snapshot_frozen" },
            statement,
            { sql: String(triggers![0]!.sql) }
          ])
        } else yield* fixtureSql(config.dataDir, [statement])
        if (change === "budget") {
          const altered = yield* reader.RolloutMaterial({ userId: user.id, versionId: first.entry.version.id })
          const frozen = JSON.parse(altered.snapshot)
          const tokens = yield* reader.CountRolloutContext({
            model: JSON.stringify(frozen.inputs.model),
            request: JSON.stringify(frozen.request),
            transcript: altered.transcript!,
            tools: JSON.stringify(frozen.agent.tools)
          })
          assert.isAbove(
            tokens,
            frozen.contextBudget.maximum - frozen.contextBudget.responseReserve,
            `tokens=${tokens} budget=${JSON.stringify(frozen.contextBudget)} transcript=${altered.transcript!.slice(0, 100)}`
          )
        }
      }
      const before = mock.requests().length
      const next = yield* send(api, chat, "Second request.")
      yield* eventually(() =>
        events.some(
          (e) => e._tag === "Version" && e.version.id === next.entry.version.id && e.version.status === "complete"
        )
      )
      const run = yield* api.GetRunContext({ versionId: next.entry.version.id })
      assert.isUndefined(run.continuity?.parentVersionId)
      assert.match(
        run.continuity?.reason ?? "",
        change === "budget"
          ? /context budget/
          : change === "missing"
            ? /no saved transcript/
            : change === "fenced"
              ? /earlier assembler/
              : change === "preset"
                ? /preset changed/
                : change === "model-settings"
                  ? /model.*changed/
                  : change === "connection-settings"
                    ? /connection.*changed/
                    : /edited, inserted into, hidden or replaced/
      )
      const body = mock.requests()[before]!.body!
      assert.include(JSON.stringify(body.messages), "Second request.", "the new user message survives every fallback")
      if (change === "preset") assert.include(JSON.stringify(body.messages), "Changed workshop instructions.")
      if (change === "model-settings") assert.strictEqual(body.temperature, 0.23)
      assert.notInclude(JSON.stringify(body.messages), "tool_call_id", "a fresh request has no old tool transcript")
      if (change === "budget") {
        assert.include(JSON.stringify(body.messages), "[Steps: Read a card")
        assert.notInclude(JSON.stringify(body.messages), "synthetic tool result")
        const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: next.entry.version.id })
        const rebuilt = yield* reader.RebuildContext({ userId: user.id, snapshot: material.snapshot })
        assert.strictEqual(rebuilt._tag, "Rebuilt")
        if (rebuilt._tag === "Rebuilt")
          assert.strictEqual(
            JSON.stringify(JSON.parse(rebuilt.snapshot).request),
            JSON.stringify(JSON.parse(material.snapshot).request)
          )
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

it.live("each posted message starts a fresh parser and passes through the final rewrites", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const messages = request.body!.messages as Array<{ role: string }>
          sse(
            res,
            !request.body!.tools
              ? completionChunks(["Story."], {})
              : messages.at(-1)?.role === "tool"
                ? completionChunks(["<think>Last plan.</think>dull final."], {})
                : call("send_message", { message: "<think>First plan.</think>dull first." }, "parsed_send")
          )
        })
      ),
      (mock) => Effect.promise(() => mock.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      preset: { openai_max_context: 32768 }
    })
    const before = yield* api.GetGlobalRegex()
    yield* api.SetGlobalRegex({
      expectedRevision: before.revision,
      scripts: [
        {
          id: "multi-rewrite",
          name: "Synthetic rewrite",
          find_regex: "/dull/g",
          replace_string: "bright",
          trim_strings: [],
          placement: [2],
          disabled: false,
          markdown_only: false,
          prompt_only: false,
          run_on_edit: false,
          substitute_regex: "none",
          min_depth: null,
          max_depth: null
        }
      ]
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    yield* send(api, chat, "Post, then finish.")
    yield* eventually(() =>
      events.some(
        (e) => e._tag === "Version" && e.version.status === "complete" && e.version.content === "bright final."
      )
    )
    const current = yield* api.GetChat({ chatId: chat.id })
    const path = yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: current.activeLeafSlotId,
      range: { _tag: "Bottom" },
      limit: 100
    })
    const first = path.entries.at(-2)!.version
    const last = path.entries.at(-1)!.version
    assert.strictEqual(first.content, "bright first.")
    assert.strictEqual(first.replySections?.sections[0]?.text, "First plan.")
    assert.strictEqual(last.replySections?.sections[0]?.text, "Last plan.")
    assert.lengthOf(first.replySections!.sections, 1)
    assert.lengthOf(last.replySections!.sections, 1)
    assert.strictEqual((yield* api.RawVersionText({ versionId: first.id }))?.content, "dull first.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("a queued user message posts below the last send without leaving an empty working message", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let finish: (() => void) | undefined
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          if (!request.body!.tools) return sse(res, completionChunks(["Story."], {}))
          const messages = request.body!.messages as Array<{ role: string }>
          if (messages.at(-1)?.role === "tool") finish = () => sse(res, completionChunks([], {}))
          else if (finish) {
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.flushHeaders()
          } else sse(res, call("send_message", { message: "Only posted reply." }, "queued_send"))
        })
      ),
      (mock) => Effect.promise(() => mock.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      preset: { openai_max_context: 32768 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    const first = yield* send(api, chat, "Please work.")
    yield* eventually(() => finish !== undefined)
    const current = yield* api.GetChat({ chatId: chat.id })
    const queued = yield* api.SendMessage({
      chatId: chat.id,
      parentSlotId: current.activeLeafSlotId,
      branch: false,
      content: "Queued while working."
    })
    assert.strictEqual(queued._tag, "Queued")
    finish!()
    yield* eventually(() => events.some((e) => e._tag === "Reload"))
    const after = yield* api.GetChat({ chatId: chat.id })
    const path = yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: after.activeLeafSlotId,
      range: { _tag: "Bottom" },
      limit: 100
    })
    const postedAt = path.entries.findIndex((entry) => entry.slotId === first.entry.slotId)
    assert.deepStrictEqual(
      path.entries.slice(postedAt, postedAt + 2).map((entry) => entry.version.content),
      ["Only posted reply.", "Queued while working."]
    )
    assert.strictEqual(path.entries[postedAt + 1]!.parentSlotId, first.entry.slotId)
    assert.isFalse(path.entries.some((entry) => entry.version.status === "complete" && entry.version.content === ""))
    // The queued send starts its own reply through the ordinary queue path.
    assert.lengthOf(path.entries, 5)
    assert.strictEqual(path.entries.at(-1)!.version.status, "generating")
    assert.isEmpty(yield* api.ListQueued({ chatId: chat.id }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("Stop during the posting transaction's acknowledgement leaves the next message resumable", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const { Deferred } = yield* Effect.promise(() => import("effect"))
    const { Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
    const committed = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const writer = yield* Writer
    const post = writer.PostRolloutMessage
    Object.defineProperty(writer, "PostRolloutMessage", {
      value: (payload: Parameters<typeof post>[0]) =>
        post(payload).pipe(
          Effect.tap(() => Deferred.succeed(committed, undefined)),
          Effect.tap(() => Deferred.await(release))
        )
    })
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const messages = request.body!.messages as Array<{ role: string }>
          sse(
            res,
            !request.body!.tools
              ? completionChunks(["Story."], {})
              : messages.at(-1)?.role === "tool"
                ? completionChunks(["After Resume."], {})
                : call("send_message", { message: "Committed before Stop." }, "racing_send")
          )
        })
      ),
      (mock) => Effect.promise(() => mock.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      preset: { openai_max_context: 32768 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    const first = yield* send(api, chat, "Post and wait.")
    yield* Deferred.await(committed)
    const user = yield* api.Whoami()
    const stop = yield* api.StopGeneration({ versionId: first.entry.version.id }).pipe(Effect.forkScoped)
    yield* Effect.sleep(10)
    yield* Deferred.succeed(release, undefined)
    const { Fiber } = yield* Effect.promise(() => import("effect"))
    const stopped = yield* Fiber.join(stop)
    assert.strictEqual(stopped.status, "stopped")
    assert.notStrictEqual(stopped.id, first.entry.version.id)
    const reader = yield* Reader
    assert.strictEqual(
      (yield* reader.GetVersion({ userId: user.id, versionId: first.entry.version.id })).status,
      "complete"
    )
    const working = yield* reader.GetSlot({ userId: user.id, slotId: stopped.slotId })
    const resumed = yield* api.ResumeVersion({ versionId: stopped.id, expectedRowVersion: working.entry.rowVersion })
    yield* eventually(() =>
      events.some((e) => e._tag === "Version" && e.version.id === resumed.version.id && e.version.status === "complete")
    )
    const path = yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: resumed.slotId,
      range: { _tag: "Bottom" },
      limit: 100
    })
    assert.deepStrictEqual(
      path.entries.slice(-2).map((e) => e.version.content),
      ["Committed before Stop.", "After Resume."]
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
