import { assert, it } from "@effect/vitest"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Effect } from "effect"
import { elideCarried } from "../src/agent/continuity.ts"

const result = (id: string, text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read_card",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 1
})
const user = (): AgentMessage => ({ role: "user", content: "Next turn", timestamp: 1 })
const oldResults = Array.from({ length: 8 }, (_, i) => result(`old-${i}`, "a".repeat(1600)))
const transcript = [user(), ...oldResults, user(), result("recent", "b".repeat(1600))]
// A compressible vocabulary: character estimates overstate the savings. The injected
// recount is the authority, just as CountRolloutContext's selected tokenizer is in production.
const count = (messages: ReadonlyArray<AgentMessage>) =>
  800 + messages.reduce((n, m) => n + (m.role === "toolResult" ? JSON.stringify(m.content).length / 16 : 0), 0)
const compact = (messages: ReadonlyArray<AgentMessage>, base = 0) =>
  elideCarried({
    reader: {} as never, // No path entries: no storage reads are needed to name the markers.
    request: {} as never,
    path: [],
    transcript: messages,
    count: count(messages) + base,
    room: 2000,
    recount: (next) => Effect.succeed(count(next) + base)
  })

it.effect("recounts until the half-window target, preserving the newest turn and deterministic bytes", () =>
  Effect.gen(function* () {
    const first = yield* compact(transcript)
    assert.isNotNull(first)
    assert.isAtMost(first!.count, 1000)
    assert.deepStrictEqual(first!.transcript.at(-1), transcript.at(-1))
    assert.deepStrictEqual(yield* compact(transcript), first)
    assert.strictEqual(JSON.stringify(oldResults[0]), JSON.stringify(transcript[1]))
  })
)

it.effect("refuses a shortened carry when protected material cannot reach the half-window target", () =>
  Effect.gen(function* () {
    assert.isNull(yield* compact(transcript, 600))
  })
)
