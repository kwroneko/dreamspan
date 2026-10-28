import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { ContextSnapshot, Source, NoteInput } from "../src/assembler/types.ts"
import type { RefId } from "@rp/shared/library.ts"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { loreEntry, loreBook } from "./support/loreFixtures.ts"
import { cardDoc } from "./support/docs.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { prefixChange, lastBreakpoint } from "../src/assembler/warmth.ts"
import { wireContext } from "../src/assembler/wire.ts"
const describe = (s: Source) => ({
  kind: s.kind,
  label: s.kind === "message" ? `Message ${Number(s.slot.split("-")[1]) + 1}` : "Lorebook “Seam”: entry 0",
  slotId: null
})
const fixture: AssemblyFixture = {
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  messages: Array.from({ length: 40 }, (_, i) => ({
    side: i % 2 ? "assistant" : "user",
    content: `Turn ${i}. ${"road ".repeat(30)}`
  })),
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
  preset: importStPreset(JSON.stringify({ openai_max_context: 1000, openai_max_tokens: 100 })).document!,
  events: [
    { depth: null, event: { scope: null, data: { key: "layout.cards", value: "concat" } } },
    { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: "book" as RefId } } } }
  ]
}
const book = (entries: Parameters<typeof loreBook>[0]) => ({
  id: "book",
  entity: "book",
  revision: "rev-book",
  doc: loreBook(entries).document
})
const prefix = (s: ContextSnapshot) => {
  const w = wireContext(s.request, s.inputs.model!)
  return w.messages
    .slice(0, w.messages.findLastIndex((m) => m.inputs.some((i) => i <= lastBreakpoint(s))) + 1)
    .map(({ inputs: _inputs, ...m }) => m)
}
it.effect("layout tail entry activation and constants preserve provider prefix under tight budget", () =>
  Effect.gen(function* () {
    const a = yield* assembleFixture({
      ...fixture,
      lorebooks: [
        book([
          loreEntry({ keys: ["road"], content: "Active lore text." }),
          loreEntry({ constant: true, content: "Constant lore." }, 1)
        ])
      ]
    })
    const b = yield* assembleFixture({
      ...fixture,
      lorebooks: [
        book([
          loreEntry({ keys: ["ocean"], content: "Active lore text." }),
          loreEntry({ constant: true, content: "Different lore" }, 1)
        ])
      ]
    })
    assert.notDeepEqual(a.request.messages, b.request.messages)
    assert.deepStrictEqual(prefix(a), prefix(b))
    assert.isNull(prefixChange(a, b, describe))
    assert.isNull(prefixChange(b, a, describe))
  })
)
it.effect("lorebook-specific warmth reasons: changed/removed entry and assembled lore wrapper", () =>
  Effect.gen(function* () {
    const a = yield* assembleFixture({
      ...fixture,
      lorebooks: [book([loreEntry({ constant: true, content: "FIRST LORE" })])]
    })
    const at = a.request.messages.findIndex((m) => m.content.includes("FIRST LORE"))
    // Compare the lore source classifier independently of placement; source branches are integration additions.
    const pinned: ContextSnapshot = {
      ...a,
      request: { ...a.request, breakpoints: [{ message: at, reason: "history" }] }
    }
    const b = {
      ...pinned,
      request: {
        ...pinned.request,
        messages: pinned.request.messages.map((m, i) => (i === at ? { ...m, content: "SECOND LORE" } : m))
      },
      pieces: pinned.pieces.map((p) => (p.source.kind === "lorebook" ? { ...p, text: "SECOND LORE" } : p))
    }
    assert.include(prefixChange(pinned, b, describe)!.reason, "lorebook entries that activated changed")
    const c = { ...b, pieces: b.pieces.filter((p) => p.source.kind !== "lorebook") }
    assert.include(prefixChange(pinned, c, describe)!.reason, "isn't in the context any more")
    const wrapper: ContextSnapshot = {
      ...pinned,
      pieces: pinned.pieces.map((p) =>
        p.source.kind === "lorebook" ? { ...p, source: { kind: "assembler", what: "lorebook tail" } } : p
      )
    }
    assert.include(prefixChange(wrapper, b, describe)!.reason, "lorebook entries that activated changed")
  })
)
it.effect("a conditioned note preserves a held prefix until the maximum forces history out", () =>
  Effect.gen(function* () {
    const note: NoteInput = {
      entity: "note",
      revision: "note-rev",
      doc: {
        schema_version: 1,
        title: "Mira's turn",
        content: "INTERMITTENT NOTE",
        owner: { chat: "chat-1" as ChatId },
        placement: { mode: "depth", depth: 0, role: "system" },
        exportable: false,
        condition: { when: "turn", card: "mira" as EntityId }
      }
    }
    // Two characters taking turns: the note goes on Mira's, not on Oren's.
    const base: AssemblyFixture = {
      ...fixture,
      cards: [...fixture.cards, { entity: "oren", doc: cardDoc("Oren") }],
      participants: ["mira", "oren"],
      target: { speaker: "mira" },
      notes: [note],
      events: [
        ...fixture.events!,
        { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "note" as EntityId } } } }
      ],
      lorebooks: [book([loreEntry({ constant: true, content: "Constant lore" })])]
    }
    const a = yield* assembleFixture(base)
    const b = yield* assembleFixture({
      ...base,
      target: { speaker: "oren" },
      historyStart: a.historyStart!,
      messages: [...base.messages, { side: "user", content: "hidden", inContext: false }]
    })
    const sent = (s: ContextSnapshot) => s.request.messages.some((m) => m.content.includes("INTERMITTENT NOTE"))
    const activation = (snapshot: ContextSnapshot) => {
      const source = snapshot.pieces.find((p) => p.source.kind === "note")!.source
      return source.kind === "note" ? source.activation : null
    }
    const decision = { kind: "note" as const, interval: null, userMessages: null, condition: "on Mira's turn" }
    assert.deepStrictEqual(activation(a), { ...decision, activation: "explicit", due: true })
    assert.deepStrictEqual(activation(b), { ...decision, activation: "explicit", due: false })
    // A card's note on in every chat is on without the chat switching it on.
    const cardNote = { ...note, doc: { ...note.doc, owner: { card: "mira" as EntityId }, on_by_default: true } }
    const defaultOn = yield* assembleFixture({ ...base, notes: [cardNote], events: fixture.events! })
    assert.deepStrictEqual(activation(defaultOn), { ...decision, activation: "default", due: true })
    assert.notEqual(sent(a), sent(b))
    assert.deepStrictEqual(prefix(a), prefix(b))
    assert.isNull(prefixChange(a, b, describe))
    const roomy = {
      ...base,
      preset: importStPreset(JSON.stringify({ openai_max_context: 10000, openai_max_tokens: 100 })).document!
    }
    const c = yield* assembleFixture(roomy)
    const d = yield* assembleFixture({
      ...roomy,
      target: { speaker: "oren" },
      messages: [...roomy.messages, { side: "user", content: "hidden", inContext: false }]
    })
    assert.deepStrictEqual(prefix(c), prefix(d))
    assert.isNull(prefixChange(c, d, describe))
    let previous = b
    let crossed = false
    for (let count = 1; count <= 12; count++) {
      const next = yield* assembleFixture({
        ...base,
        target: { speaker: "oren" },
        historyStart: previous.historyStart!,
        messages: [
          ...base.messages,
          { side: "user", content: "hidden", inContext: false },
          ...Array.from({ length: count }, () => ({ side: "user" as const, content: "road ".repeat(30) }))
        ]
      })
      if (next.historyMove === "maximum") {
        assert.equal(
          prefixChange(previous, next, describe)!.reason,
          "The context reached its maximum; older messages left."
        )
        crossed = true
        break
      }
      assert.isNull(prefixChange(previous, next, describe))
      previous = next
    }
    assert.isTrue(crossed)
  })
)
