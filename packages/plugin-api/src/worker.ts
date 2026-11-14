export * from "./common.ts"
import type { Effect, Scope } from "effect"
import type { Handle, PrivateStorage } from "./common.ts"
import type { MacroEntry } from "@rp/shared/macros/registry.ts"
import type { PluginStateKey, StateKeyRegistrationError } from "@rp/shared/state.ts"
import type { Registration } from "./server.ts"
export interface WorkerRegistries {
  readonly stateKeys: {
    readonly register: (key: PluginStateKey) => Effect.Effect<void, StateKeyRegistrationError, Scope.Scope>
  }
  readonly storageKinds: Handle<{ readonly id: string; readonly values: ReadonlyArray<string> }>
  readonly settingsRegistry: Handle<Registration>
  readonly macros: Handle<MacroEntry>
  readonly stages: Handle<Registration>
  readonly projections: Handle<Registration>
  readonly transforms: Handle<Registration>
  readonly leafPlanners: Handle<Registration>
  readonly maintenancePlanners: Handle<Registration>
}
export interface WorkerHost {
  readonly api: 1
  readonly id: string
  readonly registries: Partial<WorkerRegistries>
  readonly storage?: PrivateStorage
}
export type Activate = (host: WorkerHost) => Effect.Effect<void, unknown, Scope.Scope>

/** Macro contract v1. The host supplies only the already causal, viewer-filtered expansion.
 * resolve/expandTemplate share the evaluator's budget and variable overlay; lookup returns
 * metadata only. random is the expansion's injected source; pick uses pickSeed, contentHash
 * and offset. volatile true freezes a value; clock freezes the observed time; accepts/work
 * validate and charge even frozen draws. All plugin macros also invalidate prefix reuse:
 * ambient randomness cannot be verified for full-trust closures. No settings or credentials.
 */
export type { MacroCall, MacroInfo, MacroContractV1, MacroContext, CardFields, ChatMessage } from "./macros.ts"
export type { VarScope } from "@rp/shared/macros/variables.ts"
export { normalize } from "@rp/shared/macros/variables.ts"
export { ELSE_MARKER, isFalse, trimScoped } from "@rp/shared/macros/expand.ts"
export { stringHash } from "@rp/shared/macros/hash.ts"
export { atOffset, formatMoment, humanize, inZone, MAX_FORMAT_GROWTH, parseMoment } from "@rp/shared/macros/time.ts"
