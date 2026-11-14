// Stable API v1. These contracts intentionally do not import the application's RPC/service graph.
export * from "./common.ts"
export { Type } from "@earendil-works/pi-ai"
import type { TSchema } from "@earendil-works/pi-ai"
import type { Effect, Scope, Schema } from "effect"
import type { Handle, PrivateStorage } from "./common.ts"
export interface Registration {
  readonly id: string
  readonly [field: string]: unknown
}
export interface PluginToolContext {
  readonly userId: string
  readonly chatId: string
  readonly forkId: string | null
  readonly slotId: string
  readonly versionId: string
  readonly rolloutId: string
  readonly toolCallId: string
  readonly leafSlotId: string | null
  readonly viewers: ReadonlyArray<string> | null
}
export interface PluginTool {
  readonly source?: string
  readonly id: string
  readonly label: string
  readonly description: string
  readonly explanation?: string
  readonly capability?: string
  readonly effect: "read" | "chat_state" | "external" | "library" | "setup" | "outside"
  readonly parameters: Readonly<Record<string, unknown>> | TSchema
  readonly execute: (
    context: PluginToolContext,
    args: unknown
  ) => Effect.Effect<{ readonly text: string; readonly isError?: boolean }>
}
/** Only the cast before this reply; no database clients, providers or credentials. */
export interface PresenceContext {
  readonly cast: Effect.Effect<
    ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly modelName: string | null
      readonly narrator: boolean
    }>,
    unknown
  >
  /** Validates membership and narrator status again; records the ordinary reversible presence effect. */
  readonly set: (id: string, present: boolean, result: string) => Effect.Effect<string, unknown>
}
export interface PresenceArgs {
  readonly character: string
  readonly present: boolean
}
/** Requires server:presence as well as server:rolloutTools. Only set_presence uses this adapter. */
export interface PresenceTool extends Omit<PluginTool, "execute" | "effect" | "capability"> {
  readonly id: "set_presence"
  /** The host preserves the built-in state-write permission, receipts and Undo. */
  readonly effect: "chat_state"
  readonly summarize: (args: PresenceArgs) => string
  readonly execute: (
    context: PresenceContext,
    args: PresenceArgs
  ) => Effect.Effect<{ readonly text: string; readonly isError?: boolean }, unknown>
}
export interface PluginCommand {
  readonly id: string
  readonly description: string
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly execute: (input: unknown) => Effect.Effect<unknown, unknown>
}
export interface ServerRegistries {
  readonly rolloutTools: Handle<PluginTool | PresenceTool | StoryToolV1 | NoteToolV1>
  readonly operationTools: Handle<Registration>
  readonly workshopCapabilities: Handle<Registration>
  readonly orchestrationModes: Handle<Registration>
  readonly replyStrategies: Handle<Registration>
  readonly replyParsers: Handle<Registration>
  readonly liveRewrites: Handle<Registration>
  readonly chatKinds: Handle<Registration>
  readonly providerKinds: Handle<Registration>
  readonly requestTransforms: Handle<Registration>
  readonly responseObservers: Handle<Registration>
  readonly costFormulas: Handle<Registration>
  readonly decisionPoints: Handle<Registration>
  readonly commands: Handle<PluginCommand>
}
export interface ServerHost {
  readonly api: 1
  readonly id: string
  readonly registries: Partial<ServerRegistries>
  readonly storage?: PrivateStorage
  readonly network?: {
    readonly fetch: (
      input: string,
      init?: { readonly method?: string; readonly body?: string }
    ) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>
  }
  readonly log: (message: string) => void
  readonly notices: { readonly publish: (message: string) => void }
}
export type Activate = (host: ServerHost) => Effect.Effect<void, unknown, Scope.Scope>

/** Story tool contract v1. Storage, permissions, causal position and snapshots stay host-owned.
 * A replacement may edit presentation and policy, never capability/approval/snapshot hooks.
 * Reads use the frozen viewer projection; no caller-selectable chat, branch or speaker.
 * State writes use the active run/call receipt and reverse with its selected version.
 */
export interface StoryMessageV1 {
  readonly n: number
  readonly address?: string
  readonly speaker: string
  readonly content: string
  readonly joined?: {
    readonly title: string
    readonly from: number | null
    readonly to: number | null
    readonly summary: boolean
  }
}
export interface StorySummaryV1 {
  readonly id: string
  readonly level: number
  readonly from: number
  readonly to: number
  readonly content: string
  readonly children: ReadonlyArray<string>
  readonly joined?: {
    readonly at: number
    readonly title: string
    readonly from: number
    readonly to: number
    readonly content: string
    readonly messages: ReadonlyArray<StoryMessageV1>
  }
}
export interface PrivateStoryV1 {
  readonly refused?: boolean
  readonly messages: ReadonlyArray<StoryMessageV1>
}
export interface HistoryContextV1 {
  readonly filtered: boolean
  readonly messages: Effect.Effect<ReadonlyArray<StoryMessageV1>, unknown>
  readonly privateHistory: Effect.Effect<PrivateStoryV1 | null, unknown>
  readonly summaries: Effect.Effect<ReadonlyArray<StorySummaryV1>, unknown>
  readonly search: (
    words: ReadonlyArray<string>,
    before?: number,
    ordinaryOnly?: boolean
  ) => Effect.Effect<ReadonlyArray<StoryMessageV1> | null, unknown>
}
export interface StoryToolV1<A = never> extends Omit<PluginTool, "execute" | "effect" | "capability"> {
  readonly id: "search_chat" | "read_messages" | "expand_summary" | "search_summaries"
  readonly effect: "read"
  readonly summarize?: (args: A) => string
  readonly execute: (
    context: HistoryContextV1,
    args: A
  ) => Effect.Effect<{ readonly text: string; readonly isError?: boolean }, unknown>
}

export interface NoteViewV1 {
  readonly entity: string
  readonly title: string
  readonly owner: string
  readonly active: boolean
  readonly editable: boolean
  readonly linked: boolean
  readonly content: string
}
export interface NotesReadContextV1 {
  /** Already filtered by the active speaker, including own-turn notes, and current branch. */
  readonly notes: Effect.Effect<ReadonlyArray<NoteViewV1>, unknown>
}
export interface NotesContextV1 extends NotesReadContextV1 {
  /** Revalidates visibility and edit permission; branch/run/call identity cannot be supplied. */
  readonly switch: (entity: string, on: boolean, result: string) => Effect.Effect<string, unknown>
}
export interface NoteReadToolV1<A = never> extends Omit<PluginTool, "execute" | "effect" | "capability"> {
  readonly id: "list_notes"
  readonly effect: "read"
  readonly summarize?: (args: A) => string
  readonly execute: (
    context: NotesReadContextV1,
    args: A
  ) => Effect.Effect<{ readonly text: string; readonly isError?: boolean }, unknown>
}
export interface NoteSwitchToolV1<A = never> extends Omit<PluginTool, "execute" | "effect" | "capability"> {
  readonly id: "switch_note"
  readonly effect: "chat_state"
  readonly summarize?: (args: A) => string
  readonly execute: (
    context: NotesContextV1,
    args: A
  ) => Effect.Effect<{ readonly text: string; readonly isError?: boolean }, unknown>
}
export type NoteToolV1<A = never> = NoteReadToolV1<A> | NoteSwitchToolV1<A>
