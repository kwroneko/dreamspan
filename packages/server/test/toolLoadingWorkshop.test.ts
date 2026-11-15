import { TOOL_DATA_NOTICE } from "../src/agent/toolData.ts"
// A workshop run on Anthropic's API with deferred tools (spec/TOOL-LOADING.md): an unloaded tool is
// refused, tool_search loads it, and every request declares the same tools with the same bytes.
import { assert, it } from "@effect/vitest"
import type { Chat } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, startMockProvider } from "./support/mockProvider.ts"

type Block = {
  type: string
  text?: string
  tool_use_id?: string
  content?: Array<{ type: string; text?: string; tool_name?: string }>
}
type Body = {
  tools?: Array<{ name: string; description?: string; defer_loading?: boolean; cache_control?: unknown }>
  messages: Array<{ role: string; content: string | Array<Block> }>
}

const start = {
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
}
const toolUse = (id: string, name: string, input: unknown) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
]
const text = (value: string) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" }
]
const lastResult = (body: Body) => {
  const last = body.messages.at(-1)?.content
  return Array.isArray(last) ? last.find((b) => b.type === "tool_result") : undefined
}

it.live("loads a deferred tool mid-run without changing the declared tools", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const body = request.body as unknown as Body
          if (!body?.tools?.length) return anthropicSse(res, text("Hello."))
          const step = lastResult(body)?.tool_use_id
          anthropicSse(
            res,
            step === undefined
              ? toolUse("toolu_1", "read_card", { card: "Assistant" })
              : step === "toolu_1"
                ? toolUse("toolu_2", "tool_search", { query: "select:read_card" })
                : step === "toolu_2"
                  ? toolUse("toolu_3", "read_card", { card: "Assistant" })
                  : text("Done.")
          )
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
    const before = mock.requests().length
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "Read the Assistant card."
      })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
    const version = finished(events, generated.entry.version.id)!
    assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
    assert.strictEqual(version.content, "Done.")

    const bodies = mock
      .requests()
      .slice(before)
      .filter((r) => r.path.startsWith("/v1/messages"))
      .map((r) => r.body as unknown as Body)
    assert.lengthOf(bodies, 4)
    const tools = bodies[0]!.tools!
    for (const body of bodies) assert.strictEqual(JSON.stringify(body.tools), JSON.stringify(tools))
    assert.deepStrictEqual(
      tools.filter((t) => !t.defer_loading).map((t) => t.name),
      ["list_library", "tool_search", "load_skill", "send_message"]
    )
    assert.isTrue(tools.find((t) => t.name === "read_card")?.defer_loading)
    // The built-in skills are the index in every workshop, whatever its card.
    assert.include(tools.find((t) => t.name === "load_skill")?.description ?? "", "- cards:")
    assert.deepStrictEqual(
      tools.filter((t) => t.cache_control !== undefined).map((t) => t.name),
      ["send_message"]
    )
    // Called before it was loaded: refused, and nothing was read.
    const refused = lastResult(bodies[1]!)!
    assert.include(JSON.stringify(refused), "isn't loaded yet")
    // The load point carries the reference the provider expands.
    const load = lastResult(bodies[2]!)!
    assert.deepStrictEqual(
      load.content!.filter((c) => c.type === "tool_reference").map((c) => c.tool_name),
      ["read_card"]
    )
    // Loaded: it ran with the same data-only boundary as other transports.
    assert.include(JSON.stringify(lastResult(bodies[3]!)), TOOL_DATA_NOTICE)
    assert.notInclude(JSON.stringify(lastResult(bodies[3]!)), "isn't loaded yet")
    // The transcript keeps what was loaded, so a resume or step edit loads it at the same point.
    const transcript = yield* api.GetRunTranscript({ versionId: version.id })
    assert.isTrue(transcript.entries.some((e) => e.role === "toolResult" && e.tool === "tool_search"))
    // A follow-up reuses exactly this run's loaded catalog and request prefix.
    const current = yield* api.GetChat({ chatId: chat.id })
    const nextUser = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: current.activeLeafSlotId,
        branch: false,
        content: "Continue the same task."
      })
    )
    const from = mock.requests().length
    const next = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: nextUser.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, next.entry.version.id) !== undefined)
    const nextBody = mock.requests()[from]!.body as unknown as Body
    assert.strictEqual(JSON.stringify(nextBody.tools), JSON.stringify(tools))
    assert.strictEqual(
      JSON.stringify(nextBody.messages.slice(0, bodies[3]!.messages.length)),
      JSON.stringify(bodies[3]!.messages)
    )
    assert.strictEqual(
      (yield* api.GetRunContext({ versionId: next.entry.version.id })).continuity?.parentVersionId,
      version.id
    )
    // An edited load result preserves its references and frozen definitions on resume.
    const { Reader } = yield* Effect.promise(() => import("../src/db/Database.ts"))
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
    const editFrom = mock.requests().length
    const edited = yield* api.ResumeFromStep({
      versionId: version.id,
      step: 1,
      edit: { kind: "result", text: "Edited loading result." },
      expectedRowVersion: slot.entry.rowVersion
    })
    yield* eventually(() => finished(events, edited.version.id) !== undefined)
    const resumedBody = mock.requests()[editFrom]!.body as unknown as Body
    assert.strictEqual(JSON.stringify(resumedBody.tools), JSON.stringify(tools))
    assert.include(JSON.stringify(resumedBody.messages), '"tool_name":"read_card"')
    assert.include(JSON.stringify(resumedBody.messages), "Edited loading result.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

// A model can emit several tool calls together. A later call sees only earlier results,
// and loading still leaves the capability gate in charge.
for (const mode of ["off", "ask"] as const) {
  it.live(`card skill approval and ${mode} library capability survive loading and batched calls`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const secret = "SYNTHETIC SKILL INSTRUCTIONS"
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const body = request.body as unknown as Body
            if (!body?.tools?.length) return anthropicSse(res, text("Hello."))
            const results = body.messages.flatMap((m) =>
              Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []
            )
            if (results.length === 0) {
              const batch = toolUse("skill_load", "load_skill", { name: "proofread" })
              batch.splice(
                batch.length - 2,
                0,
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "tool_use", id: "read_after_load", name: "read_card", input: {} }
                } as never,
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "input_json_delta", partial_json: '{"card":"Synthetic helper"}' }
                } as never,
                { type: "content_block_stop", index: 1 } as never
              )
              return anthropicSse(res, batch)
            }
            if (results.length === 2)
              return anthropicSse(
                res,
                toolUse("edit_after_load", "edit_card", {
                  card: "Synthetic helper",
                  changes: [{ field: "description", text: "Unapproved change" }]
                })
              )
            anthropicSse(res, text("Done."))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "synthetic-key" },
        modelKey: "claude-sonnet-4-5",
        model: {}
      })
      const chat = yield* api.CreateWorkshop({})
      const user = yield* api.Whoami()
      const { Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
      const { newCardDoc } = yield* Effect.promise(() => import("@rp/shared/editing.ts"))
      const helper = yield* (yield* Writer).CreateEntity({
        userId: user.id,
        kind: "card",
        label: "Synthetic helper",
        subtitle: "",
        schemaVersion: 1,
        origin: "import",
        sourcePath: null,
        doc: {
          ...newCardDoc("Synthetic helper"),
          extensions: {
            rp_harness: {
              skills: [
                {
                  name: "proofread",
                  description: "UNTRUSTED INDEX TEXT",
                  instructions: secret,
                  tools: ["read_card", "edit_card", "not_offered"]
                }
              ]
            }
          }
        }
      })
      const assistant = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: chat.activeLeafSlotId,
        change: { _tag: "Join", entityId: helper.ref.entityId }
      })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: chat.activeLeafSlotId,
        change: { _tag: "Leave", entityId: assistant.entityId }
      })
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: "Proofread." })
      )
      const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const waiting = (id: string) =>
        events
          .flatMap((e) => (e._tag === "Steps" && e.versionId === generated.entry.version.id ? e.steps : []))
          .findLast((s) => s.kind === "tool" && s.id === id && s.status === "waiting")
      yield* eventually(() => waiting("skill_load") !== undefined)
      const approval = waiting("skill_load")!
      assert.strictEqual(approval.kind, "tool")
      if (approval.kind !== "tool" || !approval.approval) return yield* Effect.die("Missing skill approval")
      assert.strictEqual(approval.approval.capability, "skills.card")
      assert.include(JSON.stringify(approval.approval.rows), secret)
      const before = mock.requests().at(-1)!.body!
      assert.notInclude(JSON.stringify(before), secret)
      assert.notInclude(JSON.stringify(before), "UNTRUSTED INDEX TEXT")
      yield* api.AnswerToolApproval({
        rolloutId: approval.approval.rolloutId,
        toolCallId: approval.approval.toolCallId,
        digest: approval.approval.digest,
        answer: "allow"
      })
      if (mode === "ask") {
        yield* eventually(() => waiting("edit_after_load") !== undefined)
        const edit = waiting("edit_after_load")!
        if (edit.kind !== "tool" || !edit.approval) return yield* Effect.die("Missing write approval")
        assert.strictEqual(edit.approval.capability, "library.write")
        yield* api.AnswerToolApproval({
          rolloutId: edit.approval.rolloutId,
          toolCallId: edit.approval.toolCallId,
          digest: edit.approval.digest,
          answer: "deny"
        })
      }
      yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
      const bodies = mock
        .requests()
        .filter((r) => (r.body as unknown as Body)?.tools?.some((t) => t.name === "load_skill"))
        .map((r) => r.body as unknown as Body)
      const after = bodies[1]!
      const loaded = after.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .flatMap((b) => b.content ?? [])
        .filter((b) => b.type === "tool_reference")
        .map((b) => b.tool_name)
      assert.include(loaded, "read_card")
      assert.notInclude(loaded, "not_offered")
      if (mode === "off") assert.notInclude(loaded, "edit_card")
      const results = after.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === "tool_result")
      assert.notInclude(
        JSON.stringify(results.at(-1)),
        "isn't loaded yet",
        "later calls in a batch see the approved load"
      )
      assert.notInclude(JSON.stringify((yield* api.OpenEditor({ refId: helper.ref.id })).doc), "Unapproved change")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
}
