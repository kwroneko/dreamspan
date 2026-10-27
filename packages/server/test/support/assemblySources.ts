// The assembler's sources over an in-memory chat, for tests and the ST harness: the same
// pipeline the reader worker runs, without a database.
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import type { FoldableEvent } from "@rp/shared/state.ts"
import { Effect, Layer, Scope } from "effect"
import { type Assembler, makeAssembler } from "../../src/assembler/assembler.ts"
import { AssemblySources, type PositionedEvent } from "../../src/assembler/pipeline.ts"
import {
  type ContextSnapshot,
  type HistoryEntry,
  type ModelInput,
  type LorebookInput,
  type NoteInput,
  noteCard
} from "../../src/assembler/types.ts"

export interface FixtureMessage {
  readonly side: "user" | "assistant"
  readonly content: string
  readonly speaker?: string
  readonly macroMode?: "template" | "verbatim"
  readonly inContext?: boolean
  readonly frozen?: Readonly<Record<string, string>>
  /** A template whose variable writes are recorded already. */
  readonly written?: boolean
}

export interface AssemblyFixture {
  readonly historyStart?: ContextSnapshot["historyStart"] | null
  readonly chatId?: string
  /** The path, root first; the message being generated comes after it. */
  readonly summaries?: ReadonlyArray<import("@rp/shared/lcm.ts").Summary>
  readonly messages: ReadonlyArray<FixtureMessage>
  readonly target?: { readonly speaker?: string; readonly direction?: string; readonly ordinal?: number }
  readonly cards: ReadonlyArray<{ readonly entity: string; readonly doc: CardDoc }>
  /** Joined at the start, in order; the persona is played by the user. */
  readonly participants: ReadonlyArray<string>
  readonly persona?: string
  /** More events, by the depth of the message they follow (null: the chat's start). */
  readonly events?: ReadonlyArray<PositionedEvent>
  readonly lorebooks?: ReadonlyArray<LorebookInput>
  /** The ids of `lorebooks` the user marked global. */
  readonly globalLorebooks?: ReadonlyArray<string>
  readonly notes?: ReadonlyArray<NoteInput>
  /** A note's earlier revisions, newest first, by note: its history before the revision it's at. */
  readonly noteRevisions?: Readonly<Record<string, ReadonlyArray<{ readonly revision: string; readonly doc: NoteDoc }>>>
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
    written: m.written ?? false,
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
      slotId: slot(n),
      versionId: `version-${n}`,
      depth: n,
      parentSlotId: n === 0 ? null : slot(n - 1),
      ordinal: fixture.target?.ordinal ?? 0,
      speaker: fixture.target?.speaker ?? null,
      direction: fixture.target?.direction ?? null
    }),
    historyStart: () => Effect.succeed(fixture.historyStart ?? null),
    historyRevision: (_leaf, before) =>
      Effect.succeed(entries.slice(0, before).reduce((n, e) => n - (e.inContext ? e.content.length : 0), 0)),
    events: () => Effect.succeed(events),
    summaryLayer: () =>
      Effect.succeed({
        summaries: fixture.summaries ?? [],
        cursor: fixture.summaries?.at(-1)?.lastSlotId ?? null,
        cursorDepth: fixture.summaries?.at(-1) ? fixture.summaries.at(-1)!.to - 1 : -1
      }),
    history: (leaf, limit, after) =>
      Effect.sync(() => {
        const end = entries.findIndex((e) => e.slotId === leaf)
        const boundary = after === undefined ? 0 : entries.findIndex((e) => e.slotId === after) + 1
        const start = Math.max(boundary, end - limit + 1)
        return { entries: entries.slice(start, end + 1), older: start === boundary ? null : slot(start - 1) }
      }),
    cards: (wanted) =>
      Effect.succeed(
        fixture.cards
          .filter((c) => wanted.includes(c.entity))
          .map((c) => ({ entity: c.entity, ref: `ref-${c.entity}`, revision: `rev-${c.entity}`, doc: c.doc }))
      ),
    globalLorebooks: Effect.succeed(fixture.globalLorebooks ?? []),
    lorebooks: (refs) => Effect.succeed((fixture.lorebooks ?? []).filter((b) => refs.includes(b.id))),
    notes: (cards) =>
      Effect.succeed(
        (fixture.notes ?? []).filter((note) => {
          const card = noteCard(note.doc)
          return card === null || cards.includes(card)
        })
      ),
    noteHistory: (entity, revision, limit) =>
      Effect.sync(() => {
        const note = (fixture.notes ?? []).find((n) => n.entity === entity)
        const chain = [
          ...(note ? [{ revision: note.revision, doc: note.doc }] : []),
          ...(fixture.noteRevisions?.[entity] ?? [])
        ]
        const from = chain.findIndex((r) => r.revision === revision)
        return from === -1 ? [] : chain.slice(from, from + limit)
      }),
    // The path is slot-0 to the leaf; any other id is off it.
    onPath: (leaf, slots) =>
      Effect.sync(() => {
        const at = (slot: string) => entries.findIndex((e) => e.slotId === slot)
        const end = leaf === null ? -1 : at(leaf)
        return new Set(slots.filter((slot) => at(slot) !== -1 && at(slot) <= end))
      }),
    messageCount: (leaf) =>
      Effect.succeed(
        entries.slice(0, leaf === null ? 0 : entries.findIndex((e) => e.slotId === leaf) + 1).filter((e) => e.inContext)
          .length
      ),
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
  options: {
    readonly frozen?: ContextSnapshot["frozen"]
    readonly random?: () => number
    readonly loreFallback?: ContextSnapshot["loreFallback"]
    /** A summary's request: written as no one, with no direction. */
    readonly summarizing?: boolean
  } = {}
) =>
  assembler()
    .assemble({
      now: fixture.now ?? Date.UTC(2026, 0, 1),
      timeZone: "UTC",
      frozen: options.frozen ?? {},
      ...(options.loreFallback ? { loreFallback: options.loreFallback } : {}),
      ...(options.summarizing ? { summarizing: true } : {}),
      random: options.random ?? (() => 0.5)
    })
    .pipe(Effect.provide(fixtureSources(fixture)))
