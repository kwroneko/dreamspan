// The assembler's sources over an in-memory chat, for tests and the ST harness: the same
// pipeline the reader worker runs, without a database.
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { RegexScript } from "@dreamspan/shared/docs/regexScript.ts"
import type { ReplySections } from "@dreamspan/shared/replySections.ts"
import type { RewriteOptions } from "../../src/assembler/scriptSources.ts"
import type { NoteDoc } from "@dreamspan/shared/docs/note.ts"
import type { LegacyPresetDoc as PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import type { FoldableEvent } from "@dreamspan/shared/state.ts"
import type { ModelSettings } from "@dreamspan/shared/modelSettings.ts"
import { Effect, Layer, Scope } from "effect"
import { type Assembler, makeAssembler } from "../../src/assembler/assembler.ts"
import { AssemblySources, type PositionedEvent } from "../../src/assembler/pipeline.ts"
import {
  type AgentAssembly,
  type ContextSnapshot,
  type HistoryEntry,
  type ModelInput,
  type LorebookInput,
  type NoteInput,
  noteCard
} from "../../src/assembler/types.ts"

export interface FixtureMessage {
  /** Synthetic version knowledge, null or absent when everyone knows it. */
  readonly knowers?: ReadonlyArray<string> | null
  readonly side: "user" | "assistant"
  readonly content: string
  readonly speaker?: string
  readonly macroMode?: "template" | "verbatim"
  readonly images?: HistoryEntry["images"]
  readonly inContext?: boolean
  readonly frozen?: Readonly<Record<string, string>>
  /** A reply's leading tagged sections in their tags (spec/REPLY-SECTIONS.md). */
  readonly replySections?: ReplySections
  /** A template whose variable writes are recorded already. */
  readonly written?: boolean
  /** A merge's join message (spec/CHAT-MERGE.md): its merge, as the history read carries it. */
  readonly merge?: HistoryEntry["merge"]
}

export interface AssemblyFixture {
  /** The reader's resolved separate-join ranges, on the fixture's single chain. */
  readonly stretches?: NonNullable<ContextSnapshot["sources"]>["stretches"]
  readonly historyStart?: ContextSnapshot["historyStart"] | null
  readonly chatId?: string
  /** The path, root first; the message being generated comes after it. */
  readonly summaries?: ReadonlyArray<import("@dreamspan/shared/lcm.ts").Summary>
  readonly messages: ReadonlyArray<FixtureMessage>
  readonly target?: {
    readonly speaker?: string
    readonly direction?: string
    readonly ordinal?: number
    /** Continue: the version and the text it continues. */
    readonly continues?: { readonly version: string; readonly text: string }
  }
  readonly cards: ReadonlyArray<{ readonly entity: string; readonly doc: CardDoc }>
  /** Joined at the start, in order; the persona is played by the user. */
  readonly participants: ReadonlyArray<string>
  readonly persona?: string
  /** More events, by the depth of the message they follow (null: the chat's start). */
  readonly events?: ReadonlyArray<PositionedEvent>
  readonly lorebooks?: ReadonlyArray<LorebookInput>
  /** The account's global regex scripts. */
  readonly globalRegex?: ReadonlyArray<RegexScript>
  readonly notes?: ReadonlyArray<NoteInput>
  /** A note's earlier revisions, newest first, by note: its history before the revision it's at. */
  readonly noteRevisions?: Readonly<Record<string, ReadonlyArray<{ readonly revision: string; readonly doc: NoteDoc }>>>
  readonly preset: PresetDoc
  readonly model?: ModelInput | null
  /** Each binding the model stage asked for, in order (the fixture's `model` answers them all). */
  readonly modelAsked?: Array<{ readonly connection: string; readonly model: string } | null>
  /** The account's summary defaults; absent: the source isn't offered. */
  readonly lcmDefaults?: import("@dreamspan/shared/lcmSettings.ts").LcmDefaults | null
  readonly now?: number
}

const event = (data: FoldableEvent["data"]): PositionedEvent => ({ depth: null, event: { scope: null, data } })

/**
 * The model's settings a fixture's legacy (ST-shaped) preset doc spells out: its samplers, context
 * and reply length, history target and wire formatting. The assembler never reads these from a
 * preset; the fixture moves them onto its model, so a test sizes the budget through the model.
 */
const modelSettingsOf = (doc: PresetDoc): ModelSettings => ({
  samplers: doc.samplers,
  names_behavior: doc.names_behavior,
  squash: doc.squash,
  postprocess: doc.postprocess,
  use_sysprompt: doc.use_sysprompt,
  ...(doc.context_target === undefined ? {} : { context_target: doc.context_target })
})

/** The model a fixture that names none generates with: a plain chat-completions model, window unknown. */
const FIXTURE_MODEL: ModelInput = {
  connectionId: "fixture-connection",
  modelId: "fixture-model",
  kind: "openai-chat",
  api: "openai-completions",
  key: "fixture-model",
  prefill: "none",
  cacheBreakpoints: "auto",
  context: null,
  presetOverride: null
}

/**
 * A fixture model without settings of its own takes the ones its preset doc spells out; a fixture
 * naming no model gets `FIXTURE_MODEL` so, and `model: null` means no model at all.
 */
const fixtureModel = (fixture: AssemblyFixture): ModelInput | null => {
  const model = fixture.model === undefined ? FIXTURE_MODEL : fixture.model
  if (model === null || model.settings) return model
  return { ...model, settings: modelSettingsOf(fixture.preset) }
}

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
    inContext: m.inContext ?? (m.content.length > 0 || (m.images?.length ?? 0) > 0),
    ...(m.images === undefined ? {} : { images: m.images }),
    ...(m.replySections === undefined ? {} : { replySections: m.replySections }),
    ...(m.merge === undefined ? {} : { merge: m.merge }),
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
    ...(fixture.stretches ? { stretches: () => Effect.succeed(fixture.stretches!) } : {}),
    target: Effect.succeed({
      chatId: fixture.chatId ?? "chat-1",
      slotId: slot(n),
      versionId: `version-${n}`,
      depth: n,
      parentSlotId: n === 0 ? null : slot(n - 1),
      ordinal: fixture.target?.ordinal ?? 0,
      speaker: fixture.target?.speaker ?? null,
      direction: fixture.target?.direction ?? null,
      ...(fixture.target?.continues ? { continues: fixture.target.continues } : {})
    }),
    knowers: (ids) =>
      Effect.succeed(
        ids.map((versionId) => ({
          versionId,
          knowers: fixture.messages[Number(versionId.replace("version-", ""))]?.knowers ?? null,
          ...(fixture.stretches?.some((g) => {
            const depth = Number(versionId.replace("version-", ""))
            return depth >= g.lo && depth <= g.hi
          })
            ? { stretched: true }
            : {})
        }))
      ),
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
    globalRegex: Effect.succeed(fixture.globalRegex ?? []),
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
    model: (binding) =>
      Effect.sync(() => {
        fixture.modelAsked?.push(binding)
        return fixtureModel(fixture)
      }),
    ...(fixture.lcmDefaults !== undefined ? { lcmDefaults: () => Effect.succeed(fixture.lcmDefaults ?? null) } : {}),
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
    readonly summaryJob?: ContextSnapshot["summaryJob"]
    /** An assembler of the test's own, to register plugin parts in a scope of its own. */
    readonly assembler?: Assembler
    /** An agent reply mode's changes (card-swap's tail card, its instructions). */
    readonly agent?: AgentAssembly
  } = {}
) =>
  (options.assembler ?? assembler())
    .assemble({
      now: fixture.now ?? Date.UTC(2026, 0, 1),
      timeZone: "UTC",
      frozen: options.frozen ?? {},
      ...(options.loreFallback ? { loreFallback: options.loreFallback } : {}),
      ...(options.summarizing ? { summarizing: true } : {}),
      ...(options.summaryJob ? { summaryJob: options.summaryJob } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      random: options.random ?? (() => 0.5)
    })
    .pipe(Effect.provide(fixtureSources(fixture)))

/** A fixture's text as it's written at its target (`RewriteText`), through the scripts with neither flag. */
/** A rewrite prepared once for a fixture, as a streaming reply's is (`RewriteLive`). */
export const prepareFixture = (fixture: AssemblyFixture, options: RewriteOptions, using?: Assembler) =>
  (using ?? assembler())
    .prepareRewrite(
      { now: fixture.now ?? Date.UTC(2026, 0, 1), timeZone: "UTC", frozen: {}, random: () => 0.5 },
      options
    )
    .pipe(Effect.provide(fixtureSources(fixture)))

export const rewriteFixture = (
  fixture: AssemblyFixture,
  options: RewriteOptions,
  items: ReadonlyArray<{ readonly text: string; readonly kind: "message" | "reasoning" }>,
  using?: Assembler
) =>
  (using ?? assembler())
    .rewrite(
      { now: fixture.now ?? Date.UTC(2026, 0, 1), timeZone: "UTC", frozen: {}, random: () => 0.5 },
      options,
      items
    )
    .pipe(Effect.provide(fixtureSources(fixture)))
