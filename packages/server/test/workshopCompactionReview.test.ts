import { assert, it } from "@effect/vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Effect, Stream } from "effect"
import { activeRunSummaries, summarySafeText, transcriptData } from "../src/agent/compaction.ts"
import { liveSuffix } from "../src/agent/messages.ts"
import { workshopCompactor } from "../src/agent/workshopCompactor.ts"
import type { Reader } from "../src/db/Database.ts"
import type { Providers } from "../src/providers/Providers.ts"

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const messages: Array<AgentMessage> = [{ role: "rpRequest", timestamp: 0 }]
for (let n = 0; n < 8; n++)
  messages.push(
    {
      role: "assistant",
      api: "openai-completions",
      provider: "openai",
      model: "synthetic",
      content: [{ type: "toolCall", id: `read-${n}`, name: "read_card", arguments: { card: "keeper" } }],
      stopReason: "toolUse",
      usage,
      timestamp: 0
    },
    {
      role: "toolResult",
      toolCallId: `read-${n}`,
      toolName: "read_card",
      isError: false,
      content: [{ type: "text", text: "Synthetic lookup. ".repeat(200) }],
      timestamp: 0
    }
  )

it("redacts nested serialized credentials without corrupting JSON or ordinary card prose", () => {
  const prose = "The keeper explains API keys, password managers, and authorization to visitors."
  const source = JSON.stringify({
    description: prose,
    api_key: "synthetic-top-secret",
    raw: JSON.stringify({
      credentials: { refresh_token: "synthetic-refresh-secret", apiKey: "synthetic-nested-secret" }
    })
  })
  const safe = summarySafeText(source)
  for (const secret of ["synthetic-top-secret", "synthetic-refresh-secret", "synthetic-nested-secret"])
    assert.notInclude(safe, secret)
  assert.strictEqual(JSON.parse(safe).description, prose)
  assert.strictEqual(JSON.parse(JSON.parse(safe).raw).credentials.apiKey, "[redacted]")
  assert.strictEqual(summarySafeText(safe), safe, "redaction is idempotent")
  const wrapped = summarySafeText(`<step><result>\n${source}\n</result></step>`)
  assert.notInclude(wrapped, "synthetic-nested-secret")
  assert.include(wrapped, prose)
  const result = { ...messages[2]!, content: [{ type: "text", text: source }] } as AgentMessage
  const data = transcriptData([messages[1]!, result])
  assert.notInclude(data, "synthetic-nested-secret")
  assert.include(data, prose)
  assert.isArray(JSON.parse(data))
})

const setup = (summaryWindow: number) => {
  const sent: Array<unknown> = []
  // A deterministic local counter, so the threshold and tiny-window cases have exact bounds.
  const count = (text: string) => Math.ceil(text.length / 4)
  const reader = {
    CountRolloutContext: (input: { text?: string; transcript: string }) =>
      Effect.succeed(
        input.text === undefined
          ? 100 + count(JSON.stringify(liveSuffix(JSON.parse(input.transcript))))
          : count(input.text)
      ),
    WorkshopSummaryContext: () =>
      Effect.succeed(
        JSON.stringify({
          enabled: true,
          target: 128,
          changes: "[]",
          tail: null,
          model: { api: "openai-completions", kind: "openai-chat", key: "synthetic-summary", context: summaryWindow }
        })
      )
  } as unknown as Reader["Service"]
  const providers = {
    stream: (request: unknown) => {
      sent.push(request)
      if (summaryWindow < 256) return Stream.fail(new Error("Synthetic provider rejects oversized request"))
      return Stream.succeed({ type: "text", delta: "Read keeper; no edits. read_run recovers originals." })
    }
  } as unknown as Providers["Service"]
  const compact = (transcript = messages) =>
    workshopCompactor.compact({
      reader,
      providers,
      request: { userId: "synthetic", chatId: "workshop" } as never,
      rolloutId: "synthetic-run",
      model: { context: 8192 } as never,
      prefix: { messages: [], samplers: {} } as never,
      messages: transcript,
      tools: [],
      leafSlotId: null,
      reserve: 2048
    })
  return { compact, sent }
}

it.effect("rejects an impossible summary window locally instead of issuing one request per character", () =>
  Effect.gen(function* () {
    const { compact, sent } = setup(128)
    const outcome = yield* compact().pipe(Effect.result)
    assert.lengthOf(sent, 0, "no request fits even the summary instruction")
    assert.isTrue(outcome._tag === "Failure")
  })
)

it.effect("does not summarize again on each following request, and preserves its original steps", () =>
  Effect.gen(function* () {
    const { compact, sent } = setup(8192)
    const first = yield* compact()
    assert.isAbove(activeRunSummaries(first).length, 0)
    const calls = sent.length
    const second = yield* compact([...first])
    assert.lengthOf(sent, calls)
    assert.deepStrictEqual(second, first)
    assert.deepStrictEqual(second.slice(0, messages.length), messages)
  })
)

it("preserves ordinary card prose using Bearer and Basic while scrubbing authorization fields", () => {
  const prose = "Bearer of tides. Basic safety matters. The keeper teaches API keys and password managers."
  assert.strictEqual(summarySafeText(prose), prose)
  for (const text of [
    "A header: Authorization: Bearer synthetic-secret-value",
    "Proxy-Authorization = Basic dXNlcjpwYXNzd29yZA=="
  ])
    assert.notInclude(summarySafeText(text), text.split(" ").at(-1)!)
})
