// Stable API v1. These contracts intentionally do not import the application's RPC/service graph.
export * from "./common.ts"
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
  readonly id: string
  readonly label: string
  readonly description: string
  readonly explanation?: string
  readonly capability?: string
  readonly effect: "read" | "chat_state" | "external" | "library" | "setup" | "outside"
  readonly parameters: Readonly<Record<string, unknown>>
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
export interface PresenceTool extends Omit<PluginTool, "execute"> {
  readonly id: "set_presence"
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
  readonly rolloutTools: Handle<PluginTool | PresenceTool>
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
