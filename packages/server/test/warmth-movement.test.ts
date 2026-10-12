import type { Source, ContextSnapshot } from "../src/assembler/types.ts"
import type { AssemblyFixture } from "./support/assemblySources.ts"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { assembleFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { prefixChange } from "../src/assembler/warmth.ts"
const describe = (s: Source) => ({ label: s.kind === "message" ? `Message ${s.slot}` : s.kind })
const base: AssemblyFixture = {
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  messages: Array.from({ length: 40 }, (_, i) => ({ side: i % 2 ? "assistant" : "user", content: `Turn ${i} road` })),
  model: {
    connectionId: "c",
    connectionRevision: 0,
    modelId: "m",
    kind: "openai-chat",
    api: "openai-completions",
    key: "mock-model",
    prefill: "none",
    cacheBreakpoints: "auto",
    context: 200000,
    presetOverride: null
  },
  preset: importStPreset(JSON.stringify({ openai_max_context: 10000, openai_max_tokens: 100 })).document!,
  events: [{ depth: null, event: { scope: null, data: { key: "layout.cards", value: "concat" } } }]
}
it.effect("new note placement with roomy budget does not blame the history budget", () =>
  Effect.gen(function* () {
    for (const depth of [0, 5, 10, 20, 39]) {
      const note: NonNullable<AssemblyFixture["notes"]>[number] = {
        entity: "note",
        revision: "note-rev",
        first: false,
        doc: {
          schema_version: 1,
          title: "Added note",
          content: "NEW STABLE NOTE",
          owner: { chat: "chat-1" as never },
          placement: { mode: "depth", depth, role: "system" },
          exportable: false,
          interval: 1
        }
      }
      const a = yield* assembleFixture({ ...base, notes: [note] })
      const b = yield* assembleFixture({
        ...base,
        notes: [note],
        events: [
          ...base.events!,
          { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "note" as never } } } }
        ]
      })
      const history = (s: ContextSnapshot) =>
        s.pieces.filter((p) => p.source.kind === "message" && p.messages.length > 0).map((p) => [p.id, p.text])
      assert.deepStrictEqual(history(a), history(b))
      const changed = prefixChange(a, b, describe)
      if (depth === 0) assert.isNull(changed)
      else assert.match(changed!.reason, /notes|cache prefix/)
    }
  })
)
