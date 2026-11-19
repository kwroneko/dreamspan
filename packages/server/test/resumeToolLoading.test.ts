// Resume on another model (spec/AGENTIC.md §12.3) of a run with deferred tools (spec/TOOL-LOADING.md):
// the size check counts the tools as the resumed request sends them, so a tool not loaded yet takes
// no room on a model whose wire API defers it.
import { assert, it } from "@effect/vitest"
import type { Chat } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, startMockProvider } from "./support/mockProvider.ts"

type Body = {
  tools?: Array<{ name: string; defer_loading?: boolean }>
  messages: Array<{ role: string; content: unknown }>
}
type Frozen = {
  readonly inputs: { readonly model: unknown }
  readonly request: unknown
  readonly contextBudget: { readonly maximum: number; readonly responseReserve: number }
  readonly agent: { readonly tools: ReadonlyArray<{ readonly name: string; readonly deferred?: true }> }
}

const text = (value: string) => [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 }
    }
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" }
]

// review-resume1: Resume offers the tools a settings change adds or removes (spec/AGENTIC.md §12.4),
// but the skills and loads are the run's: a card skill that arrives later isn't a settings change.
const toolUse = (id: string, name: string, input: unknown) => [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 }
    }
  },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
]

it.live("resumes with the run's frozen skills and loads after a card with its own skill joins", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let workshopRequests = 0
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.tools?.length) return anthropicSse(res, text("Hello."))
          const n = workshopRequests++
          if (n === 0) return anthropicSse(res, toolUse("toolu_load", "tool_search", { query: "select:read_card" }))
          if (n === 1) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Try again." } }))
            return
          }
          anthropicSse(res, text("Done."))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
      modelKey: "claude-sonnet-4-5",
      model: {}
    })
    const chat: Chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const from = mock.requests().length
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: "Read a card." })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
    const failed = finished(events, generated.entry.version.id)!
    assert.strictEqual(failed.status, "failed")
    const runTools = JSON.stringify((mock.requests()[from]!.body as unknown as Body).tools)

    // A card carrying its own skill joins after the run.
    const me = yield* api.Whoami()
    const helper = yield* (yield* Writer).CreateEntity({
      userId: me.id,
      kind: "card",
      label: "Synthetic helper",
      subtitle: "",
      schemaVersion: 1,
      origin: "import",
      sourcePath: null,
      doc: {
        ...newCardDoc("Synthetic helper"),
        extensions: {
          dreamspan: {
            skills: [{ name: "proofread", description: "Checks spelling.", instructions: "List typos.", tools: [] }]
          }
        }
      }
    })
    yield* api.ChangeCast({
      chatId: chat.id,
      slotId: failed.slotId,
      change: { _tag: "Join", entityId: helper.ref.entityId }
    })

    const reader = yield* Reader
    const slot = yield* reader.GetSlot({ userId: me.id, slotId: failed.slotId })
    const resumeFrom = mock.requests().length
    const resumed = yield* api.ResumeVersion({ versionId: failed.id, expectedRowVersion: slot.entry.rowVersion })
    yield* eventually(() => finished(events, resumed.version.id) !== undefined)
    const done = finished(events, resumed.version.id)!
    assert.strictEqual(done.status, "complete", JSON.stringify(done.error))
    const resent = mock.requests()[resumeFrom]!.body as unknown as Body
    assert.strictEqual(JSON.stringify(resent.tools), runTools, "the run's tools and skill index, byte for byte")
    assert.notInclude(JSON.stringify(resent.tools), "proofread")
    assert.include(JSON.stringify(resent.messages), '"tool_name":"read_card"', "the earlier load still holds")
    const carried = JSON.parse(
      (yield* reader.RolloutMaterial({ userId: me.id, versionId: resumed.version.id })).snapshot
    ) as { readonly agent: { readonly cardSkills?: ReadonlyArray<{ readonly id: string }> } }
    assert.notInclude(
      (carried.agent.cardSkills ?? []).map((s) => s.id),
      "proofread",
      "the run's skills stay frozen"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("resumes on a smaller model when the tools it sends fit, deferred ones not loaded taking no room", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    let workshopRequests = 0
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.tools?.length) return anthropicSse(res, text("Hello."))
          // The workshop's first request fails; the resumed one answers.
          if (workshopRequests++ === 0) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Try again." } }))
            return
          }
          anthropicSse(res, text("Done."))
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { connection } = yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
      modelKey: "claude-sonnet-4-5",
      model: {}
    })
    const chat: Chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: "Hello there." })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
    const failed = finished(events, generated.entry.version.id)!
    assert.strictEqual(failed.status, "failed")

    // The run froze deferred tools: sized as sent, they take no room until loaded.
    const reader = yield* Reader
    const me = yield* api.Whoami()
    const material = yield* reader.RolloutMaterial({ userId: me.id, versionId: failed.id })
    const frozen = JSON.parse(material.snapshot) as Frozen
    assert.isTrue(
      frozen.agent.tools.some((t) => t.deferred === true),
      "the run defers tools"
    )
    const count = (tools: Frozen["agent"]["tools"]) =>
      reader.CountRolloutContext({
        model: JSON.stringify(frozen.inputs.model),
        request: JSON.stringify(frozen.request),
        transcript: "[]",
        tools: JSON.stringify(tools)
      })
    const asSent = yield* count(frozen.agent.tools.filter((t) => t.deferred !== true))
    const everything = yield* count(frozen.agent.tools)
    assert.isAbove(everything - asSent, 200, "the deferred definitions are a real share of the request")
    // A window between the two: the request it sends fits, every deferred definition wouldn't.
    const window = frozen.contextBudget.responseReserve + Math.floor((asSent + everything) / 2)

    const smaller = yield* api.AddUserModel({
      connectionId: connection.id,
      key: "claude-haiku-4-5",
      overrides: { context: window }
    })
    yield* api.ChangeCast({
      chatId: chat.id,
      slotId: failed.slotId,
      change: { _tag: "Model", connection: connection.id, model: smaller.id }
    })
    const slot = yield* reader.GetSlot({ userId: me.id, slotId: failed.slotId })
    const resumed = yield* api.ResumeVersion({ versionId: failed.id, expectedRowVersion: slot.entry.rowVersion })
    yield* eventually(() => finished(events, resumed.version.id) !== undefined)
    const done = finished(events, resumed.version.id)!
    assert.strictEqual(done.status, "complete", JSON.stringify(done.error))
    assert.strictEqual(done.content, "Done.")
    const carried = JSON.parse(
      (yield* reader.RolloutMaterial({ userId: me.id, versionId: resumed.version.id })).snapshot
    ) as Frozen
    assert.strictEqual(carried.contextBudget.maximum, window, "it ran on the smaller model's window")
    const last = mock.requests().at(-1)!.body as unknown as Body
    assert.isTrue(
      last.tools!.some((t) => t.defer_loading === true),
      "the resumed request still defers the tools not loaded"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
