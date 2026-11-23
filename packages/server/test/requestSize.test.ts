// The next request's size by part (db/requestView.ts), as the next-reply strip's context chip
// shows it: the parts come from the assembler's own sources, summaries and a plugin's included,
// and they add up to the request view's total.
import { assert, it } from "@effect/vitest"
import type { ContextMessage, ContextSource } from "@dreamspan/shared/inspectorApi.ts"
import type { Piece, Source } from "../src/assembler/types.ts"
import { sourceId } from "../src/db/inspectorReads.ts"
import { requestSize } from "../src/db/requestView.ts"

const sources: ReadonlyArray<Source> = [
  { kind: "preset", ref: null, revision: null, identifier: "main" },
  { kind: "card", entity: "aria", revision: "aria-1", field: "description" },
  { kind: "card", entity: "aria", revision: "aria-1", field: "mes_example" },
  { kind: "card", entity: "you", revision: "you-1", field: "description", persona: true },
  {
    kind: "lorebook",
    book: "atlas",
    revision: "atlas-1",
    uid: 3,
    activation: { status: "skipped", step: 0, reason: "x" }
  },
  { kind: "note", entity: "note", revision: "note-1" },
  {
    kind: "summary",
    id: "summary",
    revision: "summary-1",
    revisionNumber: 1,
    level: 1,
    from: 1,
    to: 40,
    stale: false
  },
  { kind: "message", slot: "slot-41", version: "version-41" },
  { kind: "message", slot: "slot-42", version: "version-42" },
  { kind: "direction", version: "next" },
  { kind: "synthetic-plugin/scene_state", data: { scene: "harbor" } }
]
const pieces: Array<Piece> = sources.map((source, i) => ({ id: `piece-${i}`, source, text: "x", messages: [0] }))
const described = (source: Source): ContextSource => ({
  kind: source.kind,
  id: sourceId(source),
  label: source.kind,
  activation: null,
  slotId: source.kind === "message" ? (source.slot as ContextSource["slotId"]) : null
})

// One message holding every source's text, 100 characters each, with 10 characters of joins
// between them; then a second, plain history message.
const content = sources.map(() => "a".repeat(100)).join("b".repeat(10))
const parts = sources.map((_, i) => ({ start: i * 110, end: i * 110 + 100, source: i }))
const message = (over: Partial<ContextMessage>): ContextMessage => ({
  role: "system",
  name: null,
  content,
  tokens: 0,
  sources: sources.map(described),
  parts,
  breakpoint: null,
  ...over
})

it("names a part for each of the assembler's sources, and the parts add up to the total", () => {
  const messages = [
    message({ tokens: 3 + 11 * 25 + 25 }),
    message({ role: "user", content: "c".repeat(40), tokens: 13, sources: [described(sources[8]!)], parts: [] })
  ]
  const size = requestSize({ pieces }, { messages }, 120)
  assert.strictEqual(size.tokens, messages[0]!.tokens + 13)
  assert.strictEqual(
    size.parts.reduce((n, p) => n + p.tokens, 0),
    size.tokens
  )
  const ids = size.parts.map((p) => p.id).sort()
  assert.deepStrictEqual(ids, [
    "cards",
    "examples",
    "formatting",
    "guidance",
    "history",
    "lorebook",
    "notes",
    "persona",
    "preset",
    "summaries",
    "synthetic-plugin/scene_state"
  ])
  const label = (id: string) => size.parts.find((p) => p.id === id)?.label
  assert.strictEqual(label("summaries"), "Summaries")
  assert.strictEqual(label("synthetic-plugin/scene_state"), "Scene state")
  // A message with an empty parts list is the formatting's, past its own framing.
  assert.strictEqual(size.messages.sent, 2)
  assert.strictEqual(size.messages.total, 120)
})

it("counts images as their own part, and a message without recorded parts as its first source's", () => {
  const image = { tokens: 85, basis: "formula" as const, budgeted: 85, sent: true }
  const size = requestSize(
    { pieces },
    {
      messages: [
        {
          role: "user",
          name: null,
          content: "d".repeat(400),
          tokens: 103 + 85,
          images: [image],
          sources: [described(sources[7]!)],
          breakpoint: null
        }
      ]
    },
    1
  )
  assert.deepStrictEqual(
    size.parts.map((p) => [p.id, p.tokens]),
    [
      ["history", 100],
      ["images", 85],
      ["formatting", 3]
    ]
  )
})
