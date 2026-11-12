// The exact-position cache repeat per view (spec/CHARACTER-CONTEXT.md §2.3, unit C7): on a
// provider without lookback (Bedrock), each request marks the position its own last request
// marked, so the cache it wrote is read. In a separate context each character's history differs
// after what one of them missed, so each character repeats its own last position, not that of
// whichever character spoke last. A shared context records exactly what it did before.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { cachePrefixDigests } from "../src/assembler/breakpoints.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture, type FixtureMessage } from "./support/assemblySources.ts"
import { studyModel } from "./support/cacheStudy.ts"
import { cardDoc } from "./support/docs.ts"

const both = (n: number): FixtureMessage => ({
  side: n % 2 ? "assistant" : "user",
  ...(n % 2 ? { speaker: "mira" } : {}),
  content: `Line ${n} of the road. ` + "The lanterns swing. ".repeat(20),
  knowers: ["wren", "mira"]
})
const miraOnly = (n: number): FixtureMessage => ({
  side: "assistant",
  speaker: "mira",
  content: `SECRET ${n}. ` + "Only Mira hears this. ".repeat(20),
  knowers: ["mira"]
})

const fixture = (
  messages: ReadonlyArray<FixtureMessage>,
  speaker: string,
  historyStart: ContextSnapshot["historyStart"] | null,
  setting: "separate" | "shared" = "separate"
): AssemblyFixture => ({
  messages,
  cards: [
    { entity: "wren", doc: cardDoc("Wren") },
    { entity: "mira", doc: cardDoc("Mira") }
  ],
  participants: ["wren", "mira"],
  target: { speaker },
  historyStart,
  events: [{ depth: null, event: { scope: null, data: { key: "context.per_speaker", value: setting } } }],
  model: { ...studyModel, cacheLayout: { lookback: false } },
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0, openai_max_context: 131072, openai_max_tokens: 200 }))
    .document!
})

/** The digest of each history marker a request placed. */
const marked = (s: ContextSnapshot) => {
  const digests = cachePrefixDigests(s.request.messages)
  return s.request.breakpoints.filter((b) => b.reason === "history").map((b) => digests[b.message])
}

it.effect("each character in a separate context repeats its own last cache position", () =>
  Effect.gen(function* () {
    const path = [
      ...Array.from({ length: 10 }, (_, n) => both(n)),
      ...Array.from({ length: 4 }, (_, n) => miraOnly(10 + n)),
      ...Array.from({ length: 6 }, (_, n) => both(14 + n))
    ]
    const wren1 = yield* assembleFixture(fixture(path, "wren", null))
    const wrenDigest = wren1.historyStart?.state?.cacheHistoryByView?.["wren"]
    assert.isString(wrenDigest)
    assert.include(marked(wren1), wrenDigest)
    // Mira speaks next; her history holds what Wren missed, so her positions are her own.
    const grown = [...path, both(20), both(21)]
    const mira = yield* assembleFixture(fixture(grown, "mira", wren1.historyStart))
    assert.strictEqual(mira.historyStart?.state?.cacheHistoryByView?.["wren"], wrenDigest, "Wren's is carried")
    assert.notStrictEqual(mira.historyStart?.state?.cacheHistoryByView?.["mira"], wrenDigest)
    // Wren again, after Mira's request: she marks the position her own last request wrote.
    const wren2 = yield* assembleFixture(fixture([...grown, both(22), both(23)], "wren", mira.historyStart))
    assert.include(marked(wren2), wrenDigest)
  })
)

it.effect("a shared context records the repeat as before, with no per-view entry", () =>
  Effect.gen(function* () {
    const path = Array.from({ length: 16 }, (_, n) => both(n))
    const first = yield* assembleFixture(fixture(path, "wren", null, "shared"))
    assert.isString(first.historyStart?.state?.cacheHistory)
    assert.notProperty(first.historyStart?.state ?? {}, "cacheHistoryByView")
    const next = yield* assembleFixture(fixture([...path, both(16), both(17)], "mira", first.historyStart, "shared"))
    assert.include(marked(next), first.historyStart!.state!.cacheHistory!)
    assert.notProperty(next.historyStart?.state ?? {}, "cacheHistoryByView")
  })
)
