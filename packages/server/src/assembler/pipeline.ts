// The context assembler's pipeline (DESIGN §5.1, PLUGINS §8): stages registered by id and
// run in registration order over one assembly. A plugin overrides a stage by registering
// the same id, wraps one by `get`ting it first, or disables one. The built-in stages are
// registered the same way (stages.ts). Stages read the database only through
// `AssemblySources`, so an assembly can be built again from the database alone (DATA-MODEL
// §15, invariant 6), and the ST harness runs the same pipeline over fixtures.
import type { FoldableEvent, ChatState } from "@rp/shared/state.ts"
import type { FrozenValues, MacroLookup } from "@rp/shared/macros/expand.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import type { NotFound } from "@rp/shared/errors.ts"
import { Context, Effect } from "effect"
import type { SqlError } from "effect/sql"
import { makeRegistry, type Registry } from "../registry.ts"
import type { MacroEnvironment } from "./macros.ts"
import type { Composition, Stability } from "./st.ts"
import type {
  AssembledRequest,
  CardInput,
  ContextSnapshot,
  GenerationType,
  HistoryEntry,
  HistoryWindow,
  Issue,
  ModelInput,
  NoteInput,
  Piece,
  PresetInput,
  RequestMessage,
  Target
} from "./types.ts"
import { AssemblyFailed } from "./types.ts"

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
    readonly target: Effect.Effect<Target, SourceError>
    /** The events that apply at `slotId` (null: the chat's initial state), in fold order. */
    readonly events: (slotId: string | null) => Effect.Effect<ReadonlyArray<PositionedEvent>, SourceError>
    /** The window of at most `limit` messages ending at `leaf`. */
    readonly history: (leaf: string, limit: number) => Effect.Effect<HistoryWindow, SourceError>
    /** Each card as a participant uses it: its binding, else this chat's override, else its upstream. */
    readonly cards: (
      entities: ReadonlyArray<string>,
      bindings: Readonly<Record<string, Binding>>
    ) => Effect.Effect<ReadonlyArray<CardInput>, SourceError>
    /** The notes these cards own, at the revision `bound` pins or their head. */
    readonly notes: (
      cards: ReadonlyArray<string>,
      bound: Readonly<Record<string, string>>
    ) => Effect.Effect<ReadonlyArray<NoteInput>, SourceError>
    /** The model `binding` names, else the user's default; null when there's neither. */
    readonly model: (
      binding: { readonly connection: string; readonly model: string } | null
    ) => Effect.Effect<ModelInput | null, SourceError>
    /** The preset the chain picks, else the user's default, else ST's default preset. */
    readonly preset: (chain: PresetChain) => Effect.Effect<PresetInput, SourceError>
  }
>()("rp/assembler/AssemblySources") {}

/** What a caller asks for, beyond what the sources say. */
export interface AssemblyRequest {
  readonly now: number
  readonly timeZone: string
  /** Values drawn by an earlier assembly of this context, per piece: rebuilds it identically. */
  readonly frozen: Readonly<Record<string, FrozenValues>>
  /** Where new random draws come from, in [0, 1). */
  readonly random: () => number
  readonly macros: MacroLookup
}

/** The cast of a chat at the position being generated. */
export interface Cast {
  /** Participants the user doesn't play, in join order. */
  readonly characters: ReadonlyArray<CardInput>
  /** Participants the user plays (the "played by me" set), in its order. */
  readonly personas: ReadonlyArray<CardInput>
  readonly absent: ReadonlySet<string>
  /** Whose turn it is. Null only in a chat without characters. */
  readonly speaker: CardInput | null
  readonly type: GenerationType
}

/** How the context is laid out (DATA-MODEL §5.3: `layout.cards`, `roles.projection`). */
interface Mode {
  /** ST-compatible: one character, ST's markers and roles. Otherwise our layouts. */
  readonly st: boolean
  readonly layout: "concat" | "swap_tail"
  readonly projection: "by_writer" | "alternate" | "perspective"
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
  readonly request: AssemblyRequest
  target?: Target
  events?: ReadonlyArray<PositionedEvent>
  state?: ChatState
  cast?: Cast
  model?: ModelInput | null
  preset?: PresetInput
  notes?: ReadonlyArray<NoteInput>
  mode?: Mode
  macros?: MacroEnvironment
  /** The path, root first, as far back as the context could use (`history` stage). */
  history?: ReadonlyArray<HistoryEntry>
  /** Messages of the path not read, older than `history`. */
  historyOmitted?: number
  /** The messages of `history` that enter the context, with the pieces recording their text. */
  resolved?: ReadonlyArray<{ readonly entry: HistoryEntry; readonly piece: number }>
  projected?: ReadonlyArray<ProjectedEntry>
  composition?: Composition
  messages?: Array<RequestMessage & { readonly pieces: ReadonlyArray<number>; readonly kind: Stability }>
  /** The prefill to send, when the model takes one. */
  prefill?: string
  breakpoints?: AssembledRequest["breakpoints"]
  result?: AssembledRequest
  readonly pieces: Array<Piece>
  readonly frozen: Record<string, FrozenValues>
  readonly effects: Array<VariableEffect>
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

export type StageRegistry = Registry<AssemblerStage>

export const makeStageRegistry = (): StageRegistry => makeRegistry<AssemblerStage>()

/** Runs every stage in effect, in order, and returns the context as built. */
export const assemble = (stages: StageRegistry, request: AssemblyRequest) =>
  Effect.gen(function* () {
    let assembly: Assembly = { request, pieces: [], frozen: {}, effects: [], issues: [] }
    for (const stage of stages.list()) assembly = yield* stage.run(assembly)
    const target = need(assembly, "target")
    const preset = need(assembly, "preset")
    const cast = need(assembly, "cast")
    const mode = need(assembly, "mode")
    const snapshot: ContextSnapshot = {
      schema: 1,
      inputs: {
        chatId: target.chatId,
        slotId: target.slotId,
        versionId: target.versionId,
        leafSlotId: target.parentSlotId,
        now: request.now,
        timeZone: request.timeZone,
        type: cast.type,
        speaker: cast.speaker?.entity ?? null,
        mode: mode.st ? "st" : "layouts",
        preset: { ref: preset.ref, revision: preset.revision, scope: preset.scope },
        cards: [...cast.characters, ...cast.personas].map(({ entity, ref, revision }) => ({ entity, ref, revision })),
        model: assembly.model ?? null
      },
      request: need(assembly, "result"),
      pieces: assembly.pieces,
      issues: assembly.issues,
      frozen: assembly.frozen,
      effects: assembly.effects
    }
    return snapshot
  })
