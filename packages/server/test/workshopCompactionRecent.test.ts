import { assert, it } from "@effect/vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Effect, Stream } from "effect"
import { activeRunSummaries } from "../src/agent/compaction.ts"
import { liveSuffix } from "../src/agent/messages.ts"
import { workshopCompactor } from "../src/agent/workshopCompactor.ts"
import type { Reader } from "../src/db/Database.ts"
import type { Providers } from "../src/providers/Providers.ts"

// The recent pair on a large model (review-worklcm2): the band applies to what in-run
// summaries can reduce, and never hides a tool result the model hasn't read yet.
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const group = (n: number, text: string): Array<AgentMessage> => [
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
    content: [{ type: "text", text }],
    timestamp: 0
  }
]
const start: Array<AgentMessage> = [
  { role: "rpRequest", timestamp: 0 },
  { role: "rpUser", message: { role: "user", content: "Synthetic task: read the keeper." }, timestamp: 0 }
]

const setup = (recentPrefix: number) => {
  const sent: Array<unknown> = []
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
          target: 150,
          recentTarget: 1000,
          recentMax: 2200,
          layerMax: 4000,
          changes: "[]",
          tail: null,
          model: { api: "openai-completions", kind: "openai-chat", key: "synthetic-summary", context: 32768 }
        })
      )
  } as unknown as Reader["Service"]
  const providers = {
    stream: (request: unknown) => {
      sent.push(request)
      return Stream.succeed({ type: "text", delta: "Read keeper; no edits." })
    }
  } as unknown as Providers["Service"]
  const compact = (transcript: ReadonlyArray<AgentMessage>) =>
    workshopCompactor.compact({
      reader,
      providers,
      request: { userId: "synthetic", chatId: "workshop" } as never,
      rolloutId: "synthetic-run",
      model: { context: 786432 } as never,
      prefix: { messages: [], samplers: {} } as never,
      messages: transcript,
      tools: [],
      leafSlotId: null,
      reserve: 4096,
      recentPrefix
    })
  return { compact, sent }
}

it.effect("never summarizes a tool result the model hasn't read yet for the recent maximum", () =>
  Effect.gen(function* () {
    const { compact } = setup(0)
    // One card read larger than the recent maximum, far inside the model's window.
    const transcript = [
      ...start,
      ...group(0, "Synthetic lookup. ".repeat(140)),
      ...group(1, "Synthetic lookup. ".repeat(700))
    ]
    const out = yield* compact(transcript)
    const sentIds = liveSuffix(out).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []))
    assert.notInclude(sentIds, "read-0", "the older read is summarized")
    assert.include(sentIds, "read-1", "the newest result is sent as it was returned")
  })
)

it.effect(
  "compacts in batches, not on every request, while the prefix sits between the recent target and maximum",
  () =>
    Effect.gen(function* () {
      // Between replies, planning lets the recent part grow to its maximum before summarizing.
      const { compact, sent } = setup(2100)
      let transcript: Array<AgentMessage> = [...start]
      const turns = 24
      for (let n = 0; n < turns; n++) {
        transcript = [...(yield* compact([...transcript, ...group(n, "Synthetic lookup. ".repeat(20))]))]
        const ids = liveSuffix(transcript).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []))
        assert.include(ids, `read-${n}`)
      }
      assert.isAbove(activeRunSummaries(transcript).length, 0, "the run still compacts")
      assert.isAtMost(sent.length, turns / 3, "summary requests come in batches")
    })
)
