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
    // The seeded Assistant card names the built-in skills: they are its index.
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
    // Loaded: it ran.
    assert.notInclude(JSON.stringify(lastResult(bodies[3]!)), "isn't loaded yet")
    // The transcript keeps what was loaded, so a resume or step edit loads it at the same point.
    const transcript = yield* api.GetRunTranscript({ versionId: version.id })
    assert.isTrue(transcript.entries.some((e) => e.role === "toolResult" && e.tool === "tool_search"))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
