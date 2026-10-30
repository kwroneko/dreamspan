// The assembler's stage pipeline and its sources (PLUGINS §8; ARCHITECTURE §15).
import type { SourceActivation } from "@rp/shared/inspectorApi.ts"
import type { FoldableEvent, ChatState } from "@rp/shared/state.ts"
import type { FrozenValues, MacroLookup } from "@rp/shared/macros/expand.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { NotFound } from "@rp/shared/errors.ts"
import { Context, Effect } from "effect"
import type { SqlError } from "effect/sql"
import { makeRegistry, type Registry } from "../registry.ts"
import type { MacroEnvironment } from "./macros.ts"
import type { ScriptRunner } from "./regex.ts"
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
  ModelInput,
  LorebookInput,
  NoteInput,
  Piece,
  PresetInput,
  RequestMessage,
  Source,
  SummaryLayer,
  Target
} from "./types.ts"
import { ASSEMBLER_VERSION, AssemblyFailed } from "./types.ts"
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
    readonly summaryLayer: (leaf: string | null) => Effect.Effect<SummaryLayer, SourceError>
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
    readonly messageCount: (leaf: string | null) => Effect.Effect<number, SourceError>
    readonly lorebooks: (refs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<LorebookInput>, SourceError>
    /** The refs of the lorebooks the user marked global (DESIGN §5.0), in the order they were marked. */
    readonly globalLorebooks: Effect.Effect<ReadonlyArray<string>, SourceError>
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
  readonly macros: MacroLookup
  /** The role projections in effect, by id (`roles` stage). */
  readonly projections: ProjectionRegistry
  /** The image token rules in effect (`image-tokens` stage); none: every image is unknown. */
  readonly imageTokens?: Registry<ImageTokenRule>
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
}

/** A message's text after the regex scripts, at the depth they ran at. */
export interface Scripted {
  readonly text: string
  readonly volatile: boolean
  readonly depth: number
}

/** A message of the path with its role and name in this context. */
export interface ProjectedEntry {
  readonly entry: HistoryEntry
  readonly role: "user" | "assistant"
  /** The speaker's in-chat name, and whether the user plays them. */
  readonly name: string
  readonly persona: boolean
  readonly piece: number
}

/**
 * One assembly, filled in by the stages in turn. Each stage may read what earlier stages
 * wrote; `need` fails loudly when a stage runs before what it needs, which only a
 * misregistered plugin stage can cause.
 */
export interface Assembly {
  contextBudget?: ContextSnapshot["contextBudget"]
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
  loreMessageCount?: number
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
  /** Absent when the `notes` stage is disabled: downstream stages read that as no notes (ARCHITECTURE §15). */
  notes?: ReadonlyArray<NoteInput>
  skippedNotes?: ReadonlyArray<NoteInput>
  /** Enabled preset prompts left out by their condition this turn, for the request inspector. */
  skippedPrompts?: Array<Source>
  /**
   * The chat's author's note while it's switched off: what rides on it still goes where it
   * sits, without its own text (owner question 6 of DESIGN §4.1's notes).
   */
  offAuthorNote?: NoteInput
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
  /** The messages of `history` that enter the context, with the pieces recording their text. */
  resolved?: ReadonlyArray<{ readonly entry: HistoryEntry; readonly piece: number }>
  /** Speakers of those messages who have left the cast, by entity: their messages keep their names. */
  departed?: ReadonlyMap<string, CardInput>
  projected?: ReadonlyArray<ProjectedEntry>
  /** Installed by the registered end stage; compose expands it after other text, before prefill. */
  renderEndOfRequest?: () => StMessage | undefined
  /** The end-of-request message (DESIGN §2.2), the request's last; absent: none this turn. */
  endOfRequest?: StMessage
  composition?: Composition
  messages?: Array<RequestMessage & { readonly pieces: ReadonlyArray<number>; readonly kind: Stability }>
  /** The names ST folds into the text where a provider has no `name` field. */
  postNames?: AssembledRequest["names"]
  /** The prefill to send, when the model takes one. */
  prefill?: string
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
    const revision = yield* sources.historyRevision(target.parentSlotId, historyStart.depth)
    let snapshot: ContextSnapshot = {
      schema: 1,
      ...(assembly.contextBudget ? { contextBudget: assembly.contextBudget } : {}),
      ...(assembly.summaryFill ? { summaryFill: assembly.summaryFill } : {}),
      historyStart: { ...historyStart, ...(historyStart.state ? { state: { ...historyStart.state, revision } } : {}) },
      historyMove: need(assembly, "historyMove"),
      ...(assembly.lcm ? { historyBudget: need(assembly, "composition").historyBudget } : {}),
      assemblerVersion: ASSEMBLER_VERSION,
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
        cards: [...cast.characters, ...cast.personas].map(({ entity, ref, revision }) => ({ entity, ref, revision })),
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
      ...(assembly.loreFallback ? { loreFallback: assembly.loreFallback } : {}),
      ...(assembly.cardOverrides?.length ? { cardOverrides: assembly.cardOverrides } : {}),
      ...(assembly.skippedPrompts?.length ? { skippedPrompts: assembly.skippedPrompts } : {}),
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
