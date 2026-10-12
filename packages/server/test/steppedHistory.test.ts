import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { tokensOf } from "../src/assembler/st.ts"
import { prefixChange, lastBreakpoint } from "../src/assembler/warmth.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { cardDoc } from "./support/docs.ts"

const preset = importStPreset(JSON.stringify({ openai_max_context: 400, openai_max_tokens: 40 })).document!
const base: AssemblyFixture = {
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  messages: [],
  preset,
  model: {
    connectionId: "c",
    connectionRevision: 0,
    modelId: "m",
    kind: "openai-chat",
    api: "openai-completions",
    key: "mock",
    prefill: "none",
    cacheBreakpoints: "auto",
    context: null,
    presetOverride: null
  }
}
const messages = (count: number): AssemblyFixture["messages"] =>
  Array.from({ length: count }, (_, i) => ({
    side: i % 2 ? "assistant" : "user",
    content: `Turn ${i}: ${"x".repeat(70)}`
  }))
const cost = (snapshot: Effect.Success<ReturnType<typeof assembleFixture>>) =>
  3 + 40 + snapshot.request.messages.reduce((sum, m) => sum + tokensOf(m), 0)

describe("stepped history", () => {
  for (const layout of ["st", "concat", "swap_tail"] as const) {
    it.effect(`holds the cached prefix between maximum crossings in ${layout}`, () =>
      Effect.gen(function* () {
        const events: AssemblyFixture["events"] =
          layout === "st" ? [] : [{ depth: null, event: { scope: null, data: { key: "layout.cards", value: layout } } }]
        let previous = yield* assembleFixture({ ...base, events, messages: messages(1) })
        const jumps: Array<number> = []
        let held = 0
        for (let count = 2; count < 60; count++) {
          const next = yield* assembleFixture({
            ...base,
            events,
            messages: messages(count),
            historyStart: previous.historyStart!
          })
          assert.isAtMost(cost(next), 400)
          if (next.historyMove === "maximum") {
            jumps.push(count)
            assert.isAbove(next.historyStart!.depth, previous.historyStart!.depth)
            assert.isAtMost(cost(next), 320)
            assert.match(
              prefixChange(previous, next, () => ({ label: "Message" }))!.reason,
              /context reached its maximum/
            )
          } else {
            assert.deepStrictEqual(next.historyStart, previous.historyStart)
            const end = lastBreakpoint(previous)
            assert.deepStrictEqual(next.request.messages.slice(0, end + 1), previous.request.messages.slice(0, end + 1))
            assert.isNull(prefixChange(previous, next, () => ({ label: "Message" })))
            held++
          }
          previous = next
        }
        assert.isAbove(jumps.length, 2)
        assert.isAbove(held, jumps.length)
        assert.isAbove(jumps[1]! - jumps[0]!, 1)
      })
    )
  }
  it.effect("restores only complete earlier suffixes that fit the target, after edits or a raised maximum", () =>
    Effect.gen(function* () {
      const full = { ...base, messages: messages(24) }
      const cut = yield* assembleFixture(full)
      assert.isAbove(cut.historyStart!.depth, 0)
      const same = yield* assembleFixture({ ...full, historyStart: cut.historyStart! })
      assert.deepStrictEqual(same.historyStart, cut.historyStart)
      const shorter = yield* assembleFixture({
        ...full,
        historyStart: cut.historyStart!,
        messages: full.messages.map((m) => ({ ...m, content: "s" }))
      })
      assert.strictEqual(shorter.historyStart!.depth, 0)
      assert.strictEqual(shorter.historyMove, "restore")
      const raised = yield* assembleFixture({
        ...full,
        historyStart: cut.historyStart!,
        preset: { ...preset, samplers: { ...preset.samplers, openai_max_context: 2000 } }
      })
      assert.strictEqual(raised.historyStart!.depth, 0)
      assert.strictEqual(raised.historyMove, "restore")
    })
  )
  it.effect("hidden messages spend nothing, and an explicit preset target controls the cut", () =>
    Effect.gen(function* () {
      const visible = messages(20)
      const a = yield* assembleFixture({ ...base, messages: visible, preset: { ...preset, context_target: 240 } })
      const b = yield* assembleFixture({
        ...base,
        messages: visible.map((m, i) => (i < 12 ? { ...m, inContext: false, content: "h".repeat(20000) } : m)),
        preset: { ...preset, context_target: 240 }
      })
      assert.isAtMost(cost(a), 240)
      assert.strictEqual(b.historyStart!.depth, 12)
      assert.isFalse(b.request.messages.some((m) => m.content.includes("hhhh")))
    })
  )
  it.effect("counts examples, notes, summaries, prefill, lore tail capacity and response in one total", () =>
    Effect.gen(function* () {
      const doc = {
        ...preset,
        utility_prompts: { ...preset.utility_prompts, new_example_chat_prompt: "Example {{setvar::example_once::1}}" }
      }
      const fixture: AssemblyFixture = {
        ...base,
        preset: { ...doc, prefill: { ...doc.prefill, assistant: "begin" } },
        model: { ...base.model!, prefill: "assistant" },
        messages: messages(30),
        cards: [
          {
            entity: "mira",
            doc: { ...cardDoc("Mira"), mes_example: "<START>\nUser: An example.\nMira: A short answer." }
          }
        ],
        events: [
          { depth: null, event: { scope: null, data: { key: "layout.cards", value: "concat" } } },
          { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "summary" as never } } } },
          { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: "book" as never } } } }
        ],
        notes: [
          {
            entity: "summary",
            revision: "summary-rev",
            first: false,
            doc: {
              schema_version: 1,
              title: "Summary",
              kind: "imported_summary",
              content: "Earlier story.",
              owner: { chat: "chat-1" as never },
              placement: { mode: "section", section: "after_main_prompt", role: "system" },
              exportable: false
            }
          }
        ],
        lorebooks: [
          {
            id: "book",
            entity: "book",
            revision: "book-rev",
            doc: loreBook([loreEntry({ content: "Reserved lore", keys: ["never matches"] })]).document
          }
        ]
      }
      const cut = yield* assembleFixture(fixture)
      // Unactivated eligible lore still reserves its stable tail (four content tokens + three framing tokens).
      assert.isAtMost(cost(cut) + tokensOf({ content: "begin" }) + tokensOf({ content: "Reserved lore" }), 320)
      assert.strictEqual(cut.effects.filter((e) => e.name === "example_once").length, 1)
      assert.ok(cut.request.messages.some((m) => m.content.includes("An example.")))
      assert.ok(cut.request.messages.some((m) => m.content.includes("Earlier story.")))
      const grown = yield* assembleFixture({ ...fixture, historyStart: cut.historyStart!, messages: messages(31) })
      assert.deepStrictEqual(grown.historyStart, cut.historyStart)
      assert.isNull(prefixChange(cut, grown, () => ({ label: "Message" })))
      const replay = yield* assembleFixture(fixture, { frozen: cut.frozen })
      assert.deepStrictEqual(replay, cut)
    })
  )
  it.effect("caps admitted examples by their full cost, including the new-chat marker", () =>
    Effect.gen(function* () {
      const card = { ...cardDoc("Mira"), description: "", mes_example: `<START>\nUser: ${"x".repeat(1233)}\nMira: y` }
      const built = yield* assembleFixture({ ...base, cards: [{ entity: "mira", doc: card }] })
      assert.isAtMost(cost(built), 400)
      assert.ok(built.issues.some((issue) => issue.kind === "examples_truncated"))
    })
  )
  it.effect("counts names and placeholders introduced by post-processing toward both thresholds", () =>
    Effect.gen(function* () {
      for (const postprocess of ["single", "strict", "semi", "merge"] as const) {
        const fixture = {
          ...base,
          cards: [{ entity: "mira", doc: { ...cardDoc("m".repeat(80)), description: "" } }],
          preset: { ...preset, postprocess },
          messages: messages(11)
        }
        const built = yield* assembleFixture(fixture)
        assert.isAtMost(cost(built), 400)
        if (built.historyMove === "maximum") assert.isAtMost(cost(built), 320)
        const grown = yield* assembleFixture({ ...fixture, historyStart: built.historyStart!, messages: messages(12) })
        assert.isAtMost(cost(grown), 400)
      }
    })
  )
})
