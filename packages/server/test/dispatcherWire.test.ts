// Re-serialize the same canonical history for each supported wire; no provider is contacted.
import { assert, it } from "@effect/vitest"
import {
  normalizeContext,
  Type,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Tool,
  type ToolCall
} from "@earendil-works/pi-ai"
import { dispatcherDefinition, dispatcherMessages } from "../src/agent/dispatcher.ts"
import { forTarget } from "../src/agent/wire.ts"
import { streamSimple as google } from "../src/providers/google.ts"
import { captureToolArguments } from "../src/providers/toolArguments.ts"

const read: Tool = {
  name: "read_card",
  description: "Read the synthetic saved card.",
  parameters: Type.Object({ card: Type.String() })
}
const search: Tool = {
  name: "tool_search",
  description: "Load tools.",
  parameters: Type.Object({ query: Type.String() })
}
const assistant = (name: string, args: ToolCall["arguments"], id: string): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Old thinking", thinkingSignature: "old-signature" },
    { type: "toolCall", id, name, arguments: args, thoughtSignature: "old-signature" }
  ],
  api: "openai-completions",
  provider: "deepseek",
  model: "old-model",
  timestamp: 0,
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
})
const result = (name: string, id: string, loaded?: string[]): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: "Synthetic result" }],
  isError: false,
  timestamp: 0,
  details: loaded ? { loaded } : null
})
const history: Message[] = [
  { role: "user", content: "Read the synthetic card.", timestamp: 0 },
  assistant("tool_search", { query: "select:read_card" }, "load"),
  result("tool_search", "load", ["read_card"]),
  assistant("read_card", { card: "Synthetic" }, "read"),
  result("read_card", "read")
]

for (const api of ["anthropic-messages", "openai-completions", "openai-responses", "google-generative-ai"] as const)
  it(`replays canonical deferred calls directly or through the dispatcher on ${api}`, async () => {
    const provider = api === "anthropic-messages" ? "anthropic" : api === "google-generative-ai" ? "google" : "openai"
    const model = {
      id: "synthetic-model",
      name: "Synthetic",
      api,
      provider,
      baseUrl: "http://127.0.0.1:1",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 1024
    } as Model<Api>
    const target = { api, key: model.id, provider }
    const canonical = forTarget(history, target)
    const serialize = async (dispatch: boolean) => {
      const adapter =
        api === "google-generative-ai" ? { streamSimple: google } : await import(`@earendil-works/pi-ai/api/${api}`)
      let body: Record<string, unknown> | undefined
      const stream = adapter.streamSimple(
        model as never,
        normalizeContext({
          messages: dispatch ? [...dispatcherMessages(canonical, [read])] : canonical,
          tools: dispatch ? [search, dispatcherDefinition] : [search, read]
        }),
        {
          apiKey: "synthetic-key",
          env: {},
          onPayload: (payload: Record<string, unknown>) => {
            body = structuredClone(payload)
            throw new Error("Captured offline")
          },
          fetch: () => {
            throw new Error("No provider calls in this test")
          }
        }
      )
      await stream.result()
      assert.isDefined(body)
      return body!
    }
    for (const dispatch of [false, true]) {
      const body = await serialize(dispatch)
      const name = dispatch ? "call_tool" : "read_card"
      const text = JSON.stringify(body)
      assert.notInclude(text, "Old thinking")
      assert.notInclude(text, "old-signature")
      if (api === "google-generative-ai") {
        const contents = body.contents as Array<{
          parts: Array<{ functionCall?: { name: string; args: unknown }; functionResponse?: { name: string } }>
        }>
        const parts = contents.flatMap((m) => m.parts)
        assert.strictEqual(parts.findLast((p) => p.functionCall)?.functionCall?.name, name)
        assert.strictEqual(parts.findLast((p) => p.functionResponse)?.functionResponse?.name, name)
      } else if (api === "anthropic-messages") {
        const messages = body.messages as Array<{ content: Array<{ type: string; name?: string }> }>
        assert.strictEqual(messages.flatMap((m) => m.content).findLast((p) => p.type === "tool_use")?.name, name)
      } else if (api === "openai-responses") {
        const input = body.input as Array<{ type: string; name?: string }>
        assert.strictEqual(input.findLast((p) => p.type === "function_call")?.name, name)
      } else {
        const messages = body.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>
        assert.strictEqual(messages.flatMap((m) => m.tool_calls ?? []).at(-1)?.function.name, name)
      }
    }
  })

it("preserves strict tool JSON across Chat, Responses and Anthropic raw events", () => {
  const malformed = '{"name":"read_card","arguments":{"card":"Synthetic"}'
  const chat = captureToolArguments()
  chat.observe({ choices: [{ delta: { tool_calls: [{ index: 0, id: "chat", function: { arguments: malformed } }] } }] })
  const response = captureToolArguments()
  response.observe({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "call", id: "item", arguments: "" }
  })
  response.observe({ type: "response.function_call_arguments.delta", output_index: 0, delta: malformed })
  const anthropic = captureToolArguments()
  anthropic.observe({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "claude", input: {} }
  })
  anthropic.observe({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: malformed }
  })
  for (const raw of [chat.argumentsById.chat, response.argumentsById["call|item"], anthropic.argumentsById.claude]) {
    assert.strictEqual(raw, malformed)
    assert.throws(() => JSON.parse(raw!))
  }
})
