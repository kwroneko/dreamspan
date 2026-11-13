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
