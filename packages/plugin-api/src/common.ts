import type { Effect, Scope } from "effect"
export { Effect, Schema } from "effect"
export { registerMacro } from "@rp/shared/macros/registry.ts"
export type { MacroEntry, MacroSpec } from "@rp/shared/macros/registry.ts"
export interface Handle<A> {
  readonly register: (entry: A) => Effect.Effect<void, never, Scope.Scope>
  readonly disable: (id: string) => Effect.Effect<void, never, Scope.Scope>
  readonly list: () => ReadonlyArray<{ readonly id: string }>
  readonly get: (id: string) => { readonly id: string } | undefined
}
export interface PrivateStorage {
  readonly get: (key: string) => Effect.Effect<{ readonly value: unknown; readonly revision: number } | null, unknown>
  readonly list: () => Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly value: unknown; readonly revision: number }>,
    unknown
  >
  readonly set: (key: string, value: unknown, revision: number) => Effect.Effect<void, unknown>
  readonly delete: (key: string, revision: number) => Effect.Effect<void, unknown>
}
