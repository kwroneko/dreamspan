import { OPEN_LIBRARY } from "./support/libraryGrants.ts"
import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { Chat, MessageLibrary } from "@dreamspan/shared/chat.ts"
import { Effect, Stream } from "effect"
import { textField } from "@dreamspan/shared/editing.ts"
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
const send = (api: Api, chat: Chat, content: string, library?: MessageLibrary) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const draft = library?.length ? yield* api.OpenComposer({ chatId: chat.id, forkId: null }) : null
    if (draft !== null && library !== undefined)
      yield* api.SetComposerLibrary({
        chatId: chat.id,
        draftId: draft.id,
        add: library.map((item) => item.refId),
        remove: []
      })
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: current.activeLeafSlotId,
        branch: false,
        content,
        ...(draft === null ? {} : { composer: { draftId: draft.id, session: draft.session } }),
        ...(library === undefined ? {} : { library })
      })
    )
    return yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
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
  it.live(`${change} reconstructs history from the selected path`, () => {
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
        model: { context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
      yield* api.ChangeLcmSettings({ chatId: chat.id, change: { enabled: false } })
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
      const body = mock.requests()[before]!.body!
      assert.include(JSON.stringify(body.messages), "Second request.", "the new user message survives every fallback")
      if (change === "preset") assert.include(JSON.stringify(body.messages), "Changed workshop instructions.")
      if (change === "model-settings") assert.strictEqual(body.temperature, 0.23)
      if (change === "missing") assert.notInclude(JSON.stringify(body.messages), "tool_call_id")
      else assert.include(JSON.stringify(body.messages), '"tool_call_id":"read_before_fallback"')
      if (change === "budget") {
        assert.include(JSON.stringify(body.messages), "[Result left out to save room.")
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

for (const contract of ["send_message", "both"] as const) {
  it.live(`uses ${contract} as an explicit boundary in the same workshop message`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = JSON.stringify(request.body?.messages)
            if (!messages.includes("Explicit boundary task.")) return sse(res, completionChunks(["Ready."], {}))
            return sse(res, call("send_message", { message: "The one reply." }, "workshop-boundary"))
          })
        ),
        (mock) => Effect.promise(() => mock.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: mock.url },
        model: { context: 32768 }
      })
      const chat = yield* api.CreateWorkshop({})
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "OutputContract", contract } })
      const events = yield* watch(api, chat)
      const start = yield* send(api, chat, "Explicit boundary task.")
      yield* eventually(() =>
        events.some(
          (event) =>
            event._tag === "Version" &&
            event.version.id === start.entry.version.id &&
            event.version.status === "complete"
        )
      )
      const current = yield* api.GetChat({ chatId: chat.id })
      const path = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: current.activeLeafSlotId,
        limit: 20,
        range: { _tag: "Bottom" }
      })
      assert.deepStrictEqual(
        path.entries.slice(1).map((entry) => entry.version.content),
        ["Explicit boundary task.", "The one reply."]
      )
      assert.strictEqual(current.activeLeafSlotId, start.entry.slotId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
}
