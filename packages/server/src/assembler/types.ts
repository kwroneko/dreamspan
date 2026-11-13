import type { LoreReceipt, LoreTimingState } from "./loreTiming.ts"
import type { SummaryPrefix } from "../lcm/prefix.ts"
// The assembler's data, all plain JSON (DATA-MODEL §7.1; ARCHITECTURE §15).
import type { ContextDisplay, ContextMessage, ContextSource, SourceActivation } from "@rp/shared/inspectorApi.ts"
import { ContextBudget } from "@rp/shared/inspectorApi.ts"
import type { ContextIssue } from "@rp/shared/chat.ts"
import type { FrozenValues } from "@rp/shared/macros/expand.ts"
import type { VariableEffect } from "@rp/shared/macros/variables.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import type { matchLorebooks } from "./lorebook.ts"
import { type NoteDoc, type ReplaceableCardField, replacesInPlace } from "@rp/shared/docs/note.ts"
import type { LegacyPresetDoc as PresetDoc, PromptCondition } from "@rp/shared/docs/preset.ts"
import { Schema } from "effect"

/** Bump whenever identical inputs would assemble differently. Missing means version 0. */
export const ASSEMBLER_VERSION = 64

export type Role = "system" | "user" | "assistant"

/**
 * ST's generation types, which a preset prompt's `injection_trigger` names. Generate is
 * `normal`, a new version of a reply `swipe`, and generating for a character the user
 * plays `impersonate` (DESIGN §2.2), and Continue `continue`.
 */
export type GenerationType = "normal" | "swipe" | "impersonate" | "continue" | "quiet"

/** Where a piece of the context came from, for the request inspector (DESIGN §7.4). */
export interface PluginSource {
  readonly kind: `${string}/${string}`
  /** Plain JSON, pinned with the piece; descriptors never need live plugin state. */
  readonly data: typeof Schema.Json.Type
}

export type Source =
  | PluginSource
  | {
      readonly kind: "summary"
      readonly id: string
      readonly revision: string
      readonly revisionNumber: number
      readonly level: number
      readonly from: number
      readonly to: number
      readonly stale: boolean
    }
  | {
      readonly kind: "preset"
      readonly ref: string | null
      readonly revision: string | null
      readonly identifier: string
      /** The condition that admitted a conditioned prompt (DESIGN §2.2); absent for one sent always. */
      readonly condition?: Exclude<PromptCondition, "always">
      /** The generation types a prompt skipped by its ST triggers is sent for (inspector's "not sent" list only). */
      readonly triggers?: ReadonlyArray<string>
    }
  | {
      readonly kind: "card"
      readonly entity: string
      readonly revision: string
      readonly field: string
      readonly persona?: boolean
      /** Left out by card-swap this turn: sent only on its own character's turn (inspector's "not sent" list only). */
      readonly swapped?: boolean
    }
  | {
      readonly kind: "lorebook"
      readonly book: string
      readonly revision: string
      readonly uid: number
      readonly activation: LoreRecord
    }
  | {
      readonly kind: "note"
      readonly entity: string
      readonly revision: string
      readonly activation?: Extract<SourceActivation, { kind: "note" }> | undefined
    }
  | { readonly kind: "message"; readonly slot: string; readonly version: string; readonly number?: number }
  /** Text from the version being generated: its one-turn direction (DESIGN §2.2). */
  | { readonly kind: "direction"; readonly version: string }
  /** Text the assembler wrote itself, such as a card's label or ST's placeholder. */
  | { readonly kind: "assembler"; readonly what: string }

export type LoreRecord =
  | {
      readonly status: "activated"
      readonly step: number
      readonly why:
        | ReturnType<typeof matchLorebooks>["activated"][number]["why"]
        | { readonly kind: "pinned" }
        | { readonly kind: "decision"; readonly probability: number }
    }
  | { readonly status: "skipped"; readonly step: number; readonly reason: string }

export interface LorebookInput {
  readonly id: string
  readonly entity: string
  readonly revision: string
  readonly doc: LorebookDoc
  /** Retained import filename without its extension; never the mutable document name. */
  readonly sourceName?: string | null
  /** An embedded book's owning card, for macro bindings. */
  readonly card?: CardInput
}

/** One piece of the context: a prompt, a card field, a message, as it was sent. */
export interface Piece {
  /** The prompt-order slot filled by this root piece, before wire transformations. */
  marker?: string
  readonly id: string
  readonly source: Source
  readonly text: string
  /** The request messages it ended up in; none when nothing of it was sent. */
  readonly messages: Array<number>
  /** The pieces whose text this one holds, such as the fields in a card's labelled block. */
  readonly parts?: ReadonlyArray<number>
  /** The prompt regex scripts that changed its text, in the order they ran (the inspector shows them). */
  scripts?: ReadonlyArray<import("@rp/shared/regexScripts.ts").ScriptRef>
}

/** A message of the assembled request, provider-neutral: Chat Completions' shape. */
export interface RequestImage {
  readonly mediaId: string
  /** Hydrated only for dispatch; snapshots retain references, never image bytes. */
  readonly data?: string
  readonly mimeType?: string
  /** The stored file's content hash and size, which image token estimates key and work from. */
  readonly sha256?: string
  readonly width?: number | null
  readonly height?: number | null
  /** What the image costs this request's model (`image-tokens` stage); counted in `tokensOf`. */
  readonly estimate?: import("@rp/shared/imageTokens.ts").ImageEstimate
}

export interface RequestMessage {
  readonly images?: ReadonlyArray<RequestImage>
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
type BreakpointReason = "prefix" | "summary" | "history" | "pinned"

export interface AssembledRequest {
  readonly summaryStart?: number
  /** Pinned lore starts outside the Messages system parameter, independently of cache markers. */
  readonly pinnedStart?: number
  readonly messages: ReadonlyArray<RequestMessage>
  /** Starts the model's reply, when the model can be prefilled; dropped and reported otherwise. */
  readonly prefill: string | null
  /**
   * Continue without a prefill (owner, 2026-10-31): the reply so far is the last assistant
   * message, and `join` goes before the new text unless that starts with whitespace.
   */
  readonly continuation?: { readonly join: string }
  readonly samplers: Samplers
  /** Send leading system messages as the provider's system parameter (the preset's `use_sysprompt`). */
  readonly useSystemPrompt: boolean
  /** Cache breakpoints as indices into `messages`, most important first. */
  readonly breakpoints: ReadonlyArray<{ readonly message: number; readonly reason: BreakpointReason }>
  /** The bindings in effect, which providers without a `name` field fold into the text, as ST does. */
  readonly names: { readonly user: string; readonly char: string; readonly group: ReadonlyArray<string> }
}

export type Issue = ContextIssue

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
  /** `st` only in snapshots from before the one assembly path (version 25). */
  readonly mode: "st" | "layouts"
  readonly preset: { readonly ref: string | null; readonly revision: string | null; readonly scope: PresetScope }
  readonly cards: ReadonlyArray<{ readonly entity: string; readonly ref: string | null; readonly revision: string }>
  /** Who of `cards` was away or a narrator (spec/CHARACTER-CONTEXT.md §9.1); absent when neither. */
  readonly presence?: import("@rp/shared/knowledge.ts").VersionPresence
  /** A separate context's viewer (`knowledge` stage), whose knowledge the agent's read tools keep to; absent: none. */
  readonly viewer?: string
  /** The viewer's identities through card replacements (`Knowledge.aliases`); absent: only `viewer`. */
  readonly viewerAliases?: ReadonlyArray<string>
  readonly model: ModelInput | null
}

/** Safe provider mapping with indices back to the assembled messages. No transport settings. */
export interface WireContext {
  /** Actual request cache policy after transforms; server-only. */
  readonly cache?: { readonly ttlS: number | null; readonly fixed: boolean; readonly source: string | null }
  /** Complete sanitized historical display, present only after final capture. */
  readonly display?: Pick<ContextDisplay, "model" | "preset" | "issues" | "notSent">
  readonly mapping?: ModelInput["mapping"]
  readonly messages: ReadonlyArray<
    Omit<RequestMessage, "role"> & {
      readonly role: Role | "developer" | "model"
      readonly prefill?: ContextMessage["prefill"]
      readonly sources?: ContextMessage["sources"]
      readonly parts?: ContextMessage["parts"]
      readonly groups?: ContextMessage["groups"]
      readonly breakpoint?: ContextMessage["breakpoint"]
      /** Digest of final, unredacted text/role/name and sent image content hashes/detail. Never projected into an RPC DTO. */
      readonly digest?: string
      readonly inputs: ReadonlyArray<number>
    }
  >
  readonly samplers: Readonly<Record<string, number>>
}

export interface HistoryStart {
  readonly state?: {
    readonly configuration: string
    readonly identity: string
    readonly maximum: number
    readonly target: number
    readonly examples: number
    readonly noteBudget?: { readonly sizes: Readonly<Record<string, number>>; readonly allowance: number }
    readonly revision: number
    /** Digest at the last assembled history marker, for exact-position cache reads. */
    readonly cacheHistory?: string
    /** The same for each separate context's character, by card (unit C7); absent in a shared context. */
    readonly cacheHistoryByView?: Readonly<Record<string, string>>
    /**
     * Lore entries placed above the history, kept activated until its start next moves
     * (DESIGN §1.3); absent when lore goes only below the history.
     */
    readonly pinnedLore?: ReadonlyArray<PinnedLore>
  }
  readonly slotId: string | null
  readonly depth: number
}

/** A lorebook entry pinned above the history: its book, the revision read and its uid. */
interface PinnedLore {
  readonly book: string
  readonly revision: string
  readonly uid: number
}

/** Whether a card's prompt replaced a preset prompt (DESIGN §5.0), for the editors. */
export interface CardOverride {
  readonly identifier: "main" | "jailbreak"
  /** The card whose prompt it is: the speaker's. */
  readonly entity: string
  readonly revision: string
  /** Replaced, or kept because the prompt forbids it, is off, or the preset has none. */
  readonly status: "replaced" | "forbidden" | "disabled" | "missing"
}

/**
 * A preset prompt or card field a note replaces, as assembly resolved it (DESIGN §4.2;
 * spec/NOTE-OVERRIDES.md): a card field's `card` is the card that fills the character's place on
 * this path.
 */
export type ResolvedTarget =
  | { readonly kind: "preset_prompt"; readonly identifier: string }
  | { readonly kind: "card_field"; readonly card: string; readonly field: ReplaceableCardField }

/**
 * What became of a note that replaces something (the `replacements` stage):
 * - `replaced`: sent in the prompt's place; `own_position`: sent at its own placement, the prompt left out
 * - `not_due`: its condition doesn't hold this turn, so the prompt is sent as it is
 * - `forbidden`: a card's note, and the preset prompt forbids overrides
 * - `missing`: the selected preset has no such prompt, or no card fills the place
 * - `disabled`: the prompt is switched off in the preset, so nothing goes there
 * - `conflict`: another note replaces it already (one note per target), so this one does nothing
 */
export interface NoteReplacement {
  readonly entity: string
  readonly revision: string
  readonly target: ResolvedTarget
  readonly ownPosition: boolean
  status: "replaced" | "own_position" | "not_due" | "forbidden" | "missing" | "disabled" | "conflict"
  /** The piece its text was sent as, in the prompt's place. */
  piece?: number
}

/** What an agent reply mode changes in its context (spec/AGENTIC.md §6). */
export interface AgentAssembly {
  /** Told the model with the end of the request: its tools, and how to give its reply. */
  readonly instructions: string
  /** Card-swap: the preset's card places hold only the speaker's card (DESIGN §5.2). */
  readonly speakerCardOnly: boolean
  readonly workshop?: boolean
  readonly stepSummaries?: Readonly<Record<string, string>>
}

/** What decision models decided for this context (spec/AGENTIC.md §7): the lorebook entries admitted. */
export interface DecisionAssembly {
  /** The entry revisions and recent message versions the model judged. */
  readonly stamp: string
  /** `<book>:<uid>` of each entry admitted, with the model's probability. */
  readonly lore: ReadonlyArray<{ readonly entry: string; readonly probability: number }>
}

/** What the `lore` decision point asks about: the entries the keys left out that have a question. */
export interface LoreDecisionInput {
  readonly stamp: string
  readonly candidates: ReadonlyArray<{ readonly key: string; readonly title: string; readonly question: string }>
  readonly recent: ReadonlyArray<{ readonly from: string; readonly text: string }>
}

/** A context as built, stored as its rollout's frozen snapshot (DATA-MODEL §7.1). */
export interface ContextSnapshot {
  /** An agent reply's assembly options, for a rebuild. */
  readonly agentAssembly?: AgentAssembly
  /**
   * An agent reply's lorebooks as assembly read them (attached, the preset's, cards' embedded
   * ones, `card:<entity>` with the card's revision), for its lookup_lore tool.
   */
  readonly agentLore?: ReadonlyArray<{ readonly id: string; readonly entity: string; readonly revision: string }>
  /** The decision models' admissions, for a rebuild (spec/AGENTIC.md §7). */
  readonly decisionAssembly?: DecisionAssembly
  /** The `lore` decision point's input; AssembleContext takes it out before the snapshot is stored. */
  readonly loreDecision?: LoreDecisionInput
  readonly contextBudget?: ContextBudget
  /** The preset's reply-section setting a reply is parsed with; absent for summaries. */
  readonly replySections?: import("@rp/shared/replySections.ts").ReplySectionSettings
  /** What `{{summary}}` filled in, for the preset editor and the Notes tab. */
  readonly summaryFill?: import("@rp/shared/inspectorApi.ts").SummaryFill
  readonly historyStart?: HistoryStart
  readonly historyMove?: "initial" | "maximum" | "budget" | "restore" | "unchanged"
  readonly historyBudget?: number
  /** Frozen inputs to registered summary transforms, before they shape the outgoing request. */
  readonly summaryAssembly?: {
    readonly job: NonNullable<ContextSnapshot["summaryJob"]>
    readonly instruction?: {
      readonly target: number
      /** Rendered registered base instruction, frozen for replay after scope exit. */
      readonly base?: string
      readonly output?: string
      readonly range?: { readonly from: number; readonly to: number }
    }
    readonly samplers: AssembledRequest["samplers"]
  }
  readonly summaryJob?: {
    readonly id: string
    readonly clipTokens: number
    readonly inputs: ReadonlyArray<import("@rp/shared/lcm.ts").Summary["inputs"][number]>
    /** A condensation's parts, each at the revision the request rendered. */
    readonly children?: ReadonlyArray<import("@rp/shared/lcm.ts").Summary["children"][number]>
    readonly tail: string
    readonly style: string
    /** False: sent without the preset, the instruction and messages only (DESIGN §8); absent is with it. */
    readonly withPreset?: boolean
    readonly prefix?: SummaryPrefix
    /**
     * A separate context's own summary (spec/CHARACTER-CONTEXT.md §2.3): the identities whose
     * knowledge its material is filtered by. Absent: the whole path.
     */
    readonly audience?: ReadonlyArray<string>
  }
  readonly lcm?: {
    readonly cursor: string | null
    readonly selected: ReadonlyArray<{
      readonly id: string
      readonly revision: string
      readonly stale: boolean
      readonly from: number
      readonly to: number
      readonly level: number
    }>
    readonly failures?: ReadonlyArray<{ readonly from: number; readonly to: number }>
    readonly omitted: ReadonlyArray<{ readonly from: number; readonly to: number }>
    /** The summary block's pair (DESIGN §8), fitted to the context: what condensation measures against. */
    readonly layerBudget?: { readonly target: number; readonly maximum: number }
    /** The recent messages' pair, fitted to the history allowance: what the planner keeps and triggers at. */
    readonly recentBudget?: { readonly target: number; readonly maximum: number }
    /** What the settings panel shows: the model's room, the current figures, and whether a pair was scaled down. */
    readonly measure?: {
      readonly context: number
      readonly fixed: number
      readonly reply: number
      readonly recentNow: number
      readonly layerNow: number
      readonly recentClamped: boolean
      readonly layerClamped: boolean
    }
    readonly verbatim: { readonly from: number; readonly to: number } | null
  }
  readonly schema: 1
  readonly assemblerVersion?: number
  readonly inputs: SnapshotInputs
  readonly request: AssembledRequest
  readonly pieces: ReadonlyArray<Piece>
  readonly issues: ReadonlyArray<Issue>
  /** The values random and time macros drew, per piece: passing them back rebuilds the same context. */
  readonly frozen: Readonly<Record<string, FrozenValues>>
  /** Variable writes the preset's and cards' macros made, in order, to record as state. */
  readonly effects: ReadonlyArray<VariableEffect>
  /** An emergency deadline outcome: reuse it instead of racing the clock on rebuild. */
  readonly loreTiming?: ReadonlyArray<LoreReceipt>
  readonly loreFallback?: ReturnType<typeof matchLorebooks> & {
    readonly previewEffects?: {
      readonly frozen: Readonly<Record<string, FrozenValues>>
      readonly issues: ReadonlyArray<Issue>
    }
  }
  /** The speaker's card prompts and what became of them; absent when it has none. */
  readonly cardOverrides?: ReadonlyArray<CardOverride>
  /** The notes that replace a prompt or card field and what became of them; absent when none does. */
  readonly noteReplacements?: ReadonlyArray<NoteReplacement>
  /** Enabled preset prompts their condition left out this turn; absent in older snapshots. */
  readonly skippedPrompts?: ReadonlyArray<Source>
  /** The path's images the request leaves out and why (`images` stage); absent in older snapshots. */
  readonly imagesLeftOut?: import("@rp/shared/inspectorApi.ts").ImagesLeftOut
  /** What the sources read, by id and revision, so the context can be read again exactly. */
  readonly wire?: WireContext
  readonly sources?: SourcePins
  /** Variable writes of template messages expanded for the first time, to record at their positions. */
  readonly templateWrites?: ReadonlyArray<{ readonly version: string; readonly writes: ReadonlyArray<VariableEffect> }>
}

/** A message of the path as it was read, but its text, which its version and amend count pin. */
type PinnedEntry = Omit<HistoryEntry, "content"> & { readonly amends: number }

interface FailedSummaryRange {
  readonly id: string
  readonly revision: string
  readonly from: number
  readonly to: number
}

export interface SummaryLayer {
  readonly failures?: ReadonlyArray<FailedSummaryRange>
  readonly summaries: ReadonlyArray<import("@rp/shared/lcm.ts").Summary>
  readonly cursor: string | null
  readonly cursorDepth: number
}

/** What one context's sources read, by id and revision, each read keyed by its request (invariant 6). */
export interface SourcePins {
  /** The image token counts and calibration the assembly read (absent before they were pinned). */
  readonly imageTokenFacts?: import("./pipeline.ts").ImageTokenFacts | undefined
  /** The account's summarization defaults as the assembly read them (absent before they were pinned). */
  readonly lcmDefaults?: import("@rp/shared/lcmSettings.ts").LcmDefaults | null | undefined
  readonly lcm?: {
    readonly failures?: ReadonlyArray<FailedSummaryRange>
    readonly cursor: string | null
    readonly cursorDepth: number
    readonly summaries: ReadonlyArray<{
      readonly id: string
      readonly revision: string
      readonly fresh: boolean
      readonly status: import("@rp/shared/lcm.ts").Summary["status"]
    }>
  }
  readonly target: Target
  readonly historyStart?: HistoryStart | null
  readonly historyRevisions?: Readonly<Record<string, number>>
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
  /** The account's global regex scripts as read; absent in snapshots from before them (none). */
  readonly globalRegex?: ReadonlyArray<import("@rp/shared/docs/regexScript.ts").RegexScript>
  readonly lorebooks?: ReadonlyArray<{
    readonly key: string
    readonly found: ReadonlyArray<{
      readonly id: string
      readonly entity: string
      readonly revision: string
      readonly sourceName?: string | null
    }>
  }>
  readonly notes: ReadonlyArray<{
    readonly key: string
    readonly found: ReadonlyArray<{
      readonly entity: string
      readonly revision: string
      readonly link?: { readonly entity: string; readonly revision: string | null }
    }>
  }>
  /** Absent in snapshots from before notes had intervals, which never counted. */
  readonly loreStates?: ReadonlyArray<{
    readonly key: string
    readonly state: LoreTimingState
  }>
  readonly messageCount?: ReadonlyArray<{ readonly key: string; readonly count: number }>
  readonly userMessages?: ReadonlyArray<{ readonly key: string; readonly count: number }>
  /** Who knew the messages a separate context read (`knowers`); absent when none was read. */
  readonly knowers?: ReadonlyArray<{
    readonly key: string
    readonly found: ReadonlyArray<{
      readonly versionId: string
      readonly knowers: ReadonlyArray<string> | null
      /** Those the fork read counts not present for it (spec/THREADS.md §5.2), its speaker apart. */
      readonly away?: ReadonlyArray<string>
      /** In a separate join's parallel stretch (spec/THREADS.md §7.3). */
      readonly stretched?: boolean
    }>
  }>
  /** Whether the viewer knew everything a summary layer covers (`knewThrough`); absent when not asked. */
  readonly knewThrough?: ReadonlyArray<{ readonly key: string; readonly knew: boolean }>
}

/** Raw metadata from the assembly transaction, scrubbed only at final capture on the main thread. */
export interface InspectionInputs extends Pick<ContextDisplay, "model" | "preset" | "issues"> {
  readonly sources: ReadonlyArray<ReadonlyArray<ContextSource>>
  /** Per request message, its pieces' text by source id, to find where each sits in the sent text. */
  readonly texts?: ReadonlyArray<ReadonlyArray<InspectionNode>>
  readonly notSent?: ReadonlyArray<ContextSource>
}

/** A piece's text by source id and, for a labelled block, the pieces it holds (`partsOf`). */
export interface InspectionNode {
  readonly source: string
  readonly text: string
  readonly frame?: boolean
  readonly parts?: ReadonlyArray<InspectionNode>
}

/** What generating needs of a snapshot, sent to the main thread apart from it. */
export interface Generation {
  /** Labels and source decisions read in the same transaction as assembly; scrubbed on the main thread. */
  readonly inspection?: InspectionInputs
  readonly leafSlotId: string | null
  /** A separate context's viewer, as its identities: the agent's read tools leave out what it didn't know (C5). */
  readonly viewers: ReadonlyArray<string> | null
  readonly request: AssembledRequest
  readonly model: ModelInput | null
  /** How the reply's leading tagged sections are parsed (spec/REPLY-SECTIONS.md); absent: not at all. */
  readonly replySections?: import("@rp/shared/replySections.ts").ReplySectionSettings
  /** The chat variables the preset's and cards' macros wrote, in order: `null` deletes one. */
  readonly variables: ReadonlyArray<{ readonly name: string; readonly value: string | number | null }>
  /** What the user should know about the context, kept on its rollout for the version to show. */
  readonly issues: ReadonlyArray<Issue>
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
    viewers: snapshot.inputs.viewer ? (snapshot.inputs.viewerAliases ?? [snapshot.inputs.viewer]) : null,
    request: snapshot.request,
    ...(snapshot.replySections ? { replySections: snapshot.replySections } : {}),
    model: snapshot.inputs.model,
    variables: snapshot.effects.filter((e) => e.scope === "local").map(({ name, value }) => ({ name, value })),
    issues: snapshot.lcm ? snapshot.issues.filter((issue) => issue.kind !== "history_truncated") : snapshot.issues,
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
  /** Position-based numbering, including summarized/deleted gaps; absent on legacy snapshots and paths without insertions. */
  readonly displayPositions?: boolean
  readonly chatId: string
  readonly slotId: string
  readonly versionId: string
  /** Its position: the depth, or the display position in a fork with insertions (spec/MESSAGE-INSERT.md §3.2). */
  readonly depth: number
  readonly parentSlotId: string | null
  /**
   * The message right before the target on its fork's display path, when that isn't
   * `parentSlotId`: an inserted message sits between them, or follows the tip. The reads of
   * the history before the target start from it (`historyLeafOf`).
   */
  readonly historyLeaf?: string | null
  /** The version's place among its slot's versions: above 0, it's a new version of a reply (a swipe). */
  readonly ordinal: number
  readonly speaker: string | null
  readonly direction: string | null
  /**
   * Continue (ST's): the finished version this one extends, and its text, sent as the start
   * of the reply. Pinned here, so a rebuild sends the same text.
   */
  readonly continues?: { readonly version: string; readonly text: string } | undefined
}

/** An image of a history message; `excluded`: the fork took it out of the context (SetImageExcluded). */
export interface HistoryImage extends RequestImage {
  readonly excluded?: true
}

/** Where the history before the target ends: the message right before it as its fork shows it. */
export const historyLeafOf = (target: Target) =>
  target.historyLeaf === undefined ? target.parentSlotId : target.historyLeaf

/**
 * A merge's join message (spec/CHAT-MERGE.md §2): what the layout needs of its `chat_merges`
 * row. Read with the entry and pinned with it, so a rebuild lays it out the same way.
 */
export interface HistoryMerge {
  readonly id: string
  readonly title: string
  /** The merge's own framing line; null: the preset's. */
  readonly framing: string | null
  /** The destination message the parallel span starts at; null: directly before the join. */
  readonly start: string | null
  /** The source's cast at the merge, by the names the model knows them by. */
  readonly cast: ReadonlyArray<string>
  /**
   * Each character reads only the line it was in (spec/THREADS.md §7.3); absent: together. In a
   * chat with one shared context it filters the parallel stretch only.
   */
  readonly timelines?: "separate"
}

/**
 * One merged source message or summary of a join (`chat_merge_messages`), as a separate context
 * reads it. Frozen at the merge, so a rebuild reads it again rather than pinning it.
 */
export interface MergeRow {
  readonly ordinal: number
  readonly kind: "message" | "summary"
  readonly name: string
  readonly side: "user" | "assistant"
  readonly speaker: string | null
  /** Its text; empty for a row the join left out. */
  readonly content: string
  readonly included: "verbatim" | "left_out"
  /** The cards that knew it in the source: its own record, or the source's cast where none was kept. */
  readonly knowers: ReadonlyArray<string>
}

/** One message of the path, as assembly reads it. */
export interface HistoryEntry {
  /** A merge's join message (spec/CHAT-MERGE.md); absent on any other message. */
  readonly merge?: HistoryMerge
  readonly images?: ReadonlyArray<HistoryImage>
  readonly slotId: string
  readonly versionId: string
  /** Its position: the depth, or the display position in a fork with insertions (spec/MESSAGE-INSERT.md §3.2). */
  readonly depth: number
  /** An inserted message (spec/MESSAGE-INSERT.md), set only in a fork that places insertions. */
  readonly inserted?: true
  /** The card the message belongs to, when one is recorded. */
  readonly speaker: string | null
  /**
   * The side the message is on: the user's (their messages, and versions written in
   * their place) or the model's (replies, greetings). Taken from the slot's first version,
   * so an edit or a swipe never moves a message to the other side.
   */
  readonly side: "user" | "assistant"
  readonly content: string
  /**
   * The reply's leading tagged sections, as they came (spec/REPLY-SECTIONS.md): not part of
   * `content`; sent before it, in their tags, only where the preset sends sections back.
   */
  readonly replySections?: import("@rp/shared/replySections.ts").ReplySections
  readonly macroMode: "template" | "verbatim"
  readonly frozen: FrozenValues | null
  /** Whether a template's variable writes are recorded already, as state events of its version. */
  readonly written: boolean
  /** False for hidden messages and for selections that failed or are still empty (invariant 2). */
  readonly inContext: boolean
  /**
   * Left out of a separate context: the speaker wasn't present for it (spec/CHARACTER-CONTEXT.md
   * §2.1; `assembler/knowledge.ts`), with who did know it (gap lines name them). Set by the history
   * stage, never by a source, so never pinned.
   */
  readonly unknown?: { readonly knowers: ReadonlyArray<string> }
  /**
   * A merge's join in a separate context: the merged rows its viewer knew, in order, and whether
   * that's fewer than were sent (its text is then written again from them). Set by the history
   * stage (`assembler/knowledge.ts`), never pinned; `merge-layout` lays the rows out.
   */
  readonly known?: { readonly rows: ReadonlyArray<MergeRow>; readonly partial: boolean; readonly ambiguous?: boolean }
  readonly sentAt: number
  readonly versions: number
  readonly selectedOrdinal: number
  /** One-based position among this fork’s undeleted swipes, frozen for the inspector. */
  readonly versionNumber?: number
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
  /** The slot's document; a linked slot's `content` is its shared note's, read with it. */
  readonly doc: NoteDoc
  /** The shared note a linked slot showed, at its library head; null when it's gone (binned). */
  readonly link?: { readonly entity: string; readonly revision: string | null }
}

/** The card whose note it is; null for the chat's own. */
export const noteCard = (doc: NoteDoc) => ("card" in doc.owner ? doc.owner.card : null)

/**
 * What ST's macros and lorebook matching read as a card's Character's Note (`{{charDepthPrompt}}`,
 * "Character's note" matching): the card's notes among these that are placed in the chat, at a
 * depth or after the newest message, as ST's note is, joined with newlines in id order. Only
 * what a note shows decides it, never its kind or where it came from (DESIGN §4.1).
 */
export const characterNoteText = (notes: ReadonlyArray<NoteInput> | undefined, card: string | undefined) =>
  (notes ?? [])
    .filter(
      (note) =>
        card !== undefined &&
        noteCard(note.doc) === card &&
        !replacesInPlace(note.doc) &&
        (note.doc.placement.mode === "depth" || note.doc.placement.mode === "tail")
    )
    .toSorted((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0))
    .map((note) => note.doc.content.trim())
    .filter((text) => text !== "")
    .join("\n")

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
  /** Non-secret cache identity; absent on legacy snapshots. */
  readonly connectionRevision?: number
  /** Values needed for SDK text conversion, and a digest of all effective mapping capabilities. */
  readonly mapping?: {
    readonly reasoning: boolean
    readonly supportsDeveloperRole: boolean
    readonly midChatSystem?: boolean
    readonly revision: string
  }
  readonly cacheTtlS?: number | null
  readonly cacheTtlOverride?: boolean
  readonly modelId: string
  /** The provider kind (`openai-chat`, `anthropic`, …) and its wire API. */
  readonly kind: string
  readonly api: string
  /**
   * Whose documented cache contract applies (cachePolicy.ts: `anthropic`, `amazon-bedrock`, …),
   * from the connection's provider; null where none is known, absent on older snapshots.
   */
  readonly cacheContract?: string | null
  readonly key: string
  readonly prefill: "none" | "assistant" | "tool_schema"
  readonly continueUnavailable?: string | undefined
  readonly cacheBreakpoints: "auto" | "explicit" | "none"
  readonly cacheLayout?: import("@rp/shared/providers.ts").CacheLayout
  /** The context window when some source reported it. */
  readonly context: number | null
  /** Where `context` came from, and the catalog entry when a catalog gave it; absent on older snapshots. */
  readonly contextSource?: import("@rp/shared/providers.ts").FieldSource
  readonly contextCatalog?: string
  /** A reported output ceiling; absent on older snapshots. */
  readonly vision?: boolean
  readonly maxImages?: number
  readonly maxOutput?: number | null
  /** The model's own generation settings; absent on older snapshots. */
  readonly settings?: import("@rp/shared/modelSettings.ts").ModelSettings
  /** The connection's one-way preset override (DESIGN §9). */
  readonly presetOverride: string | null
}

/** Why a context couldn't be built: the generation fails with this, as its failed version shows. */
export class AssemblyFailed extends Schema.TaggedError<AssemblyFailed>()("AssemblyFailed", {
  reason: Schema.Literals(["no_model", "budget", "invalid_document", "no_prefill"]),
  message: Schema.String,
  contextBudget: Schema.optionalKey(ContextBudget),
  preset: Schema.optionalKey(Schema.Struct({ ref: Schema.NullOr(Schema.String), scope: Schema.String }))
}) {}
