// The assembler's data, all plain JSON (DATA-MODEL §7.1; ARCHITECTURE §13).
import type { FrozenValues } from "@rp/shared/macros/expand.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { PresetDoc } from "@rp/shared/docs/preset.ts"
import { Schema } from "effect"

export type Role = "system" | "user" | "assistant"

/**
 * ST's generation types, which a preset prompt's `injection_trigger` names. Generate is
 * `normal`, a new version of a reply `swipe`, and generating for a character the user
 * plays `impersonate` (DESIGN §2.2).
 */
export type GenerationType = "normal" | "swipe" | "impersonate"

/** Where a piece of the context came from, for the request inspector (DESIGN §7.4). */
export type Source =
  | {
      readonly kind: "preset"
      readonly ref: string | null
      readonly revision: string | null
      readonly identifier: string
    }
  | { readonly kind: "card"; readonly entity: string; readonly revision: string; readonly field: string }
  | { readonly kind: "note"; readonly entity: string; readonly revision: string }
  | { readonly kind: "message"; readonly slot: string; readonly version: string }
  /** Text from the version being generated: its one-turn direction (DESIGN §2.2). */
  | { readonly kind: "direction"; readonly version: string }
  /** Text the assembler wrote itself, such as a card's label or ST's placeholder. */
  | { readonly kind: "assembler"; readonly what: string }

/** One piece of the context: a prompt, a card field, a message, as it was sent. */
export interface Piece {
  readonly id: string
  readonly source: Source
  readonly text: string
  /** The request messages it ended up in; none when nothing of it was sent. */
  readonly messages: Array<number>
  /** The pieces whose text this one holds, such as the fields in a card's labelled block. */
  readonly parts?: ReadonlyArray<number>
}

/** A message of the assembled request, provider-neutral: Chat Completions' shape. */
export interface RequestMessage {
  readonly role: Role
  readonly content: string
  /** Chat Completions' `name`, which only some providers take. */
  readonly name?: string
}

/**
 * Sampler values as the preset sets them, in ST's names (`@rp/shared/docs/preset.ts`).
 * Mapping them to a provider's parameters is the provider request's job (`wire.ts`).
 */
interface Samplers {
  readonly temperature: number
  readonly frequency_penalty: number
  readonly presence_penalty: number
  readonly top_p: number
  readonly top_k: number
  readonly top_a: number
  readonly min_p: number
  readonly repetition_penalty: number
  readonly max_tokens: number
  /** -1 means none. */
  readonly seed: number
}

/** Why a cache breakpoint is where it is (DESIGN §5.5, reference-harness's scheme). */
type BreakpointReason = "prefix" | "history"

export interface AssembledRequest {
  readonly messages: ReadonlyArray<RequestMessage>
  /** Starts the model's reply, when the model can be prefilled; dropped and reported otherwise. */
  readonly prefill: string | null
  readonly samplers: Samplers
  /** Send leading system messages as the provider's system parameter (the preset's `use_sysprompt`). */
  readonly useSystemPrompt: boolean
  /** Cache breakpoints as indices into `messages`, most important first. */
  readonly breakpoints: ReadonlyArray<{ readonly message: number; readonly reason: BreakpointReason }>
  /** The bindings in effect, which providers without a `name` field fold into the text, as ST does. */
  readonly names: { readonly user: string; readonly char: string; readonly group: ReadonlyArray<string> }
}

/** Something about the context the user should know: a piece dropped, a setting not applied. */
export interface Issue {
  readonly kind: "prefill_dropped" | "macro_limit" | "history_truncated" | "examples_truncated" | "regex_skipped"
  readonly message: string
}

/** What a context was built from: enough to build it again from the database (invariant 6). */
export interface SnapshotInputs {
  readonly chatId: string
  readonly slotId: string
  readonly versionId: string
  /** The last message of the path the context was built from; null when it's empty. */
  readonly leafSlotId: string | null
  readonly now: number
  readonly timeZone: string
  readonly type: GenerationType
  readonly speaker: string | null
  readonly mode: "st" | "layouts"
  readonly preset: { readonly ref: string | null; readonly revision: string | null; readonly scope: PresetScope }
  readonly cards: ReadonlyArray<{ readonly entity: string; readonly ref: string | null; readonly revision: string }>
  readonly model: ModelInput | null
}

/** A context as built, stored as its rollout's frozen snapshot (DATA-MODEL §7.1). */
export interface ContextSnapshot {
  readonly schema: 1
  readonly inputs: SnapshotInputs
  readonly request: AssembledRequest
  readonly pieces: ReadonlyArray<Piece>
  readonly issues: ReadonlyArray<Issue>
  /** The values random and time macros drew, per piece: passing them back rebuilds the same context. */
  readonly frozen: Readonly<Record<string, FrozenValues>>
  /** Variable writes the preset's and cards' macros made, in order, to record as state. */
  readonly effects: ReadonlyArray<VariableEffect>
  /** What the sources read, by id and revision, so the context can be read again exactly. */
  readonly sources?: SourcePins
  /** Variable writes of template messages expanded for the first time, to record at their positions. */
  readonly templateWrites?: ReadonlyArray<{ readonly version: string; readonly writes: ReadonlyArray<VariableEffect> }>
}

/** A message of the path as it was read, but its text, which its version and amend count pin. */
type PinnedEntry = Omit<HistoryEntry, "content"> & { readonly amends: number }

/** What one context's sources read, by id and revision, each read keyed by its request (invariant 6). */
export interface SourcePins {
  readonly target: Target
  readonly events: ReadonlyArray<{ readonly id: string; readonly depth: number | null }>
  readonly history: ReadonlyArray<{
    readonly key: string
    readonly older: string | null
    readonly entries: ReadonlyArray<PinnedEntry>
  }>
  readonly cards: ReadonlyArray<{
    readonly key: string
    readonly found: ReadonlyArray<{ readonly entity: string; readonly ref: string | null; readonly revision: string }>
  }>
  readonly notes: ReadonlyArray<{
    readonly key: string
    readonly found: ReadonlyArray<{ readonly entity: string; readonly revision: string; readonly first: boolean }>
  }>
}

/** What generating needs of a snapshot, sent to the main thread apart from it. */
export interface Generation {
  readonly leafSlotId: string | null
  readonly request: AssembledRequest
  readonly model: ModelInput | null
  /** The chat variables the preset's and cards' macros wrote, in order: `null` deletes one. */
  readonly variables: ReadonlyArray<{ readonly name: string; readonly value: string | number | null }>
  /**
   * The random and time values each template message of the path used, to keep with it
   * (DESIGN §5.6), and the variables it wrote, the first time it expanded.
   */
  readonly frozenMessages: ReadonlyArray<{
    readonly versionId: string
    readonly frozen: FrozenValues
    readonly variables: ReadonlyArray<{ readonly name: string; readonly value: string | number | null }>
  }>
}

/** The part of a snapshot generating needs. */
export const generationOf = (snapshot: ContextSnapshot): Generation => {
  const written = new Map((snapshot.templateWrites ?? []).map((t) => [t.version, t.writes]))
  return {
    leafSlotId: snapshot.inputs.leafSlotId,
    request: snapshot.request,
    model: snapshot.inputs.model,
    variables: snapshot.effects.filter((e) => e.scope === "local").map(({ name, value }) => ({ name, value })),
    frozenMessages: snapshot.pieces.flatMap((piece) => {
      if (piece.source.kind !== "message") return []
      const frozen = snapshot.frozen[piece.id]
      const writes = written.get(piece.source.version)
      if (!frozen && !writes) return []
      const variables = (writes ?? []).map(({ name, value }) => ({ name, value }))
      return [{ versionId: piece.source.version, frozen: frozen ?? {}, variables }]
    })
  }
}

// --- What the sources give the pipeline

/** The version being generated and where it is. */
export interface Target {
  readonly chatId: string
  readonly slotId: string
  readonly versionId: string
  readonly depth: number
  readonly parentSlotId: string | null
  /** The version's place among its slot's versions: above 0, it's a new version of a reply (a swipe). */
  readonly ordinal: number
  readonly speaker: string | null
  readonly direction: string | null
}

/** One message of the path, as assembly reads it. */
export interface HistoryEntry {
  readonly slotId: string
  readonly versionId: string
  readonly depth: number
  /** The card the message belongs to, when one is recorded. */
  readonly speaker: string | null
  /**
   * The side the message is on: the user's (their messages, and versions written in
   * their place) or the model's (replies, greetings). Taken from the slot's first version,
   * so an edit or a swipe never moves a message to the other side.
   */
  readonly side: "user" | "assistant"
  readonly content: string
  readonly macroMode: "template" | "verbatim"
  readonly frozen: FrozenValues | null
  /** Whether a template's variable writes are recorded already, as state events of its version. */
  readonly written: boolean
  /** False for hidden messages and for selections that failed or are still empty (invariant 2). */
  readonly inContext: boolean
  readonly sentAt: number
  readonly versions: number
  readonly selectedOrdinal: number
}

/** A window of the path, root first, ending where it was asked to. */
export interface HistoryWindow {
  readonly entries: ReadonlyArray<HistoryEntry>
  /** Where the next older window ends; null at the root. */
  readonly older: string | null
}

export interface CardInput {
  readonly entity: string
  readonly ref: string | null
  readonly revision: string
  readonly doc: CardDoc
}

export interface NoteInput {
  readonly entity: string
  readonly revision: string
  readonly doc: NoteDoc
  /** The card's first note: ST's Character's Note, on unless the chat turned it off. */
  readonly first: boolean
}

/** The card whose note it is; null for the chat's own. */
export const noteCard = (doc: NoteDoc) => ("card" in doc.owner ? doc.owner.card : null)

/** Where the preset in effect comes from, in the scope chain (DATA-MODEL §5.4). */
type PresetScope = "role" | "chat" | "connection" | "user" | "builtin"

export interface PresetInput {
  readonly ref: string | null
  readonly revision: string | null
  readonly scope: PresetScope
  readonly doc: PresetDoc
}

/** The model a generation uses, and what assembly needs to know about it. */
export interface ModelInput {
  readonly connectionId: string
  readonly modelId: string
  /** The provider kind (`openai-chat`, `anthropic`, …) and its wire API. */
  readonly kind: string
  readonly api: string
  readonly key: string
  readonly prefill: "none" | "assistant" | "tool_schema"
  readonly cacheBreakpoints: "auto" | "explicit" | "none"
  /** The context window when some source reported it. */
  readonly context: number | null
  /** The connection's one-way preset override (DESIGN §9). */
  readonly presetOverride: string | null
}

/** Why a context couldn't be built: the generation fails with this, as its failed version shows. */
export class AssemblyFailed extends Schema.TaggedError<AssemblyFailed>()("AssemblyFailed", {
  reason: Schema.Literals(["no_model", "budget", "invalid_document"]),
  message: Schema.String
}) {}
