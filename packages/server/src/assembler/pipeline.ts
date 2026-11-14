import type { LoreReceipt, LoreTimingState } from "./loreTiming.ts"
// The assembler's stage pipeline and its sources (PLUGINS §8; ARCHITECTURE §15).
import type { SourceActivation } from "@rp/shared/inspectorApi.ts"
import type { FoldableEvent, ChatState, HtmlDepth } from "@rp/shared/state.ts"
import { presenceOf } from "@rp/shared/knowledge.ts"
import type { FrozenValues, MacroLookup } from "@rp/shared/macros/expand.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { NotFound } from "@rp/shared/errors.ts"
import { Context, Effect } from "effect"
import type { SqlError } from "effect/sql"
import { makeRegistry, type Registry } from "../registry.ts"
import type { MacroEnvironment } from "./macros.ts"
import type { ScriptRunner } from "./regex.ts"
import type { RewriteOptions, ScriptSource } from "./scriptSources.ts"
import type { Knowledge } from "./knowledge.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { ScriptRef } from "@rp/shared/regexScripts.ts"
import type { Composition, Stability, StMessage } from "./st.ts"
import type {
  AssembledRequest,
  CardInput,
  CardOverride,
  ContextSnapshot,
  GenerationType,
  HistoryStart,
  HistoryEntry,
  HistoryWindow,
  Issue,
  MergeRow,
  ModelInput,
  LorebookInput,
  NoteInput,
  NoteReplacement,
  Piece,
  PresetInput,
  RequestMessage,
  Source,
  SummaryLayer,
  Target,
  AgentAssembly,
  DecisionAssembly,
  LoreDecisionInput
} from "./types.ts"
import { replySectionsOf } from "@rp/shared/replySections.ts"
import { ASSEMBLER_VERSION, AssemblyFailed, historyLeafOf } from "./types.ts"
import type { LcmDefaults, ResolvedLcm } from "@rp/shared/lcmSettings.ts"
import type { CalibrationSample, ImageTokenRule } from "@rp/shared/imageTokens.ts"

export type SourceError = AssemblyFailed | NotFound | SqlError.SqlError

/** A state event and the depth of the message it's on; null for the chat's initial state. */
export interface PositionedEvent {
  readonly depth: number | null
  readonly event: FoldableEvent
}

interface Binding {
  readonly ref?: string | undefined
  readonly revision?: string | undefined
}

/** The settings scope chain's levels above the chat (DATA-MODEL §5.4), as refs to presets. */
export interface PresetChain {
  /** A summary request's specific preset; unavailable refs fall back to the account preset. */
  readonly summary?: string | undefined
  /** `preset.binding` scoped to the role, then the chat's own. */
  readonly role: Binding | null
  readonly chat: Binding | null
  /** The connection's one-way preset override (DESIGN §9). */
  readonly connection: string | null
}

/**
 * Where the pipeline's data comes from: the database in the reader worker
 * (`db/assemblySources.ts`), fixtures in tests and the ST harness. Everything is the acting
 * user's: another user's ids are NotFound.
 */
export class AssemblySources extends Context.Service<
  AssemblySources,
  {
    /**
     * The summary layer through `leaf`. With a separate context's identities, that view's layer
     * (spec/CHARACTER-CONTEXT.md §2.3): the shared summaries before its first missed message, then
     * its own. Only a source that sets `viewLayers` reads them; others give the shared layer.
     */
    readonly summaryLayer: (
      leaf: string | null,
      identities?: ReadonlyArray<string>
    ) => Effect.Effect<SummaryLayer, SourceError>
    /** The source reads each view's own summaries (`summaryLayer` with identities). */
    readonly viewLayers?: true
    readonly target: Effect.Effect<Target, SourceError>
    readonly historyRevision: (leaf: string | null, before: number) => Effect.Effect<number, SourceError>
    readonly historyStart: (leaf: string | null) => Effect.Effect<HistoryStart | null, SourceError>
    /** The events that apply at `slotId` (null: the chat's initial state), in fold order. */
    readonly events: (slotId: string | null) => Effect.Effect<ReadonlyArray<PositionedEvent>, SourceError>
    /** The window of at most `limit` messages ending at `leaf`. */
    readonly history: (leaf: string, limit: number, after?: string) => Effect.Effect<HistoryWindow, SourceError>
    /** Each card as a participant uses it: its binding, else this chat's override, else its upstream. */
    readonly cards: (
      entities: ReadonlyArray<string>,
      bindings: Readonly<Record<string, Binding>>
    ) => Effect.Effect<ReadonlyArray<CardInput>, SourceError>
    readonly loreState?: (
      leaf: string | null,
      identities: ReadonlyArray<string>,
      continuing?: string
    ) => Effect.Effect<LoreTimingState, SourceError>
    readonly messageCount: (leaf: string | null) => Effect.Effect<number, SourceError>
    readonly lorebooks: (refs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<LorebookInput>, SourceError>
    /** The account's global regex scripts (ST's "Global scripts"); fixtures without it have none. */
    readonly globalRegex?: Effect.Effect<ReadonlyArray<RegexScript>, SourceError>
    /** The notes these cards own, at the revision `bound` pins or their head. */
    readonly notes: (
      cards: ReadonlyArray<string>,
      bound: Readonly<Record<string, string>>
    ) => Effect.Effect<ReadonlyArray<NoteInput>, SourceError>
    /** A note's revisions from `revision` back along its first parents, newest first, at most `limit`. */
    readonly noteHistory: (
      entity: string,
      revision: string,
      limit: number
    ) => Effect.Effect<ReadonlyArray<{ readonly revision: string; readonly doc: NoteDoc }>, SourceError>
    /** Which of `slots` are on the path from the chat's first message to `leaf`. */
    readonly onPath: (
      leaf: string | null,
      slots: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlySet<string>, SourceError>
    /** The model `binding` names, else the user's default; null when there's neither. */
    readonly model: (
      binding: { readonly connection: string; readonly model: string } | null
    ) => Effect.Effect<ModelInput | null, SourceError>
    /** The preset the chain picks, else the user's default, else ST's default preset. */
    readonly preset: (chain: PresetChain) => Effect.Effect<PresetInput, SourceError>
    /** The account's summarization defaults (DESIGN §8), which a chat's settings fall back to; none: built-ins. */
    readonly lcmDefaults?: () => Effect.Effect<LcmDefaults | null, SourceError>
    /**
     * What the ledger and the counting endpoints know about these images for this model
     * (ARCHITECTURE §15, image tokens). Fixtures without it estimate by formula alone.
     */
    readonly imageTokenFacts?: (
      model: { readonly connectionId: string; readonly kind: string; readonly modelKey: string },
      sha256s: ReadonlyArray<string>
    ) => Effect.Effect<ImageTokenFacts, SourceError>
    /**
     * Who knew each of these versions (spec/CHARACTER-CONTEXT.md §9.1): card ids, or null for
     * everyone (nothing recorded). A merge's join is known to its source's cast. Fixtures
     * without it: everyone knew everything.
     */
    readonly stretches?: (
      leaf?: string | null,
      /** The character's identities: only the stretches that apply to it (db/threadStretches.ts). */
      viewers?: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<{ readonly chain: string; readonly lo: number; readonly hi: number }>, SourceError>
    readonly knowers?: (versionIds: ReadonlyArray<string>) => Effect.Effect<
      ReadonlyArray<{
        readonly versionId: string
        readonly knowers: ReadonlyArray<string> | null
        /** Those the fork read counts not present for it (spec/THREADS.md §5.2), its speaker apart. */
        readonly away?: ReadonlyArray<string>
        /** In a separate join's parallel stretch (spec/THREADS.md §7.3): what a stretch view filters. */
        readonly stretched?: boolean
      }>,
      SourceError
    >
    /**
     * The rows of these merges' joins, each merge's in order, for a separate context to lay out
     * per viewer (unit C6); summarized rows are left out. Fixtures without it: joins as written.
     */
    readonly mergeRows?: (
      mergeIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<{ readonly mergeId: string; readonly rows: ReadonlyArray<MergeRow> }>, SourceError>
    /** Whether `viewer` knew every message on the path to `leaf` up to position `through`. */
    readonly knewThrough?: (
      leaf: string,
      viewer: string,
      through: number,
      aliases?: ReadonlyArray<string>
    ) => Effect.Effect<boolean, SourceError>
  }
>()("rp/assembler/AssemblySources") {}

/** What a caller asks for, beyond what the sources say. */
export interface AssemblyRequest {
  readonly summaryJob?: ContextSnapshot["summaryJob"]
  /** Instruction parameters frozen for replay; earlier snapshots use their frozen job tail. */
  readonly summaryInstruction?: NonNullable<ContextSnapshot["summaryAssembly"]>["instruction"]
  /** Frozen sampler inputs when rebuilding. Applied before registered transforms. */
  readonly summarySamplers?: AssembledRequest["samplers"]
  readonly summarizing?: boolean
  readonly summaryClipTokens?: number
  readonly now: number
  readonly timeZone: string
  /** Values drawn by an earlier assembly of this context, per piece: rebuilds it identically. */
  readonly frozen: Readonly<Record<string, FrozenValues>>
  /** Where new random draws come from, in [0, 1). */
  readonly random: () => number
  readonly loreFallback?: ContextSnapshot["loreFallback"]
  /** An agent reply's assembly (spec/AGENTIC.md §6): frozen in the snapshot, so a rebuild matches. */
  readonly agent?: AgentAssembly
  /** What decision models decided (spec/AGENTIC.md §7): frozen in the snapshot, so a rebuild matches. */
  readonly decisions?: DecisionAssembly
  readonly macros: MacroLookup
  /** The role projections in effect, by id (`roles` stage). */
  readonly projections: ProjectionRegistry
  /** The merge layouts in effect (`merge-layout` stage); absent: the built-ins. */
  readonly mergeLayouts?: import("./merges.ts").MergeLayoutRegistry
  /** The context views in effect (`knowledge` stage); absent: the built-ins. */
  readonly contextViews?: import("./knowledge.ts").ContextViewRegistry
  /** The image token rules in effect (`image-tokens` stage); none: every image is unknown. */
  readonly imageTokens?: Registry<ImageTokenRule>
  readonly textCounters?: Registry<import("../providers/textCounters.ts").TextTokenCounter>
  /** The regex script lists in effect (`scripts` stage), in order; absent: the built-ins. */
  readonly scriptSources?: Registry<ScriptSource>
  /**
   * Not a context: text being written goes through the scripts (`RewriteText`). The `scripts`
   * stage then compiles the scripts with neither flag instead of the prompt-only ones.
   */
  readonly rewrite?: RewriteOptions
}

/** Exact counts by content hash and detail, and the model's calibration samples, newest first. */
export interface ImageTokenFacts {
  readonly counts: ReadonlyArray<{ readonly sha256: string; readonly detail: string; readonly tokens: number }>
  readonly samples: ReadonlyArray<CalibrationSample>
}

/** The cast of a chat at the position being generated. */
export interface Cast {
  /** Participants the user doesn't play, in join order. */
  readonly characters: ReadonlyArray<CardInput>
  /** The selected persona, zero or one; the array type is retained for stage compatibility. */
  readonly personas: ReadonlyArray<CardInput>
  readonly absent: ReadonlySet<string>
  /** Whose turn it is. Null only in a chat without characters. */
  readonly speaker: CardInput | null
  readonly type: GenerationType
}

/**
 * How the chat's history takes roles (DATA-MODEL §5.3: `roles.projection`). Card layout is the
 * preset's (DESIGN §5.0): `layout.cards` events are ignored.
 */
export interface Mode {
  /** A registered projection's id; the chat's choice, resolved by the `roles` stage. */
  readonly projection: string
  /** Lorebook entries only below the history (DESIGN §1.3): the chat's setting, on unless turned off. */
  readonly loreBelowHistory: boolean
  /** Card-swap (`cards.rotation`, DESIGN §5.2): only the speaker's card where the preset puts cards; off unless turned on. */
  readonly cardsRotation: boolean
  /** HTML in older messages sent to the model (`context.html_depth`); as written unless chosen. */
  readonly htmlDepth: HtmlDepth
}

/** A message's text after the regex scripts, at the depth they ran at. */
export interface Scripted {
  readonly text: string
  readonly volatile: boolean
  readonly depth: number
  /** The scripts that changed it, in the order they ran; absent: none. */
  readonly applied?: ReadonlyArray<ScriptRef>
}

/** Layouts can expand one stored version into several independently scripted pieces. */
export const projectedScriptKey = (entry: Pick<ProjectedEntry, "piece">) => `projected:${entry.piece}`
export const projectedScript = (scripted: ReadonlyMap<string, Scripted> | undefined, entry: ProjectedEntry) =>
  scripted?.get(projectedScriptKey(entry)) ?? scripted?.get(entry.entry.versionId)

/** A message of the path with its role and name in this context. */
export interface ProjectedEntry {
  readonly entry: HistoryEntry
  readonly role: "user" | "assistant"
  /** The speaker's in-chat name, and whether the user plays them. */
  readonly name: string
  readonly persona: boolean
  readonly piece: number
  /** Sent as a system message without a name: a merged chat's section and join (`merge-layout`). */
  readonly system?: true
}

/**
 * One assembly, filled in by the stages in turn. Each stage may read what earlier stages
 * wrote; `need` fails loudly when a stage runs before what it needs, which only a
 * misregistered plugin stage can cause.
 */
export interface Assembly {
  contextBudget?: ContextSnapshot["contextBudget"]
  /** The chat's context view and whose knowledge filters the history (`knowledge` stage). */
  knowledge?: Knowledge
  /**
   * The parallel stretches of the separate joins read so far (spec/THREADS.md §7.3), newest
   * first: from the destination message the span starts at (its position once read; null
   * until then) to the join. The history is read newest window first, so a join opens its
   * stretch before the messages in it are read.
   */
  parallelStretches?: Array<{ readonly start: string | null; from: number | null; readonly to: number }>
  lcm?: SummaryLayer
  lcmPieces?: ReadonlyArray<number>
  lcmFailurePieces?: ReadonlyArray<{ readonly from: number; readonly to: number; readonly piece: number }>
  lcmFailures?: ReadonlyArray<{ readonly from: number; readonly to: number }>
  lcmVerbatim?: { readonly from: number; readonly to: number } | null
  lcmOmitted?: ReadonlyArray<{ readonly from: number; readonly to: number }>
  lcmBudget?: { readonly target: number; readonly maximum: number }
  /** The chat's summarization settings as they resolve (DESIGN §8), read by the lcm stage. */
  lcmSettings?: ResolvedLcm
  summaryFill?: ContextSnapshot["summaryFill"]
  lcmRecent?: { readonly target: number; readonly maximum: number }
  lcmMeasure?: NonNullable<ContextSnapshot["lcm"]>["measure"]
  readonly request: AssemblyRequest
  target?: Target
  events?: ReadonlyArray<PositionedEvent>
  state?: ChatState
  cast?: Cast
  model?: ModelInput | null
  preset?: PresetInput
  loreFallback?: ContextSnapshot["loreFallback"]
  lorebooks?: ReadonlyArray<LorebookInput>
  loreScanDepth?: number
  loreState?: LoreTimingState
  loreTiming?: ReadonlyArray<LoreReceipt>
  loreMessageCount?: number
  /** The `lore` decision point's input, when an entry the keys left out has a question. */
  loreDecision?: LoreDecisionInput
  lore?: ReadonlyArray<{
    readonly entry: import("@rp/shared/docs/lorebook.ts").LorebookEntry
    readonly piece: number
    readonly book: string
    readonly revision: string
    /** Kept from the previous context's pins without matching this turn. */
    readonly pinnedOnly?: true
  }>
  /** What the history's cut state is valid for (preset, model, cards, notes, books, settings). */
  configuration?: string
  cardOverrides?: Array<CardOverride>
  /**
   * The notes on this turn that replace a prompt or card field, by target key (`replaceKey`), and
   * every such note with its outcome (the `replacements` stage; DESIGN §4.2).
   */
  replacements?: ReadonlyMap<string, { readonly note: NoteInput; readonly record: NoteReplacement }>
  noteReplacements?: Array<NoteReplacement>
  /** Absent when the `notes` stage is disabled: downstream stages read that as no notes (ARCHITECTURE §15). */
  notes?: ReadonlyArray<NoteInput>
  skippedNotes?: ReadonlyArray<NoteInput>
  /** Enabled preset prompts left out by their condition, and cards card-swap left out, this turn, for the request inspector. */
  skippedPrompts?: Array<Source>
  noteDecisions?: ReadonlyMap<string, Extract<SourceActivation, { kind: "note" }>>
  sendIfEmpty?: boolean
  mode?: Mode
  macros?: MacroEnvironment
  /** The preset's prompt regex scripts, with the time and output they have left. */
  scripts?: ScriptRunner
  /** The verbatim messages the history stage read, by version, as the scripts left them. */
  scripted?: ReadonlyMap<string, Scripted>
  /** The path, root first, as far back as the context could use (`history` stage). */
  history?: ReadonlyArray<HistoryEntry>
  /** Messages of the path not read, older than `history`. */
  historyOmitted?: number
  previousHistoryStart?: HistoryStart | null
  historyRevision?: number
  historyStart?: HistoryStart
  historyMove?: ContextSnapshot["historyMove"]
  /** The path's images the request leaves out and why (`images` stage); later stages may add their own. */
  imagesLeftOut?: {
    images: Array<import("@rp/shared/inspectorApi.ts").ImageLeftOut>
    ranges: Array<import("@rp/shared/inspectorApi.ts").ImagesLeftOut["ranges"][number]>
  }
  /** The messages of `history` that enter the context, with the pieces recording their text. */
  resolved?: ReadonlyArray<{ readonly entry: HistoryEntry; readonly piece: number }>
  /** Speakers of those messages who have left the cast, by entity: their messages keep their names. */
  departed?: ReadonlyMap<string, CardInput>
  projected?: ReadonlyArray<ProjectedEntry>
  /** Installed by the registered end stage; compose expands it after other text, before prefill. */
  renderEndOfRequest?: () => StMessage | undefined
  /** The end-of-request message (DESIGN §2.2), the request's last; absent: none this turn. */
  endOfRequest?: StMessage
  /** Local tokenizer prepared for this assembly, with a bounded fragment cache. */
  countText?: (text: string) => number
  composition?: Composition
  messages?: Array<RequestMessage & { readonly pieces: ReadonlyArray<number>; readonly kind: Stability }>
  /** The names ST folds into the text where a provider has no `name` field. */
  postNames?: AssembledRequest["names"]
  /** The prefill to send, when the model takes one. */
  prefill?: string
  /**
   * Continue on a model that takes no prefill (owner, 2026-10-31): the reply so far, sent as the
   * model's own message just before the end-of-request instruction, its piece, and what goes
   * between it and the new text (the preset's `continue_postfix`, ST's, when it doesn't end in a space).
   */
  continuation?: { readonly text: string; readonly piece: number; readonly join: string }
  breakpoints?: AssembledRequest["breakpoints"]
  result?: AssembledRequest
  readonly pieces: Array<Piece>
  readonly frozen: Record<string, FrozenValues>
  readonly effects: Array<VariableEffect>
  /** The variable writes of template messages expanded for the first time, by version. */
  readonly templateWrites: Array<{ readonly version: string; readonly writes: ReadonlyArray<VariableEffect> }>
  readonly issues: Array<Issue>
}

export const need = <K extends keyof Assembly>(assembly: Assembly, key: K): NonNullable<Assembly[K]> => {
  const value = assembly[key]
  if (value === undefined) throw new Error(`assembler: "${String(key)}" isn't set; a stage runs out of order`)
  return value as NonNullable<Assembly[K]>
}

export interface AssemblerStage {
  readonly id: string
  readonly run: (assembly: Assembly) => Effect.Effect<Assembly, SourceError, AssemblySources>
}

/** Final request shaping, inside assembly, after stages have produced source-indexed messages. */
export interface AssemblyTransform {
  readonly id: string
  readonly run: (
    snapshot: ContextSnapshot,
    request: AssemblyRequest
  ) => Effect.Effect<ContextSnapshot, SourceError, AssemblySources>
}

export type TransformRegistry = Registry<AssemblyTransform>
export type StageRegistry = Registry<AssemblerStage>

/**
 * How a message takes its role. The `roles` stage dispatches to the projection the chat names
 * (`roles.projection`, an open id); the built-ins are registered with the stages, and a plugin
 * registers others the same way. Naming a projection nothing registers falls back to
 * `by_writer` with a `role_projection_missing` issue.
 */
export interface RoleProjection {
  readonly id: string
  /** Shown where the chat's projection is chosen. */
  readonly label: string
  readonly description?: string
  readonly role: (message: {
    readonly entry: HistoryEntry
    readonly cast: Cast
    /** The message's card, if it has one. */
    readonly speaker: CardInput | undefined
    /** The side the message is on (its writer's, as ST takes it). */
    readonly side: "user" | "assistant"
  }) => "user" | "assistant"
}

export type ProjectionRegistry = Registry<RoleProjection>

export const makeProjectionRegistry = (): ProjectionRegistry => makeRegistry<RoleProjection>()

export const makeStageRegistry = (): StageRegistry => makeRegistry<AssemblerStage>()

/**
 * The stages in effect, in order, through the one named `last` (all of them when nothing has
 * that id): what a rewrite needs of a context, without composing one.
 */
export const assembleThrough = (stages: StageRegistry, request: AssemblyRequest, last: string) =>
  Effect.gen(function* () {
    let assembly: Assembly = { request, pieces: [], frozen: {}, effects: [], templateWrites: [], issues: [] }
    for (const stage of stages.list()) {
      assembly = yield* stage.run(assembly)
      if (stage.id === last) break
    }
    return assembly
  })

/** Runs every stage in effect, in order, and returns the context as built. */
export const assemble = (stages: StageRegistry, request: AssemblyRequest, transforms: TransformRegistry) =>
  Effect.gen(function* () {
    let assembly: Assembly = { request, pieces: [], frozen: {}, effects: [], templateWrites: [], issues: [] }
    for (const stage of stages.list()) assembly = yield* stage.run(assembly)
    const target = need(assembly, "target")
    const preset = need(assembly, "preset")
    const cast = need(assembly, "cast")
    const historyStart = need(assembly, "historyStart")
    const sources = yield* AssemblySources
    const revision = yield* sources.historyRevision(historyLeafOf(target), historyStart.depth)
    const cards = [...cast.characters, ...cast.personas].map(({ entity, ref, revision }) => ({ entity, ref, revision }))
    // Who of the cast was away or narrated, recorded with the version (spec/CHARACTER-CONTEXT.md §9.1).
    const presence = assembly.state
      ? presenceOf(
          assembly.state,
          cards.map((c) => c.entity)
        )
      : null
    let snapshot: ContextSnapshot = {
      schema: 1,
      ...(assembly.contextBudget ? { contextBudget: assembly.contextBudget } : {}),
      ...(assembly.summaryFill ? { summaryFill: assembly.summaryFill } : {}),
      historyStart: { ...historyStart, ...(historyStart.state ? { state: { ...historyStart.state, revision } } : {}) },
      historyMove: need(assembly, "historyMove"),
      ...(assembly.lcm ? { historyBudget: need(assembly, "composition").historyBudget } : {}),
      assemblerVersion: ASSEMBLER_VERSION,
      // How the reply's leading tagged sections are parsed (spec/REPLY-SECTIONS.md).
      ...(request.summaryJob ? {} : { replySections: replySectionsOf(preset.doc) }),
      ...(request.agent ? { agentAssembly: request.agent } : {}),
      // The books an agent's lookup_lore reads: those this context's lore came from (AGENTIC §4.5).
      ...(request.agent && assembly.lorebooks?.length
        ? { agentLore: assembly.lorebooks.map(({ id, entity, revision }) => ({ id, entity, revision })) }
        : {}),
      ...(request.decisions ? { decisionAssembly: request.decisions } : {}),
      ...(assembly.loreDecision ? { loreDecision: assembly.loreDecision } : {}),
      inputs: {
        chatId: target.chatId,
        slotId: target.slotId,
        versionId: target.versionId,
        leafSlotId: target.parentSlotId,
        now: request.now,
        timeZone: request.timeZone,
        type: cast.type,
        speaker: cast.speaker?.entity ?? null,
        mode: "layouts",
        preset: { ref: preset.ref, revision: preset.revision, scope: preset.scope },
        cards,
        ...(presence ? { presence } : {}),
        // Keep the character identity even when the request's history ends before a join.
        ...(assembly.knowledge?.viewer
          ? {
              viewer: assembly.knowledge.viewer,
              ...(assembly.knowledge.aliases ? { viewerAliases: assembly.knowledge.aliases } : {})
            }
          : assembly.knowledge?.stretch && !assembly.knowledge.stretch.stored
            ? { stretchViewers: assembly.knowledge.stretch.aliases ?? [assembly.knowledge.stretch.viewer] }
            : {}),
        model: assembly.model ?? null
      },
      ...(request.summaryJob
        ? {
            summaryJob: request.summaryJob,
            summaryAssembly: {
              job: request.summaryJob,
              ...(request.summaryInstruction ? { instruction: request.summaryInstruction } : {}),
              samplers: request.summarySamplers ?? need(assembly, "result").samplers
            }
          }
        : {}),
      request: request.summarySamplers
        ? { ...need(assembly, "result"), samplers: request.summarySamplers }
        : need(assembly, "result"),
      pieces: assembly.pieces,
      issues: assembly.issues,
      frozen: assembly.frozen,
      effects: assembly.effects,
      ...(assembly.loreTiming ? { loreTiming: assembly.loreTiming } : {}),
      ...(assembly.loreFallback ? { loreFallback: assembly.loreFallback } : {}),
      ...(assembly.cardOverrides?.length ? { cardOverrides: assembly.cardOverrides } : {}),
      ...(assembly.noteReplacements?.length ? { noteReplacements: assembly.noteReplacements } : {}),
      ...(assembly.skippedPrompts?.length ? { skippedPrompts: assembly.skippedPrompts } : {}),
      ...(assembly.imagesLeftOut ? { imagesLeftOut: assembly.imagesLeftOut } : {}),
      templateWrites: assembly.templateWrites,
      ...(assembly.lcm
        ? {
            lcm: {
              cursor: assembly.lcm.cursor,
              selected: assembly.lcm.summaries.map((s) => ({
                id: s.id,
                revision: s.revisionId,
                stale: !s.fresh,
                from: s.from,
                to: s.to,
                level: s.level
              })),
              failures: assembly.lcmFailures ?? [],
              omitted: assembly.lcmOmitted ?? [],
              ...(assembly.lcmBudget ? { layerBudget: assembly.lcmBudget } : {}),
              ...(assembly.lcmRecent ? { recentBudget: assembly.lcmRecent } : {}),
              ...(assembly.lcmMeasure ? { measure: assembly.lcmMeasure } : {}),
              verbatim: assembly.lcmVerbatim ?? null
            }
          }
        : {})
    }
    for (const transform of transforms.list()) snapshot = yield* transform.run(snapshot, request)
    return snapshot
  })
