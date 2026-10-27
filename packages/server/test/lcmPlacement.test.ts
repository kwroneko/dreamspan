import { assert, it } from "@effect/vitest"
import { Summary } from "@rp/shared/lcm.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import { Effect, Schema } from "effect"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { wireContext } from "../src/assembler/wire.ts"

const summary = (i: number) =>
  Schema.decodeUnknownSync(Summary)({
    id: `summary-${i}`,
    chatId: "chat-1",
    level: 1,
    firstSlotId: `slot-${i}`,
    lastSlotId: `slot-${i}`,
    from: i + 1,
    to: i + 1,
    slotCount: 1,
    revisionNumber: 1,
    revisionId: `revision-${i}`,
    content: `LAYER CONTENT ${i}`,
    tokens: 6,
    origin: "generated",
    status: "complete",
    error: null,
    batchId: null,
    rowVersion: 1,
    fresh: true,
    inputs: [],
    children: []
  })
const fixture = (placement: NoteDoc["placement"], presetFields: Record<string, unknown> = {}): AssemblyFixture => ({
  messages: [
    { side: "user", content: "covered" },
    { side: "assistant", content: "RAW FIRST" },
    { side: "user", content: "RAW SECOND" }
  ],
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0, ...presetFields })).document!,
  summaries: [summary(0)],
  notes: [
    {
      entity: "imported",
      revision: "note-revision",
      first: false,
      doc: {
        schema_version: 1,
        title: "Imported",
        content: "old summary",
        placement,
        owner: { chat: summary(0).chatId },
        exportable: true,
        kind: "imported_summary",
        template: "Summary: {{summary}}"
      }
    }
  ],
  events: [
    { depth: null, event: { scope: null, data: { key: "lcm.settings", value: { enabled: true } } } },
    { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "imported" as never } } } }
  ]
})

for (const depth of [1, 2])
  it.effect(`ST depth-${depth} layer stays ahead of raw history even when older raw is omitted`, () =>
    Effect.gen(function* () {
      const input = fixture({ mode: "depth", depth, role: "system" }, { openai_max_context: 300, openai_max_tokens: 1 })
      const snapshot = yield* assembleFixture({
        ...input,
        messages: [
          input.messages[0]!,
          { side: "assistant", content: "RAW FIRST " + "x".repeat(depth === 2 ? 1400 : 0) },
          input.messages[2]!
        ]
      })
      const messages = snapshot.request.messages.map((m) => m.content)
      const layer = messages.findIndex((m) => m.includes("LAYER CONTENT"))
      assert.isAtLeast(layer, 0)
      assert.isBelow(
        layer,
        messages.findIndex((m) => m.includes("RAW SECOND"))
      )
      assert.isFalse(messages.some((m) => m.includes("old summary")))
      if (depth === 1)
        assert.isBelow(
          layer,
          messages.findIndex((m) => m.includes("RAW FIRST"))
        )
      else assert.deepStrictEqual(snapshot.lcm!.omitted, [{ from: 2, to: 2 }])
    })
  )

it.effect("absolute preset summary prompts survive the raw budget in our layouts", () =>
  Effect.gen(function* () {
    const input = fixture(
      { mode: "none" },
      {
        openai_max_context: 300,
        openai_max_tokens: 1,
        prompts: [
          { identifier: "main", role: "system", content: "Fixed main" },
          {
            identifier: "summary",
            role: "user",
            content: "{{summary}}",
            system_prompt: false,
            injection_position: 1,
            injection_depth: 2
          }
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: "main", enabled: true },
              { identifier: "summary", enabled: true },
              { identifier: "chatHistory", enabled: true }
            ]
          }
        ]
      }
    )
    const snapshot = yield* assembleFixture({
      ...input,
      messages: [input.messages[0]!, { side: "assistant", content: "x".repeat(1400) }, input.messages[2]!],
      events: [
        ...input.events!,
        { depth: null, event: { scope: null, data: { key: "layout.cards", value: "concat" } } }
      ]
    })
    const layer = snapshot.request.messages.filter((m) => m.content.includes("LAYER CONTENT"))
    assert.lengthOf(layer, 1)
    assert.strictEqual(layer[0]!.role, "system")
    assert.include(layer[0]!.content, "<summaries>")
  })
)

it.effect("a card override that removes the summary cannot falsely claim its coverage", () =>
  Effect.gen(function* () {
    const input = fixture(
      { mode: "none" },
      { prompts: [{ identifier: "main", role: "system", content: "Story: {{summary}}", system_prompt: true }] }
    )
    const snapshot = yield* assembleFixture({
      ...input,
      cards: [{ entity: "mira", doc: cardDoc("Mira", { system_prompt: "STATIC CARD MAIN" }) }]
    })
    assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("LAYER CONTENT")))
    for (const p of snapshot.pieces.filter((p) => p.source.kind === "summary"))
      assert.isTrue(p.messages.every((i) => snapshot.request.messages[i]!.content.includes("LAYER CONTENT")))
  })
)

it.effect("rendered layer framing stays inside the example-prefix allowance", () =>
  Effect.gen(function* () {
    const make = (count: number, raw: number) => {
      // Room for the default group nudge after the history (DESIGN §2.2) as well.
      const input = fixture({ mode: "none" }, { openai_max_context: 540, openai_max_tokens: 1 })
      return assembleFixture({
        ...input,
        notes: [],
        summaries: Array.from({ length: count }, (_, i) => summary(i)),
        cards: [
          {
            entity: "mira",
            doc: cardDoc("Mira", { mes_example: "<START>\nUser: " + "x".repeat(1328) + "\nMira: Example response." })
          }
        ],
        messages: [
          ...input.messages,
          ...Array.from({ length: raw }, () => ({ side: "user" as const, content: "Tail " + "x".repeat(100) }))
        ],
        events: [
          ...input.events!,
          { depth: null, event: { scope: null, data: { key: "layout.cards", value: "concat" } } }
        ]
      })
    }
    const examples = (s: Effect.Success<ReturnType<typeof make>>) =>
      s.request.messages.filter((m) => m.content.includes("Example response."))
    const a = examples(yield* make(1, 0))
    assert.isNotEmpty(a)
    assert.deepStrictEqual(examples(yield* make(2, 0)), a)
    assert.deepStrictEqual(examples(yield* make(1, 12)), a)
  })
)

it.effect("Anthropic and Responses inspection keep summary provenance after system extraction", () =>
  Effect.gen(function* () {
    const input = fixture({ mode: "none" })
    const snapshot = yield* assembleFixture({
      ...input,
      notes: [],
      preset: { ...input.preset, use_sysprompt: true },
      events: [
        ...input.events!,
        { depth: null, event: { scope: null, data: { key: "layout.cards", value: "concat" } } }
      ]
    })
    for (const api of ["anthropic-messages", "openai-responses"] as const) {
      const wire = wireContext(snapshot.request, {
        connectionId: "synthetic",
        modelId: "model",
        kind: api === "anthropic-messages" ? "anthropic" : "openai-responses",
        api,
        key: "model",
        prefill: "none",
        context: null,
        presetOverride: null,
        cacheBreakpoints: "explicit"
      })
      const layer = wire.messages.find((m) => m.content.includes("LAYER CONTENT"))!
      assert.isTrue(layer.inputs.every((i) => snapshot.request.messages[i]!.content.includes("LAYER CONTENT")))
      assert.isFalse(wire.messages[0]!.content.includes("LAYER CONTENT"))
    }
  })
)

for (const placement of [null, "before_main_prompt", "after_main_prompt"] as const)
  it.effect(`beside-main summary precedes history when main follows it: ${placement ?? "default"}`, () =>
    Effect.gen(function* () {
      const input = fixture(
        { mode: "section", section: placement ?? "after_main_prompt", role: "user" },
        {
          prompts: [{ identifier: "main", role: "system", content: "FIXED MAIN", system_prompt: true }],
          prompt_order: [
            {
              character_id: 100001,
              order: [
                { identifier: "chatHistory", enabled: true },
                { identifier: "main", enabled: true }
              ]
            }
          ]
        }
      )
      const snapshot = yield* assembleFixture({ ...input, ...(placement === null ? { notes: [] } : {}) })
      const messages = snapshot.request.messages
      // One assembly path: the layer is the system block before the history, whatever the imported note's role.
      assert.strictEqual(messages.find((m) => m.content.includes("LAYER CONTENT"))!.role, "system")
      assert.isBelow(
        messages.findIndex((m) => m.content.includes("LAYER CONTENT")),
        messages.findIndex((m) => m.content.includes("RAW FIRST"))
      )
    })
  )

it.effect("the first ST summary keeps framing inside the example reservation", () =>
  Effect.gen(function* () {
    // Room for the default group nudge after the history (DESIGN §2.2) as well.
    const input = fixture({ mode: "none" }, { openai_max_context: 540, openai_max_tokens: 1 })
    const make = (count: number) =>
      assembleFixture({
        ...input,
        notes: [],
        summaries: count ? [summary(0)] : [],
        cards: [
          {
            entity: "mira",
            doc: cardDoc("Mira", { mes_example: "<START>\nUser: " + "x".repeat(1480) + "\nMira: Example response." })
          }
        ]
      })
    const examples = (s: Effect.Success<ReturnType<typeof make>>) =>
      s.request.messages.filter((m) => m.content.includes("Example response."))
    const before = examples(yield* make(0))
    assert.isNotEmpty(before)
    assert.deepStrictEqual(examples(yield* make(1)), before)
  })
)

for (const layout of ["st", "concat"] as const)
  it.effect(`the ${layout} stepped start holds across landings before it and advances for landings past it`, () =>
    Effect.gen(function* () {
      const input = fixture(
        { mode: "section", section: "after_main_prompt" },
        {
          openai_max_context: 1000,
          openai_max_tokens: 40
        }
      )
      const events: AssemblyFixture["events"] = [
        ...input.events!,
        ...(layout === "st"
          ? []
          : [{ depth: null, event: { scope: null, data: { key: "layout.cards" as const, value: layout } } }])
      ]
      const messages: AssemblyFixture["messages"] = Array.from({ length: 24 }, (_, i) => ({
        side: "user",
        content: `RAW ${i} ${"r".repeat(150)}`
      }))
      const before = yield* assembleFixture({ ...input, events, messages, summaries: [] })
      assert.isAbove(before.historyStart!.depth, 1)
      assert.isNotEmpty(before.lcm!.omitted)
      const covered = before.historyStart!.depth - 1
      const selected = Array.from({ length: covered }, (_, i) => summary(i))
      const after = yield* assembleFixture({
        ...input,
        events,
        messages,
        summaries: selected,
        historyStart: before.historyStart!
      })
      assert.strictEqual(after.historyStart!.depth, before.historyStart!.depth)
      assert.deepStrictEqual(after.lcm!.omitted, [{ from: covered + 1, to: before.historyStart!.depth }])
      assert.strictEqual(after.lcm!.verbatim!.from, before.historyStart!.depth + 1)
      assert.isFalse(after.request.messages.some((m) => m.content.includes(`RAW ${covered} `)))
      const landed = yield* assembleFixture({
        ...input,
        events,
        messages,
        summaries: [...selected, summary(covered), summary(covered + 1)],
        historyStart: after.historyStart!
      })
      assert.strictEqual(landed.historyStart!.depth, covered + 2)
      assert.deepStrictEqual(landed.lcm!.omitted, [])
      const failed = yield* assembleFixture({
        ...input,
        events,
        messages: messages.slice(0, 4),
        summaries: [],
        historyStart: before.historyStart!
      })
      assert.strictEqual(failed.historyStart!.depth, 0)
      assert.deepStrictEqual(failed.lcm!.omitted, [])
      const over = yield* assembleFixture({
        ...input,
        events,
        messages: [...messages, ...messages],
        summaries: selected,
        historyStart: after.historyStart!
      })
      assert.isAbove(over.historyStart!.depth, covered)
      assert.strictEqual(over.lcm!.omitted[0]!.from, covered + 1)
      assert.strictEqual(over.lcm!.omitted[0]!.to, over.historyStart!.depth)
      assert.strictEqual(over.historyMove, "maximum")
      assert.strictEqual(over.historyBudget, after.historyBudget)
    })
  )

it.effect("unused layer allowance never rejects fixed content that fits", () =>
  Effect.gen(function* () {
    const input = fixture(
      { mode: "none" },
      {
        openai_max_context: 1000,
        openai_max_tokens: 1,
        prompts: [{ identifier: "main", role: "system", content: "x".repeat(3500), system_prompt: true }]
      }
    )
    const built = yield* assembleFixture({ ...input, notes: [], messages: [], summaries: [] })
    assert.isTrue(built.request.messages.some((m) => m.content.length === 3500))
  })
)
