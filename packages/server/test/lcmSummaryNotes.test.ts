// Notes and summaries (DESIGN §8, owner 2026-10-28): a summary request sends the chat's notes only
// when the chat says so, and a `{{summary}}` prompt reading a conditioned summary note is never
// inside a cached prefix. Synthetic cards and notes only.
import { assert, it } from "@effect/vitest"
import type { NoteDoc } from "@dreamspan/shared/docs/note.ts"
import { Effect } from "effect"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"

const note = (entity: string, doc: Partial<NoteDoc>) => ({
  entity,
  revision: `${entity}-revision`,
  first: false,
  doc: {
    schema_version: 1,
    title: entity,
    content: `${entity.toUpperCase()} TEXT`,
    placement: { mode: "depth", depth: 1, role: "system" },
    owner: { chat: "chat-1" },
    exportable: true,
    ...doc
  } as NoteDoc
})

const on = (entity: string) => ({
  depth: null,
  event: { scope: null, data: { key: "note.activate" as const, value: { note: entity as never } } }
})

const lcm = (value: Record<string, unknown>) => ({
  depth: null,
  event: { scope: null, data: { key: "lcm.settings" as const, value: { enabled: true, ...value } } }
})

const fixture = (settings: Record<string, unknown>): AssemblyFixture => ({
  messages: [
    { side: "user", content: "FIRST" },
    { side: "assistant", content: "SECOND" },
    { side: "user", content: "THIRD" }
  ],
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!,
  notes: [note("plot", {}), note("outfit", { placement: { mode: "section", section: "tail_end", role: "system" } })],
  events: [lcm(settings), on("plot"), on("outfit")]
})

it.effect("a summary request sends no notes unless the chat includes them", () =>
  Effect.gen(function* () {
    const sent = (snapshot: { request: { messages: ReadonlyArray<{ content: string }> } }) =>
      snapshot.request.messages.map((m) => m.content).join("\n")
    // A reply sends both notes.
    const reply = sent(yield* assembleFixture(fixture({})))
    assert.include(reply, "PLOT TEXT")
    assert.include(reply, "OUTFIT TEXT")
    // A summary request, by default: neither.
    const summary = sent(yield* assembleFixture(fixture({}), { summarizing: true }))
    assert.notInclude(summary, "PLOT TEXT")
    assert.notInclude(summary, "OUTFIT TEXT")
    assert.include(summary, "THIRD")
    // The chat's setting sends them.
    const included = sent(yield* assembleFixture(fixture({ withNotes: true }), { summarizing: true }))
    assert.include(included, "PLOT TEXT")
    assert.include(included, "OUTFIT TEXT")
  })
)

it.effect("a {{summary}} prompt reading a conditioned summary note stays out of the cached prefix", () =>
  Effect.gen(function* () {
    const build = (condition: NoteDoc["condition"] | undefined) =>
      assembleFixture({
        messages: [
          { side: "user", content: "FIRST" },
          { side: "assistant", content: "SECOND" },
          { side: "user", content: "THIRD" }
        ],
        cards: [{ entity: "mira", doc: cardDoc("Mira") }],
        participants: ["mira"],
        preset: importStPreset(
          JSON.stringify({
            frequency_penalty: 0,
            prompts: [{ identifier: "main", role: "system", content: "Story: {{summary}}", system_prompt: true }]
          })
        ).document!,
        notes: [
          note("summary", {
            placement: { mode: "none" },
            kind: "imported_summary",
            content: "the story so far",
            ...(condition ? { condition } : {})
          })
        ],
        events: [on("summary")]
      })
    const holder = (snapshot: { request: { messages: ReadonlyArray<{ content: string }> } }) =>
      snapshot.request.messages.findIndex((m) => m.content.includes("Story: the story so far"))
    const plain = yield* build(undefined)
    assert.isAtLeast(holder(plain), 0)
    assert.isTrue(plain.request.breakpoints.some((b) => b.message >= holder(plain)))
    // Due only while Mira isn't muted: what `{{summary}}` reads can change from turn to turn.
    const conditioned = yield* build({ when: "not_muted", cards: ["mira" as never] })
    assert.isAtLeast(holder(conditioned), 0)
    assert.isFalse(conditioned.request.breakpoints.some((b) => b.message >= holder(conditioned)))
  })
)
