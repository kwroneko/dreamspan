import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeAssembler } from "../src/assembler/assembler.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture, type FixtureMessage } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"

const fixture = (messages: ReadonlyArray<FixtureMessage>, context = 2000): AssemblyFixture => ({
  messages,
  cards: [
    { entity: "wren", doc: cardDoc("Wren") },
    { entity: "mira", doc: cardDoc("Mira") }
  ],
  participants: ["wren", "mira"],
  target: { speaker: "wren" },
  events: [{ depth: null, event: { scope: null, data: { key: "context.per_speaker", value: "separate" } } }],
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0, openai_max_context: context, openai_max_tokens: 100 }))
    .document!
})
const known = (content: string): FixtureMessage => ({
  side: "assistant",
  speaker: "mira",
  content,
  knowers: ["wren", "mira"]
})
const missed = (): FixtureMessage => ({ side: "assistant", speaker: "mira", content: "SECRET", knowers: ["mira"] })
const text = (s: ContextSnapshot) => s.request.messages.map((m) => m.content).join("\n")

it.effect("a budget cut inside a missed stretch never invents a shorter gap count", () =>
  Effect.gen(function* () {
    const s = yield* assembleFixture(
      fixture([known("old ".repeat(3000)), ...Array.from({ length: 300 }, missed), known("Wren returns.")], 1000)
    )
    assert.notInclude(text(s), "SECRET")
    assert.notInclude(text(s), "old old old")
    assert.include(text(s), "Wren returns.")
    const gaps = s.request.messages.filter((m) => String(m.content).includes("wasn't present"))
    assert.lengthOf(gaps, 1)
    assert.include(String(gaps[0]!.content), "300 messages")
    // Once newer known messages fill the read budget, a partial older run gets no partial line.
    const cut = yield* assembleFixture(
      fixture(
        [
          known("Before."),
          ...Array.from({ length: 300 }, missed),
          ...Array.from({ length: 10 }, () => known("recent ".repeat(300)))
        ],
        1000
      )
    )
    assert.notInclude(text(cut), "wasn't present")
    assert.notInclude(text(cut), "SECRET")
  })
)

it.effect("prompt regex rewrites the gap's system message and the inspector records its script", () =>
  Effect.gen(function* () {
    const fx = fixture([known("Before."), missed(), known("After.")])
    const imported = importStPreset(
      JSON.stringify({
        frequency_penalty: 0,
        extensions: {
          regex_scripts: [
            {
              id: "gap-rewrite",
              scriptName: "Gap wording",
              findRegex: "/wasn't present/g",
              replaceString: "was away",
              trimStrings: [],
              placement: [2],
              disabled: false,
              markdownOnly: false,
              promptOnly: true,
              runOnEdit: false,
              substituteRegex: 0,
              minDepth: null,
              maxDepth: null
            }
          ]
        }
      })
    ).document!
    const s = yield* assembleFixture({ ...fx, preset: { ...imported, regex_approved: true } })
    const line = s.request.messages.find((m) => String(m.content).includes("was away"))
    assert.strictEqual(line?.role, "system")
    assert.notProperty(line ?? {}, "name")
    assert.notInclude(text(s), "wasn't present")
    assert.isTrue(
      s.pieces.some((p) => p.source.kind === "context/gap" && p.scripts?.some((script) => script.id === "gap-rewrite"))
    )
  })
)

it.effect("shared requests and source evidence equal the pipeline with the new stages disabled", () =>
  Effect.gen(function* () {
    const fx = { ...fixture([known("Before."), missed(), known("After.")]), events: [] }
    const assembler = yield* makeAssembler
    const added = yield* assembleFixture(fx, { assembler })
    yield* assembler.stages.disable("knowledge")
    yield* assembler.stages.disable("gap-lines")
    const before = yield* assembleFixture(fx, { assembler })
    assert.strictEqual(JSON.stringify(added.request), JSON.stringify(before.request))
    assert.deepStrictEqual(added.inputs, before.inputs)
    assert.deepStrictEqual(added.pieces, before.pieces)
    assert.deepStrictEqual(added.issues, before.issues)
  }).pipe(Effect.scoped)
)

it.effect("a replacement card keeps its character's knowledge without acquiring an away message", () =>
  Effect.gen(function* () {
    const fx = fixture([known("REMEMBERED"), missed(), known("After.")])
    const s = yield* assembleFixture({
      ...fx,
      cards: [...fx.cards, { entity: "wren-fork", doc: cardDoc("Wren progressed") }],
      target: { speaker: "wren-fork" },
      events: [
        ...fx.events!,
        {
          depth: null,
          event: {
            scope: null,
            data: { key: "card.swap", value: { entity: "wren-fork" as never, replaces: "wren" as never } }
          }
        }
      ]
    })
    assert.include(text(s), "REMEMBERED")
    assert.notInclude(text(s), "SECRET")
    // Her earlier identity is never named among those who took part.
    const gap = s.request.messages.find((m) => String(m.content).includes("wasn't present"))
    assert.include(String(gap?.content), "in which Mira took part")
  })
)

it.effect("a gap names who took part even after they left the cast", () =>
  Effect.gen(function* () {
    const fx = fixture([
      known("Before."),
      { side: "assistant", speaker: "kai", content: "SECRET", knowers: ["mira", "kai"] },
      known("After.")
    ])
    // Kai was there for the missed message and has since left; Mira stayed.
    const s = yield* assembleFixture({ ...fx, cards: [...fx.cards, { entity: "kai", doc: cardDoc("Kai") }] })
    const gap = s.request.messages.find((m) => String(m.content).includes("wasn't present"))
    assert.include(String(gap?.content), "in which Mira and Kai took part")
    assert.notInclude(text(s), "SECRET")
  })
)
