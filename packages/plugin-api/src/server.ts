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
export interface PluginCommand {
  readonly id: string
  readonly description: string
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly execute: (input: unknown) => Effect.Effect<unknown, unknown>
}
export interface ServerRegistries {
  readonly rolloutTools: Handle<PluginTool>
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
