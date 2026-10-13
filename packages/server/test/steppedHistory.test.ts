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
  for (const layout of ["st", "concat", "swap_tail"] as const) {
    for (const postprocess of ["none", "merge", "semi", "strict"] as const) {
      for (const withExamples of [false, true]) {
        it.effect(
          `keeps the entire prefix over due and skipped intervals: ${layout}/${postprocess}/examples=${withExamples}`,
          () =>
            Effect.gen(function* () {
              const fixture: AssemblyFixture = {
                ...base,
                preset: { ...preset, postprocess },
                cards: [
                  {
                    entity: "mira",
                    doc: {
                      ...cardDoc("Mira"),
                      mes_example: withExamples
                        ? `<START>\nUser: ${"E".repeat(300)}\nMira: yes\n<START>\nUser: ${"F".repeat(500)}\nMira: no`
                        : ""
                    }
                  }
                ],
                events: [
                  ...(layout === "st"
                    ? []
                    : [{ depth: null, event: { scope: null, data: { key: "layout.cards" as const, value: layout } } }]),
                  {
                    depth: null,
                    event: { scope: null, data: { key: "note.activate", value: { note: "interval" as never } } }
                  }
                ],
                notes: [
                  {
                    entity: "interval",
                    revision: "nr",
                    first: false,
                    doc: {
                      schema_version: 1,
                      title: "Interval",
                      content: "N".repeat(withExamples ? 480 : 400),
                      owner: { chat: "chat-1" as never },
                      placement: { mode: "depth", depth: 0, role: "system" },
                      interval: 2,
                      exportable: false
                    }
                  }
                ]
              }
              let previous = yield* assembleFixture({ ...fixture, messages: messages(1) })
              let held = 0
              for (let n = 3; n < 32; n += 2) {
                const next = yield* assembleFixture({
                  ...fixture,
                  messages: messages(n),
                  historyStart: previous.historyStart!
                })
                assert.isAtLeast(
                  next.historyStart!.depth,
                  previous.historyStart!.depth,
                  "ordinary sends never restore history"
                )
                assert.isAtMost(cost(next), 400)
                if (next.historyMove === "unchanged") {
                  assert.deepStrictEqual(
                    next.request.messages.slice(0, lastBreakpoint(previous) + 1),
                    previous.request.messages.slice(0, lastBreakpoint(previous) + 1),
                    "the entire reusable prefix stays identical"
                  )
                  if (lastBreakpoint(previous) >= 0)
                    assert.isNull(prefixChange(previous, next, () => ({ label: "Message" })))
                  assert.deepStrictEqual(
                    next.request.messages.filter((m) => m.name?.startsWith("example")),
                    previous.request.messages.filter((m) => m.name?.startsWith("example"))
                  )
                  held++
                }
                previous = next
              }
              assert.isAbove(held, 0)
            })
        )
      }
    }
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
  it.effect("restores for pre-boundary reductions or a higher target, never retained-only edits", () =>
    Effect.gen(function* () {
      const full = { ...base, messages: messages(24) }
      const cut = yield* assembleFixture(full)
      const depth = cut.historyStart!.depth
      const retained = yield* assembleFixture({
        ...full,
        historyStart: cut.historyStart!,
        messages: full.messages.map((m, i) => (i >= depth ? { ...m, content: "s" } : m))
      })
      assert.strictEqual(retained.historyStart!.depth, depth)
      assert.strictEqual(retained.historyMove, "unchanged")
      for (const hidden of [false, true]) {
        const reduced = yield* assembleFixture({
          ...full,
          historyStart: cut.historyStart!,
          messages: full.messages.map((m, i) =>
            i < depth ? { ...m, content: "s", inContext: !hidden || i === depth - 1 } : m
          )
        })
        assert.isBelow(reduced.historyStart!.depth, depth)
        assert.strictEqual(reduced.historyMove, "restore")
      }
      const raised = yield* assembleFixture({
        ...full,
        historyStart: cut.historyStart!,
        preset: { ...preset, context_target: 390 }
      })
      assert.isBelow(raised.historyStart!.depth, depth)
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
  it.effect("recomputes the target after growing examples are readmitted at a cut", () =>
    Effect.gen(function* () {
      const fixture: AssemblyFixture = {
        ...base,
        cards: [
          {
            entity: "mira",
            doc: {
              ...cardDoc("Mira"),
              mes_example: "<START>\nUser: a\nMira: yes\n<START>\nUser: {{getvar::long}}\nMira: no"
            }
          }
        ]
      }
      const variable = (value: string): NonNullable<AssemblyFixture["events"]> => [
        { depth: null, event: { scope: null, data: { key: "var.set", value: { name: "long", value } } } }
      ]
      const first = yield* assembleFixture({ ...fixture, messages: messages(12), events: variable("short") })
      assert.strictEqual(first.historyStart!.state!.examples, 2)
      const next = yield* assembleFixture({
        ...fixture,
        messages: messages(14),
        events: variable("Q".repeat(2000)),
        historyStart: first.historyStart!
      })
      assert.strictEqual(next.historyMove, "maximum")
      assert.strictEqual(next.historyStart!.state!.examples, 1)
      assert.isAbove(next.historyStart!.depth, first.historyStart!.depth)
      assert.isAtMost(cost(next), 320)
    })
  )

  it.effect("keeps clipped author notes and their history when lore surrounds the note", () =>
    Effect.gen(function* () {
      const fixture: AssemblyFixture = {
        ...base,
        messages: messages(24),
        events: [
          {
            depth: null,
            event: { scope: null, data: { key: "var.set", value: { name: "long", value: "Q".repeat(1000) } } }
          },
          { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "author" as never } } } },
          { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: "book" as never } } } }
        ],
        notes: [
          {
            entity: "author",
            revision: "author-rev",
            first: false,
            doc: {
              schema_version: 1,
              title: "Author",
              kind: "author_note",
              content: "{{getvar::long}}",
              owner: { chat: "chat-1" as never },
              placement: { mode: "depth", depth: 0, role: "system" },
              exportable: false
            }
          }
        ],
        lorebooks: [
          {
            id: "book",
            entity: "book",
            revision: "book-rev",
            doc: loreBook([
              loreEntry({ constant: true, content: "top", position: "an_top" }),
              loreEntry({ constant: true, content: "bottom", position: "an_bottom" }, 1)
            ]).document
          }
        ]
      }
      const built = yield* assembleFixture(fixture)
      const note = built.request.messages.find((message) => message.content.includes("QQ"))
      assert.ok(note, "the clipped note must still be sent")
      assert.strictEqual(note.content, `top\n${"Q".repeat(360)}\nbottom`)
      const history = built.request.messages.filter((message) => message.content.startsWith("Turn "))
      assert.strictEqual(history.length, 24 - built.historyStart!.depth)
      assert.isAbove(history.length, 0)
      assert.isAtMost(cost(built), 320)
    })
  )
  it.effect("keeps a variable note reservation when the expansion is empty", () =>
    Effect.gen(function* () {
      const fixture: AssemblyFixture = {
        ...base,
        notes: [
          {
            entity: "variable",
            revision: "variable-rev",
            first: false,
            doc: {
              schema_version: 1,
              title: "Variable",
              content: "{{getvar::long}}",
              owner: { chat: "chat-1" as never },
              placement: { mode: "tail", role: "system" },
              exportable: false
            }
          }
        ]
      }
      const variable = (value: string): NonNullable<AssemblyFixture["events"]> => [
        { depth: null, event: { scope: null, data: { key: "var.set", value: { name: "long", value } } } },
        { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "variable" as never } } } }
      ]
      let previous = yield* assembleFixture({ ...fixture, messages: messages(12), events: variable("") })
      const nonempty = yield* assembleFixture({ ...fixture, messages: messages(12), events: variable("short") })
      assert.deepStrictEqual(previous.historyStart, nonempty.historyStart, "empty notes reserve the same allowance")
      let held = 0
      for (const [i, value] of ["short", "", "Q".repeat(1000), "", "short"].entries()) {
        const next = yield* assembleFixture({
          ...fixture,
          messages: messages(13 + i),
          events: variable(value),
          historyStart: previous.historyStart!
        })
        assert.isAtLeast(next.historyStart!.depth, previous.historyStart!.depth)
        assert.isAtMost(cost(next), 400)
        if (next.historyMove === "unchanged") {
          assert.deepStrictEqual(
            next.request.messages.slice(0, lastBreakpoint(previous) + 1),
            previous.request.messages.slice(0, lastBreakpoint(previous) + 1)
          )
          held++
        }
        previous = next
      }
      assert.isAbove(held, 0)
    })
  )
})
