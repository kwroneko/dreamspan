// The assembler's sources over an in-memory chat, for tests and the ST harness: the same
// pipeline the reader worker runs, without a database.
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { PresetDoc } from "@rp/shared/docs/preset.ts"
import type { FoldableEvent } from "@rp/shared/state.ts"
import { Effect, Layer, Scope } from "effect"
import { type Assembler, makeAssembler } from "../../src/assembler/assembler.ts"
import { AssemblySources, type PositionedEvent } from "../../src/assembler/pipeline.ts"
import type { ContextSnapshot, HistoryEntry, ModelInput, NoteInput } from "../../src/assembler/types.ts"

export interface FixtureMessage {
  readonly side: "user" | "assistant"
  readonly content: string
  readonly speaker?: string
  readonly macroMode?: "template" | "verbatim"
  readonly inContext?: boolean
  readonly frozen?: Readonly<Record<string, string>>
}

export interface AssemblyFixture {
  readonly chatId?: string
  /** The path, root first; the message being generated comes after it. */
  readonly messages: ReadonlyArray<FixtureMessage>
  readonly target?: { readonly speaker?: string; readonly direction?: string; readonly ordinal?: number }
  readonly cards: ReadonlyArray<{ readonly entity: string; readonly doc: CardDoc }>
  /** Joined at the start, in order; the persona is played by the user. */
  readonly participants: ReadonlyArray<string>
  readonly persona?: string
  /** More events, by the depth of the message they follow (null: the chat's start). */
  readonly events?: ReadonlyArray<PositionedEvent>
  readonly notes?: ReadonlyArray<NoteInput>
  readonly preset: PresetDoc
  readonly model?: ModelInput | null
  readonly now?: number
}

const event = (data: FoldableEvent["data"]): PositionedEvent => ({ depth: null, event: { scope: null, data } })

const fixtureSources = (fixture: AssemblyFixture) => {
  const slot = (i: number) => `slot-${i}`
  const entries: ReadonlyArray<HistoryEntry> = fixture.messages.map((m, i) => ({
    slotId: slot(i),
    versionId: `version-${i}`,
    depth: i,
    speaker: m.speaker ?? null,
    side: m.side,
    content: m.content,
    macroMode: m.macroMode ?? "verbatim",
    frozen: m.frozen ?? null,
    inContext: m.inContext ?? m.content.length > 0,
    sentAt: 0,
    versions: 1,
    selectedOrdinal: 0
  }))
  const events: ReadonlyArray<PositionedEvent> = [
    ...fixture.participants.map((entity) => event({ key: "participant.join", value: { entity } as never })),
    ...(fixture.persona ? [event({ key: "played_by_me.set", value: { entities: [fixture.persona] } as never })] : []),
    ...(fixture.events ?? [])
  ]
  const n = fixture.messages.length
  return Layer.succeed(AssemblySources)({
    target: Effect.succeed({
      chatId: fixture.chatId ?? "chat-1",
      chatKind: "rp",
      slotId: slot(n),
      versionId: `version-${n}`,
      depth: n,
      parentSlotId: n === 0 ? null : slot(n - 1),
      ordinal: fixture.target?.ordinal ?? 0,
      speaker: fixture.target?.speaker ?? null,
      direction: fixture.target?.direction ?? null
    }),
    events: () => Effect.succeed(events),
    history: (leaf, limit) =>
      Effect.sync(() => {
        const end = entries.findIndex((e) => e.slotId === leaf)
        const start = Math.max(0, end - limit + 1)
        return { entries: entries.slice(start, end + 1), older: start === 0 ? null : slot(start - 1) }
      }),
    cards: (wanted) =>
      Effect.succeed(
        fixture.cards
          .filter((c) => wanted.includes(c.entity))
          .map((c) => ({ entity: c.entity, ref: `ref-${c.entity}`, revision: `rev-${c.entity}`, doc: c.doc }))
      ),
    notes: (cards) => Effect.succeed((fixture.notes ?? []).filter((note) => cards.includes(note.doc.owner.card))),
    model: () => Effect.succeed(fixture.model ?? null),
    preset: () => Effect.succeed({ ref: "ref-preset", revision: "rev-preset", scope: "chat", doc: fixture.preset })
  })
}

let shared: Assembler | undefined

/** One assembler for the process: its registrations are never undone. */
const assembler = () =>
  (shared ??= Effect.runSync(Effect.flatMap(Scope.make(), (scope) => Scope.provide(scope)(makeAssembler))))

/** The context the pipeline builds for a fixture, with a fixed clock and random draws. */
export const assembleFixture = (
  fixture: AssemblyFixture,
  options: { readonly frozen?: ContextSnapshot["frozen"]; readonly random?: () => number } = {}
) =>
  assembler()
    .assemble({
      now: fixture.now ?? Date.UTC(2026, 0, 1),
      timeZone: "UTC",
      frozen: options.frozen ?? {},
      random: options.random ?? (() => 0.5)
    })
    .pipe(Effect.provide(fixtureSources(fixture)))
