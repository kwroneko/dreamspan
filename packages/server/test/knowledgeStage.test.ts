// The `knowledge` stage on its own (spec/CHARACTER-CONTEXT.md §9.2 C3): which view a chat names,
// whose knowledge filters the history, and the fallback when a view isn't installed.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { builtinContextViews, knowledgeStage, makeContextViewRegistry } from "../src/assembler/knowledge.ts"
import { type Assembly, AssemblySources } from "../src/assembler/pipeline.ts"

const card = (entity: string) => ({ entity, ref: null, revision: "r", doc: {} })

const assembly = (input: {
  setting?: string | null
  speaker?: string | null
  personas?: ReadonlyArray<string>
  roles?: Record<string, string>
  summary?: boolean
  views?: "builtin" | "none"
}) =>
  Effect.gen(function* () {
    const views = makeContextViewRegistry()
    if (input.views !== "none") for (const view of builtinContextViews) yield* views.register(view)
    const speaker = input.speaker === undefined ? "wren" : input.speaker
    const built = {
      request: { contextViews: views, ...(input.summary ? { summaryJob: {} } : {}) },
      state: { contextPerSpeaker: input.setting ?? null, roles: input.roles ?? {} },
      cast: {
        characters: [card("mira"), card("wren")],
        personas: (input.personas ?? []).map(card),
        absent: new Set(),
        speaker: speaker === null ? null : card(speaker),
        type: "normal"
      },
      pieces: [],
      issues: []
    } as unknown as Assembly
    // The stage reads no source: an empty one stands in.
    return yield* knowledgeStage.run(built).pipe(Effect.provideService(AssemblySources, {} as never))
  }).pipe(Effect.scoped)

describe("knowledge stage", () => {
  it.effect("a shared context, or none set, filters for nobody: only a separate join's stretch, for the speaker", () =>
    Effect.gen(function* () {
      const whole = { view: "shared", viewer: null, stretch: { viewer: "wren" } }
      assert.deepStrictEqual((yield* assembly({})).knowledge, whole)
      assert.deepStrictEqual((yield* assembly({ setting: "shared" })).knowledge, whole)
      // A narrator, a persona's turn and a summary read every stretch whole too (spec/THREADS.md §7.3).
      const narrator = { view: "shared", viewer: null }
      assert.deepStrictEqual((yield* assembly({ setting: "shared", roles: { wren: "narrator" } })).knowledge, narrator)
      assert.deepStrictEqual(
        (yield* assembly({ setting: "shared", speaker: "tobin", personas: ["tobin"] })).knowledge,
        narrator
      )
      assert.deepStrictEqual((yield* assembly({ setting: "shared", summary: true })).knowledge, narrator)
    })
  )

  it.effect("a separate context filters for the speaking character, not a narrator, persona, summary or nobody", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* assembly({ setting: "separate" })).knowledge?.viewer, "wren")
      assert.isNull((yield* assembly({ setting: "separate", roles: { wren: "narrator" } })).knowledge?.viewer)
      assert.isNull((yield* assembly({ setting: "separate", speaker: "tobin", personas: ["tobin"] })).knowledge?.viewer)
      assert.isNull((yield* assembly({ setting: "separate", summary: true })).knowledge?.viewer)
      assert.isNull((yield* assembly({ setting: "separate", speaker: null })).knowledge?.viewer)
    })
  )

  it.effect("a view nothing registers records an issue and keeps contexts separate", () =>
    Effect.gen(function* () {
      const built = yield* assembly({ setting: "shared", views: "none" })
      assert.deepStrictEqual(built.knowledge, { view: "separate", viewer: "wren" })
      assert.deepStrictEqual(
        built.issues.map((i) => i.kind),
        ["context_view_missing"]
      )
    })
  )
})
