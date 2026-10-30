import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { NewVersion, type ForkId, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { cacheIdentity } from "../src/providers/cacheIdentity.ts"
import { markWireSources, wireContext } from "../src/assembler/wire.ts"
import { type ContextSnapshot, generationOf, type Source } from "../src/assembler/types.ts"
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
/**
 * Mira and Oren, Mira always speaking: a note "while Oren isn't muted" comes and goes as Oren
 * is muted and unmuted, which changes neither the speaker nor the cards sent.
 */
const pair = {
  cards: [
    { entity: "mira", doc: cardDoc("Mira") },
    { entity: "oren", doc: cardDoc("Oren") }
  ],
  participants: ["mira", "oren"],
  target: { speaker: "mira" }
} satisfies Partial<AssemblyFixture>
const whileOren = { condition: { when: "not_muted", card: "oren" as never } } as const
const oren = (present: boolean) => ({
  depth: null,
  event: { scope: null, data: { key: "presence.set" as const, value: { entity: "oren" as never, present } } }
})
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
          const identity = (snapshot: ContextSnapshot, end = lastBreakpoint(snapshot)) => {
            const sources = wireContext(snapshot.request, snapshot.inputs.model!)
            const payload = {
              messages: sources.messages.map(({ role, content, name }) => ({
                role,
                content,
                ...(name ? { name } : {})
              }))
            }
            markWireSources(payload, sources)
            return cacheIdentity({
              payload,
              api: "openai-completions",
              mode: "auto",
              scope: ["synthetic-owner", "synthetic-route"],
              sources,
              end
            })
          }
          const oldIdentity = identity(previous)
          const newIdentity = identity(next)
          assert.isNotNull(oldIdentity.requested)
          assert.isAtMost(cost(next), 400)
          if (next.historyMove === "maximum") {
            assert.notInclude(newIdentity.prefixes, oldIdentity.requested!)
            jumps.push(count)
            assert.isAbove(next.historyStart!.depth, previous.historyStart!.depth)
            assert.isAtMost(cost(next), 320)
            assert.match(
              prefixChange(previous, next, () => ({ label: "Message" }))!.reason,
              /context reached its maximum/
            )
            // The cut keeps the prefix before the history (DESIGN §1.3): (a) comes first and is unchanged.
            const prefix = next.request.breakpoints[0]!
            assert.strictEqual(prefix.reason, "prefix")
            assert.deepStrictEqual(
              next.request.messages.slice(0, prefix.message + 1),
              previous.request.messages.slice(0, prefix.message + 1)
            )
          } else {
            assert.deepStrictEqual(next.historyStart, previous.historyStart)
            const end = lastBreakpoint(previous)
            assert.deepStrictEqual(next.request.messages.slice(0, end + 1), previous.request.messages.slice(0, end + 1))
            assert.isNull(prefixChange(previous, next, () => ({ label: "Message" })))
            assert.include(newIdentity.prefixes, oldIdentity.requested!)
            assert.strictEqual(identity(next, lastBreakpoint(previous)).requested, oldIdentity.requested)
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
          `keeps the entire prefix over due and skipped conditioned notes: ${layout}/${postprocess}/examples=${withExamples}`,
          () =>
            Effect.gen(function* () {
              const fixture: AssemblyFixture = {
                ...base,
                ...pair,
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
                  },
                  { entity: "oren", doc: cardDoc("Oren") }
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
                    doc: {
                      schema_version: 1,
                      title: "While Oren isn't muted",
                      content: "N".repeat(withExamples ? 480 : 400),
                      owner: { chat: "chat-1" as never },
                      placement: { mode: "depth", depth: 0, role: "system" },
                      ...whileOren,
                      exportable: false
                    }
                  }
                ]
              }
              let previous = yield* assembleFixture({
                ...fixture,
                events: [...fixture.events!, oren(false)],
                messages: messages(1)
              })
              let held = 0
              for (let n = 3; n < 32; n += 2) {
                const next = yield* assembleFixture({
                  ...fixture,
                  events: [...fixture.events!, oren(n % 4 === 3)],
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
        preset: { ...doc, pin_examples: true, prefill: { ...doc.prefill, assistant: "begin" } },
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
        preset: { ...base.preset, pin_examples: true },
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

  it.effect("keeps full author notes when lore surrounds the note", () =>
    Effect.gen(function* () {
      const fixture: AssemblyFixture = {
        ...base,
        // Leave room for the newest turn; exhausting its target is now an explicit error.
        preset: { ...preset, context_target: 380 },
        messages: messages(24),
        events: [
          {
            depth: null,
            event: { scope: null, data: { key: "var.set", value: { name: "long", value: "Q".repeat(1000) } } }
          },
          { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "author" as never } } } },
          { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: "book" as never } } } },
          // Entries by position: these ride on the author's note.
          { depth: null, event: { scope: null, data: { key: "lorebook.below_history", value: { on: false } } } }
        ],
        notes: [
          {
            entity: "author",
            revision: "author-rev",
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
      assert.ok(note, "the full note must still be sent")
      assert.strictEqual(note.content, `top\n${"Q".repeat(1000)}\nbottom`)
      const history = built.request.messages.filter((message) => message.content.startsWith("Turn "))
      assert.strictEqual(history.length, 24 - built.historyStart!.depth)
      assert.isAtMost(cost(built), 400)
    })
  )
  it.effect("keeps a variable note reservation when the expansion is empty", () =>
    Effect.gen(function* () {
      const fixture: AssemblyFixture = {
        ...base,
        // Leave room for the newest turn; exhausting its target is now an explicit error.
        preset: { ...preset, context_target: 380 },
        notes: [
          {
            entity: "variable",
            revision: "variable-rev",
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
      assert.strictEqual(previous.historyStart!.depth, nonempty.historyStart!.depth)
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
  for (const layout of ["st", "concat", "swap_tail"] as const) {
    for (const postprocess of ["none", "merge", "semi", "strict"] as const) {
      for (const placement of [
        { mode: "tail", role: "system" },
        { mode: "depth", depth: 2, role: "user" },
        { mode: "section", section: "before_main_prompt", role: "system" },
        { mode: "section", section: "after_main_prompt", role: "assistant" }
      ] as const) {
        it.effect(`preserves full notes: ${layout}/${postprocess}/${JSON.stringify(placement)}`, () =>
          Effect.gen(function* () {
            const content = `${"Q".repeat(480)} KEEP THIS INSTRUCTION`
            const built = yield* assembleFixture({
              ...base,
              preset: { ...preset, postprocess },
              messages: messages(1),
              notes: [
                {
                  entity: "full",
                  revision: "nr",
                  doc: {
                    schema_version: 1,
                    title: "Full",
                    content: "{{getvar::long}} KEEP THIS INSTRUCTION",
                    owner: { chat: "chat-1" as never },
                    placement,
                    exportable: false
                  }
                }
              ],
              events: [
                ...(layout === "st"
                  ? []
                  : [{ depth: null, event: { scope: null, data: { key: "layout.cards" as const, value: layout } } }]),
                {
                  depth: null,
                  event: { scope: null, data: { key: "note.activate", value: { note: "full" as never } } }
                },
                {
                  depth: null,
                  event: { scope: null, data: { key: "var.set", value: { name: "long", value: "Q".repeat(480) } } }
                }
              ]
            })
            assert.ok(built.request.messages.some((m) => m.content.includes(content)))
            assert.strictEqual(built.pieces.find((p) => p.source.kind === "note")!.text, content)
            assert.isFalse(built.issues.some((issue) => issue.kind === "macro_limit"))
            assert.isAtMost(cost(built), 400)
          })
        )
      }
    }
  }
  it.effect("fits four short static macro notes without speculative per-note allowances", () =>
    Effect.gen(function* () {
      const notes = Array.from({ length: 4 }, (_, i) => ({
        entity: `hello-${i}`,
        revision: "nr",
        doc: {
          schema_version: 1 as const,
          title: "Hello",
          content: "Hello {{char}}",
          owner: { chat: "chat-1" as never },
          placement: { mode: "tail" as const, role: "system" as const },
          exportable: false
        }
      }))
      const built = yield* assembleFixture({
        ...base,
        messages: messages(1),
        notes,
        events: notes.map((note) => ({
          depth: null,
          event: { scope: null, data: { key: "note.activate", value: { note: note.entity as never } } }
        }))
      })
      assert.strictEqual(
        built.request.messages
          .map((m) => m.content)
          .join("\n")
          .split("Hello Mira").length - 1,
        4
      )
      assert.isAtMost(cost(built), 140)
      assert.strictEqual(built.historyStart!.depth, 0)
    })
  )

  for (const postprocess of ["none", "merge", "semi", "strict"] as const) {
    it.effect(`bounds shared skipped-note capacity including depth and role framing: ${postprocess}`, () =>
      Effect.gen(function* () {
        const notes: NonNullable<AssemblyFixture["notes"]> = Array.from({ length: 24 }, (_, i) => ({
          entity: `padding-${i}`,
          revision: "nr",
          doc: {
            schema_version: 1,
            title: "Padding",
            content: "padding padding",
            ...whileOren,
            owner: { chat: "chat-1" as never },
            placement: { mode: "depth", depth: i + 1, role: (["system", "user", "assistant"] as const)[i % 3]! },
            exportable: false
          }
        }))
        const built = yield* assembleFixture({
          ...base,
          ...pair,
          preset: { ...preset, postprocess },
          messages: messages(49),
          notes,
          events: [
            oren(false),
            ...notes.map((note) => ({
              depth: null,
              event: { scope: null, data: { key: "note.activate" as const, value: { note: note.entity as never } } }
            }))
          ]
        })
        const allowance = built.historyStart!.state!.noteBudget!.allowance
        assert.isAtMost(allowance, 90)
        assert.isFalse(built.request.messages.some((message) => message.content.includes("padding")))
        const worstAllowed = yield* assembleFixture({
          ...base,
          ...pair,
          preset: { ...preset, postprocess, context_target: 320 - allowance },
          messages: messages(49),
          events: [oren(false)]
        })
        assert.isAtMost(
          built.historyStart!.depth,
          worstAllowed.historyStart!.depth,
          "framing must not make speculative capacity discard more than its shared token ceiling"
        )
        assert.isAtMost(cost(built), 320)
      })
    )
  }

  for (const layout of ["st", "concat", "swap_tail"] as const) {
    for (const postprocess of ["none", "merge", "semi", "strict"] as const) {
      it.effect(`preserves full periodic expansions without repeated growth events: ${layout}/${postprocess}`, () =>
        Effect.gen(function* () {
          const fixture: AssemblyFixture = {
            ...base,
            ...pair,
            preset: { ...preset, postprocess },
            notes: [
              {
                entity: "periodic",
                revision: "nr",
                doc: {
                  schema_version: 1,
                  title: "Periodic",
                  content: "{{getvar::payload}} KEEP THIS INSTRUCTION",
                  owner: { chat: "chat-1" as never },
                  placement: { mode: "tail", role: "system" },
                  ...whileOren,
                  exportable: false
                }
              }
            ]
          }
          let previous: Effect.Success<ReturnType<typeof assembleFixture>> | undefined
          let growthEvents = 0
          for (let i = 0; i < 12; i++) {
            const due = i % 2 === 1
            const payload = i === 3 || i === 7 ? "short" : "Q".repeat(480)
            const next = yield* assembleFixture({
              ...fixture,
              messages: messages(1 + 2 * i),
              ...(previous ? { historyStart: previous.historyStart! } : {}),
              events: [
                ...(layout === "st"
                  ? []
                  : [{ depth: null, event: { scope: null, data: { key: "layout.cards" as const, value: layout } } }]),
                {
                  depth: null,
                  event: { scope: null, data: { key: "note.activate", value: { note: "periodic" as never } } }
                },
                {
                  depth: null,
                  event: { scope: null, data: { key: "var.set", value: { name: "payload", value: payload } } }
                },
                oren(due)
              ]
            })
            if (due)
              assert.ok(
                next.request.messages.some((message) => message.content.includes(`${payload} KEEP THIS INSTRUCTION`))
              )
            else
              assert.isFalse(next.request.messages.some((message) => message.content.includes("KEEP THIS INSTRUCTION")))
            assert.isFalse(next.issues.some((issue) => issue.kind === "macro_limit"))
            assert.isAtMost(cost(next), 400)
            if (next.historyMove === "budget") growthEvents++
            if (i > 1)
              assert.notStrictEqual(next.historyMove, "budget", "the same observed expansion is not new growth")
            if (previous) {
              assert.isAtLeast(next.historyStart!.depth, previous.historyStart!.depth)
              if (next.historyMove === "unchanged")
                assert.deepStrictEqual(
                  next.request.messages.slice(0, lastBreakpoint(previous) + 1),
                  previous.request.messages.slice(0, lastBreakpoint(previous) + 1)
                )
            }
            previous = next
          }
          assert.strictEqual(growthEvents, 1)
        })
      )
    }
  }

  it.effect("preserves the complete formatted summary expansion and trailing instructions", () =>
    Effect.gen(function* () {
      const content = "S".repeat(480)
      const built = yield* assembleFixture({
        ...base,
        messages: messages(1),
        notes: [
          {
            entity: "summary-full",
            revision: "nr",
            doc: {
              schema_version: 1,
              title: "Summary",
              kind: "imported_summary",
              content: "{{getvar::summary_text}}",
              template: "SUMMARY {{summary}} FINAL SUMMARY INSTRUCTION",
              owner: { chat: "chat-1" as never },
              placement: { mode: "section", section: "after_main_prompt", role: "system" },
              exportable: false
            }
          }
        ],
        events: [
          {
            depth: null,
            event: { scope: null, data: { key: "note.activate", value: { note: "summary-full" as never } } }
          },
          {
            depth: null,
            event: { scope: null, data: { key: "var.set", value: { name: "summary_text", value: content } } }
          }
        ]
      })
      const expanded = `SUMMARY ${content} FINAL SUMMARY INSTRUCTION`
      assert.ok(built.request.messages.some((message) => message.content.includes(expanded)))
      assert.strictEqual(built.pieces.find((piece) => piece.source.kind === "note")!.text, expanded)
      assert.isAtMost(cost(built), 320)
      assert.isFalse(built.issues.some((issue) => issue.kind === "macro_limit"))
    })
  )

  it.effect("fails for genuine full-note overflow without sending shortened instructions", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        assembleFixture({
          ...base,
          messages: messages(1),
          notes: [
            {
              entity: "oversized",
              revision: "nr",
              doc: {
                schema_version: 1,
                title: "Oversized",
                content: "{{getvar::payload}} KEEP THIS INSTRUCTION",
                owner: { chat: "chat-1" as never },
                placement: { mode: "tail", role: "system" },
                exportable: false
              }
            }
          ],
          events: [
            {
              depth: null,
              event: { scope: null, data: { key: "note.activate", value: { note: "oversized" as never } } }
            },
            {
              depth: null,
              event: { scope: null, data: { key: "var.set", value: { name: "payload", value: "Q".repeat(2000) } } }
            }
          ]
        })
      )
      assert.strictEqual(error._tag, "AssemblyFailed")
      if (error._tag === "AssemblyFailed") assert.strictEqual(error.reason, "budget")
    })
  )
})

// Over the database: the sources read the display path by position (spec/MESSAGE-INSERT.md §3.2).
const database = () =>
  Database.layer({ dataDir: tempDir("stepped-insert"), readers: 1, allowNetworkFs: false, workers: "source" })
const NOW = Date.UTC(2026, 0, 1)
const storedPreset = importStPreset(
  readFileSync(new URL("fixtures/presets/default.json", import.meta.url), "utf8")
).document!

describe("stepped history with inserted messages", () => {
  it.live(
    "an insertion before the start keeps the prefix; one after it cuts nothing; deleting one is a reduction",
    () =>
      Effect.gen(function* () {
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })).id as UserId
        const entity = (kind: "card" | "preset", label: string, doc: object) =>
          writer.CreateEntity({
            userId,
            kind,
            label,
            subtitle: "",
            doc: doc as never,
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
        const mira = yield* entity("card", "Mira", cardDoc("Mira"))
        const steps = yield* entity("preset", "Steps", {
          ...storedPreset,
          samplers: { ...storedPreset.samplers, openai_max_context: 500, openai_max_tokens: 40 }
        })
        yield* writer.ChangeGenerationDefaults({ userId, change: { preset: steps.ref.id as never } })
        const connectionId = uuidv7() as ConnectionId
        yield* writer.CreateConnection({
          userId,
          connectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: {
            name: "Steps",
            baseUrl: null,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          credential: { existing: null }
        })
        const model = yield* writer.AddUserModel({ userId, connectionId, key: "steps", overrides: { context: 500 } })
        yield* writer.ChangeGenerationDefaults({
          userId,
          change: { model: { connection: connectionId, model: model.id } as never }
        })
        const chat = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Steps",
          participants: [mira.entityId],
          greeting: null
        })
        const main = chat.currentForkId as ForkId
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "lcm.settings", value: { enabled: false } }
        })
        const version = (content: string, generating = false, macroMode: "verbatim" | "template" = "verbatim") =>
          new NewVersion({
            speakerEntityId: null,
            writer: generating ? "model" : "human",
            content,
            status: generating ? "generating" : "complete",
            macroMode,
            origin: generating ? "generated" : "user_written"
          })
        const send = (
          forkId: ForkId,
          parent: SlotId | null,
          content = "u".repeat(100),
          macroMode: "verbatim" | "template" = "verbatim"
        ) =>
          Effect.map(
            writer.AppendMessage({
              userId,
              chatId: chat.id,
              forkId,
              parentSlotId: parent,
              branch: false,
              commitDraft: null,
              version: version(content, false, macroMode)
            }),
            (m) => m.slotId
          )
        /** A reply generated at the end of `forkId`, its context recorded as a rollout's. */
        const generate = (forkId: ForkId, parent: SlotId) =>
          Effect.gen(function* () {
            const posted = yield* writer.AppendMessage({
              userId,
              chatId: chat.id,
              forkId,
              parentSlotId: parent,
              branch: false,
              commitDraft: null,
              version: version("", true)
            })
            const { snapshot: json } = yield* reader.AssembleContext({
              userId,
              chatId: chat.id,
              forkId,
              slotId: posted.slotId,
              versionId: posted.version.id,
              now: NOW,
              timeZone: "UTC",
              frozen: null
            })
            const snapshot = JSON.parse(json) as ContextSnapshot
            const gen = generationOf(snapshot)
            const rolloutId = uuidv7()
            yield* writer.StartRollout({
              userId,
              chatId: chat.id,
              forkId,
              slotId: posted.slotId,
              versionId: posted.version.id,
              rolloutId,
              leafSlotId: parent,
              connectionId,
              modelId: model.id,
              snapshot: json,
              issues: gen.issues,
              variables: gen.variables,
              frozenMessages: []
            })
            yield* writer.SaveGeneration({
              userId,
              versionId: posted.version.id,
              content: "r".repeat(100),
              status: "complete",
              error: null
            })
            yield* writer.FinishRollout({
              userId,
              versionId: posted.version.id,
              rolloutId,
              status: "completed",
              error: null
            })
            return { slot: posted.slotId, snapshot }
          })
        const insert = (forkId: ForkId, anchor: SlotId, content: string) =>
          Effect.gen(function* () {
            const { entry } = yield* reader.GetSlot({ userId, slotId: anchor, forkId })
            const made = yield* writer.InsertMessage({
              userId,
              chatId: chat.id,
              forkId,
              anchorSlotId: anchor,
              expectedRowVersion: entry.rowVersion,
              body: { _tag: "Write", speaker: null, content }
            })
            return made.slotId
          })
        const texts = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => m.content)
        const labelOf = (source: Source) => ({ label: source.kind === "message" ? source.slot : source.kind })

        // Grow the chat until the history is cut, and stop right after a cut, with room to spare.
        const path: Array<SlotId> = [yield* send(main, null)]
        let last = yield* generate(main, path[0]!)
        path.push(last.slot)
        while (!(last.snapshot.historyMove === "maximum" && last.snapshot.historyStart!.depth >= 4)) {
          path.push(yield* send(main, last.slot))
          last = yield* generate(main, path.at(-1)!)
          path.push(last.slot)
          assert.isBelow(path.length, 80)
        }
        const start = last.snapshot.historyStart!
        assert.strictEqual(start.slotId, path[start.depth])
        const fork = (at: SlotId) =>
          Effect.map(writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: at }), (f) => f.fork.id)

        // Before the start: the model doesn't see it, and the start, its revision and the prefix hold.
        const before = yield* fork(last.slot)
        const early = yield* insert(before, path[1]!, "Inserted before the start.")
        const held = yield* generate(before, yield* send(before, last.slot))
        assert.strictEqual(held.snapshot.historyMove, "unchanged")
        assert.strictEqual(held.snapshot.historyStart!.slotId, start.slotId)
        assert.strictEqual(held.snapshot.historyStart!.depth, start.depth + 1, "the start's position")
        assert.strictEqual(held.snapshot.historyStart!.state!.revision, start.state!.revision, "no reduction")
        assert.notInclude(texts(held.snapshot), "Inserted before the start.")
        assert.isNull(prefixChange(last.snapshot, held.snapshot, labelOf))

        // HistoryPanel forwards this preview's history start as retainedDepth to HistoryEditCost.
        // The wire name is historical: it is a display position, not the slot's graph depth.
        const preview = yield* reader.CacheWarmth({ userId, chatId: chat.id, forkId: before, leafSlotId: held.slot })
        const retained = preview.historyStart!
        const window = yield* reader.GetPath({ userId, chatId: chat.id, forkId: before, leafSlotId: null, limit: 100 })
        const retainedEntry = window.entries.find((e) => e.slotId === retained.slotId)!
        assert.strictEqual(retained.depth, retainedEntry.position)
        assert.notStrictEqual(retained.depth, retainedEntry.depth)
        const estimate = yield* reader.HistoryEditCost({
          userId,
          chatId: chat.id,
          forkId: before,
          fromDepth: 0,
          retainedDepth: retained.depth,
          summaryIds: []
        })
        assert.strictEqual(estimate.messages, window.entries.filter((e) => e.position! >= retained.depth).length)

        // After the start: nothing is cut, and the prefix changes from the inserted message on.
        const after = yield* fork(last.slot)
        const anchor = path[start.depth + 1]!
        const late = yield* insert(after, anchor, "Inserted after the start.")
        // A template after it numbers the messages by position: the last before it is one further on.
        const shifted = yield* generate(after, yield* send(after, last.slot, "N={{lastMessageId}}", "template"))
        assert.include(texts(shifted.snapshot), `N=${path.length}`)
        assert.strictEqual(shifted.snapshot.historyMove, "unchanged")
        assert.deepStrictEqual(shifted.snapshot.historyStart!.slotId, start.slotId)
        assert.strictEqual(shifted.snapshot.historyStart!.depth, start.depth)
        const sent = texts(shifted.snapshot)
        const at = sent.indexOf("Inserted after the start.")
        assert.isAbove(at, 0)
        assert.deepStrictEqual(sent.slice(0, at), texts(last.snapshot).slice(0, at))
        assert.strictEqual(prefixChange(last.snapshot, shifted.snapshot, labelOf)!.reason, `${late} was inserted.`)
        // The inserted message is numbered by its place: the one after it moves down by one.
        const entries = shifted.snapshot.sources!.history.flatMap((w) => w.entries)
        const placed = entries.find((e) => e.slotId === late)!
        assert.isTrue(placed.inserted)
        assert.strictEqual(entries.find((e) => e.slotId === anchor)!.depth + 1, placed.depth)
        assert.strictEqual(entries.find((e) => e.slotId === path[start.depth + 2])!.depth, placed.depth + 1)
        // The other forks are as they were: the main fork's next reply holds its start and prefix.
        const mainNext = yield* generate(main, yield* send(main, last.slot))
        assert.deepStrictEqual(mainNext.snapshot.historyStart!.slotId, start.slotId)
        assert.notInclude(texts(mainNext.snapshot), "Inserted after the start.")
        assert.notInclude(texts(mainNext.snapshot), "Inserted before the start.")

        // Deleting the message inserted before the start is a reduction there, which may restore.
        yield* writer.DeleteMessage({ userId, slotId: early, forkId: before })
        const reduced = yield* generate(before, yield* send(before, held.slot))
        assert.strictEqual(reduced.snapshot.historyStart!.state!.revision, start.state!.revision + 1)
        assert.notInclude(texts(reduced.snapshot), "Inserted before the start.")
      }).pipe(Effect.provide(database()))
  )
})
