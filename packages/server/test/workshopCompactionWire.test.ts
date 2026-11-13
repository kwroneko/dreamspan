// Exercise pi's actual provider serializers; onPayload stops every request before transport.
import { assert, it } from "@effect/vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { normalizeContext, type Api, type Model, type Tool } from "@earendil-works/pi-ai"
import { activeRunSummaries, compactionBoundaries } from "../src/agent/compaction.ts"
import { liveSuffix } from "../src/agent/messages.ts"
import { forTarget, rolloutRequest } from "../src/agent/wire.ts"

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const tools: Tool[] = ["load_skill", "read_card", "edit_card"].map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} }
})) as Tool[]

for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const)
  for (const deepseek of api === "openai-completions" ? [false, true] : [false])
    it(`keeps complete pairs after compaction on ${deepseek ? "DeepSeek" : api}`, async () => {
      const provider = deepseek
        ? "deepseek"
        : api === "anthropic-messages"
          ? "anthropic"
          : api === "google-generative-ai"
            ? "google"
            : "openai"
      const model: Model<Api> = {
        id: api === "google-generative-ai" ? "gemini-2.5-pro" : "synthetic",
        name: "Synthetic",
        api,
        provider,
        baseUrl: "http://127.0.0.1:1",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 1024
      }
      const turn = (id: string, name: string): AgentMessage => ({
        role: "assistant",
        api,
        provider,
        model: model.id,
        stopReason: "toolUse",
        usage,
        timestamp: 0,
        content: [
          ...(deepseek
            ? [
                {
                  type: "thinking" as const,
                  thinking: "Check the saved result.",
                  thinkingSignature: "reasoning_content"
                }
              ]
            : []),
          { type: "toolCall", id, name, arguments: {} }
        ]
      })
      const result = (id: string, name: string, denied = false): AgentMessage => ({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        isError: denied,
        timestamp: 0,
        content: [
          { type: "text", text: denied ? "User declined. No change was made." : "Read keeper card id card-7." }
        ],
        details: name === "load_skill" ? { loaded: ["edit_card"] } : null
      })
      const messages: AgentMessage[] = [
        { role: "rpRequest", timestamp: 0 },
        turn("load", "load_skill"),
        result("load", "load_skill"),
        turn("old", "read_card"),
        result("old", "read_card"),
        turn("declined", "edit_card"),
        result("declined", "edit_card", true),
        {
          role: "rpCompaction",
          id: "notes",
          from: 1,
          through: 5,
          content: "Read card-7; loaded editing. No permission granted.",
          timestamp: 0
        }
      ]
      const pending = [...messages, turn("pending", "edit_card")]
      assert.notInclude(compactionBoundaries(pending, 1), pending.length)
      assert.include(JSON.stringify(liveSuffix(pending)), '"id":"pending"')
      assert.lengthOf(activeRunSummaries(messages), 1)
      const target = { api, key: model.id, kind: deepseek ? "deepseek" : provider, provider }
      const suffix = forTarget(liveSuffix(messages), target)
      const wire = rolloutRequest(
        { context: { messages: [] }, payload: { messages: [] }, breakpoints: [] } as never,
        api,
        suffix,
        tools,
        { replayReasoning: true, reasoningTarget: target as never }
      )
      let payload: unknown
      const adapter = await import(`@earendil-works/pi-ai/api/${api}`)
      const stream = adapter.streamSimple(model, normalizeContext(wire.context), {
        apiKey: "synthetic-key",
        onPayload: (body: unknown) => {
          payload = api === "openai-completions" ? { ...(body as object), messages: wire.payload.messages } : body
          throw new Error("Captured before transport")
        },
        ...(api === "google-generative-ai"
          ? {}
          : {
              fetch: () => {
                throw new Error("Must not send")
              }
            })
      })
      await stream.result()
      assert.isDefined(payload)
      const sent = JSON.stringify(payload)
      assert.include(sent, "card-7")
      assert.include(sent, "User declined. No change was made.")
      assert.notInclude(sent, '"old"')
      const calls: string[] = [],
        results: string[] = []
      const walk = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        const v = value as Record<string, unknown>
        if (v.type === "tool_use") calls.push(String(v.id))
        if (v.type === "tool_result") results.push(String(v.tool_use_id))
        if (v.type === "function_call") calls.push(String(v.call_id))
        if (v.type === "function_call_output") results.push(String(v.call_id))
        if (v.type === "function" && typeof v.id === "string") calls.push(v.id)
        if (v.role === "tool") results.push(String(v.tool_call_id))
        if (v.functionCall) calls.push(String((v.functionCall as { name: string }).name))
        if (v.functionResponse) results.push(String((v.functionResponse as { name: string }).name))
        for (const part of Object.values(v)) walk(part)
      }
      walk(payload)
      assert.lengthOf(calls, 2)
      assert.deepStrictEqual(results.toSorted(), calls.toSorted())
      if (deepseek) {
        const turns = (payload as { messages: Record<string, unknown>[] }).messages.filter((m) => m.tool_calls)
        assert.strictEqual(turns[0]!.reasoning_content, "")
        assert.strictEqual(turns[1]!.reasoning_content, "Check the saved result.")
      }
    })
