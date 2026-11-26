// How a merged chat reaches the model (spec/CHAT-MERGE.md §4, §5): the request each built-in
// layout sends, as a snapshot, over the in-memory sources; the chat's layout choice, an unknown
// layout, the preset's templates, causal order, and the summary request's per-line sections.
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { importStPreset } from "../src/formats/preset.ts"
import type { PositionedEvent } from "../src/assembler/pipeline.ts"
import {
  assembleFixture,
  historyAfterDispatch,
  type AssemblyFixture,
  type FixtureMessage
} from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { studyModel } from "./support/cacheStudy.ts"
import { cachePrefixDigests } from "../src/assembler/breakpoints.ts"

const transcript = ["Kai: The rain came in over the docks.", "Ana: We wait under the awning."].join("\n\n")

const join = (start: string | null, framing: string | null = null): FixtureMessage => ({
  side: "user",
  content: transcript,
  merge: { id: "merge-1", title: "Docks", framing, start, cast: ["Kai"] }
})

const layout = (id: string): PositionedEvent => ({
  depth: null,
  event: { scope: null, data: { key: "merge.layout", value: id } }
})

const fixture = (
  messages: ReadonlyArray<FixtureMessage>,
  events: ReadonlyArray<PositionedEvent> = [],
  utility: Record<string, string> = {}
): AssemblyFixture => ({
  messages,
  cards: [
    { entity: "mira", doc: cardDoc("Mira") },
    { entity: "kai", doc: cardDoc("Kai") },
    { entity: "ana", doc: cardDoc("Ana") }
  ],
  participants: ["mira", "kai"],
  persona: "ana",
  events,
  preset: (() => {
    const doc = importStPreset(
      JSON.stringify({
        prompts: [{ identifier: "main", role: "system", content: "Main prompt" }],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: "main", enabled: true },
              { identifier: "chatHistory", enabled: true }
            ]
          }
        ]
      })
    ).document!
    return { ...doc, utility_prompts: { ...doc.utility_prompts, ...utility } }
  })()
})

const own: ReadonlyArray<FixtureMessage> = [
  { side: "assistant", content: "Mira greets you at the gate.", speaker: "mira" },
  { side: "user", content: "We leave the gate.", speaker: "ana" },
  { side: "assistant", content: "Mira leads the way to the market.", speaker: "mira" },
  { side: "user", content: "We buy apples.", speaker: "ana" },
  { side: "assistant", content: "Mira haggles.", speaker: "mira" }
]

const sent = (fx: AssemblyFixture) =>
  Effect.map(assembleFixture(fx), (snapshot) =>
    snapshot.request.messages.map((m) => ({ role: m.role, content: m.content }))
  )

describe("merge layouts", () => {
  it.effect("parallel span: the section opens the destination's parallel span, the marker sits at the join", () =>
    Effect.gen(function* () {
      const messages = yield* sent(fixture([...own, join("slot-2")]))
      expect(messages).toMatchSnapshot()
      const section = messages.findIndex((m) => String(m.content).includes("Kai: The rain"))
      const market = messages.findIndex((m) => String(m.content).includes("market"))
      const marker = messages.findIndex((m) => String(m.content).includes("joins this chat"))
      assert.strictEqual(messages[section]!.role, "system")
      assert.include(String(messages[section]!.content), "Meanwhile, in parallel with what follows: Docks, with Kai.")
      assert.strictEqual(section + 1, market)
      assert.isAbove(
        marker,
        messages.findIndex((m) => String(m.content).includes("haggles"))
      )
      assert.strictEqual(messages[marker]!.role, "system")
    })
  )

  it.effect("block at the join: heading, the source and the marker where the merge is", () =>
    Effect.gen(function* () {
      const messages = yield* sent(fixture([...own, join("slot-2")], [layout("join")]))
      expect(messages).toMatchSnapshot()
      const section = messages.findIndex((m) => String(m.content).includes("Kai: The rain"))
      assert.isAbove(
        section,
        messages.findIndex((m) => String(m.content).includes("haggles"))
      )
      assert.include(String(messages[section + 1]!.content), "joins this chat")
    })
  )

  it.effect("an empty span, or a start outside the history read, still places the section", () =>
    Effect.gen(function* () {
      const direct = yield* sent(fixture([...own, join(null)]))
      const at = direct.findIndex((m) => String(m.content).includes("Kai: The rain"))
      assert.include(String(direct[at - 1]!.content), "haggles")
      const outside = yield* sent(fixture([...own, join("slot-gone")]))
      const first = outside.findIndex((m) => String(m.content).includes("Kai: The rain"))
      assert.include(String(outside[first + 1]!.content), "greets")
    })
  )

  it.effect(
    "an unknown layout falls back to parallel with an issue; the preset's templates and the merge's line apply",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* assembleFixture(
          fixture([...own, join("slot-2", "Elsewhere: {{title}} ({{cast}})")], [layout("gone")], {
            merge_join_prompt: "<join {{title}}>"
          } as never)
        )
        assert.isTrue(snapshot.issues.some((issue) => issue.kind === "merge_layout_missing"))
        const contents = snapshot.request.messages.map((m) => String(m.content))
        assert.isTrue(contents.some((c) => c.startsWith("Elsewhere: Docks (Kai)")))
        assert.isTrue(contents.some((c) => c.includes("<join Docks>")))
        assert.isTrue(snapshot.pieces.some((p) => p.source.kind === "merge/join"))
      })
  )

  it.effect("a message before the join never sees the merged chat", () =>
    Effect.gen(function* () {
      // Regenerating message 3 assembles from the path before it, which has no join.
      const messages = yield* sent(fixture(own.slice(0, 3)))
      assert.isFalse(messages.some((m) => String(m.content).includes("Kai: The rain")))
    })
  )

  it.effect("a chat without merges assembles as before", () =>
    Effect.gen(function* () {
      const plain = yield* assembleFixture(fixture(own))
      assert.isFalse(plain.pieces.some((p) => p.source.kind === "merge/join"))
    })
  )

  for (const mode of ["parallel", "join"])
    it.effect(`keeps byte-identical cache checkpoints as history grows (${mode})`, () =>
      Effect.gen(function* () {
        const fx = {
          ...fixture([...own, join("slot-2")], [layout(mode)]),
          model: { ...studyModel, cacheLayout: { lookback: false, summarySplit: true } }
        }
        const before = yield* assembleFixture(fx)
        const previous = historyAfterDispatch(before)
        const after = yield* assembleFixture({
          ...fx,
          historyStart: previous,
          messages: [...fx.messages, { side: "user", content: "The next morning." }]
        })
        const digests = cachePrefixDigests(after.request.messages)
        const history = after.request.breakpoints.filter((b) => b.reason === "history")
        assert.isTrue(history.some((b) => digests[b.message] === previous?.state?.cacheHistory))
        const changed = yield* assembleFixture({
          ...fx,
          historyStart: previous,
          messages: fx.messages.map((m) => (m.merge ? { ...m, content: "Kai: A different telling." } : m))
        })
        assert.isFalse(
          changed.request.breakpoints.some(
            (b) =>
              b.reason === "history" &&
              cachePrefixDigests(changed.request.messages)[b.message] === previous?.state?.cacheHistory
          )
        )
      })
    )

  for (const withPreset of [true, false])
    it.effect(
      `a summary over a join asks for one section per line (${withPreset ? "with" : "without"} the preset)`,
      () =>
        Effect.gen(function* () {
          const snapshot = yield* assembleFixture(fixture([...own, join("slot-2")]), {
            summarizing: true,
            summaryJob: {
              id: "synthetic-summary",
              clipTokens: 1000,
              inputs: [],
              tail: "Summarize the material.",
              style: "direct",
              withPreset
            }
          })
          const last = String(snapshot.request.messages.at(-1)!.content)
          assert.include(last, "Summarize the material.")
          assert.include(last, "one section per line")
          assert.include(last, "“Docks”")
          // The merged text is part of the material the summary reads.
          assert.isTrue(snapshot.request.messages.some((m) => String(m.content).includes("Kai: The rain")))
          const plain = yield* assembleFixture(fixture(own), {
            summarizing: true,
            summaryJob: {
              id: "synthetic-summary",
              clipTokens: 1000,
              inputs: [],
              tail: "Summarize the material.",
              style: "direct",
              withPreset
            }
          })
          assert.strictEqual(String(plain.request.messages.at(-1)!.content), "Summarize the material.")
        })
    )
})
