import { PluginFault } from "@dreamspan/shared/pluginFault.ts"
import { workerStorage } from "./workerStorage.ts"
// Adapter loaded through StateModules/AssemblyModules in both source and bundled workers.
import { Effect, Scope, Context } from "effect"
import type { PluginManifest } from "@dreamspan/shared/plugins.ts"
import type { Registry } from "@dreamspan/shared/registry.ts"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import type { Activate } from "../../../plugin-api/src/worker.ts"
import type { InstallStateModule } from "../db/stateModules.ts"
import type { InstallAssemblyModule } from "../assembler/modules.ts"
import { declaredHandles, type RegistrationRegistry } from "./handles.ts"

const claims = new Map<string, string>()
const recording = (): Registry<{ id: string }> => makeRegistry()
export const installWorkerState =
  (manifest: PluginManifest, activate: Activate): InstallStateModule =>
  (keys, kinds, settings) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const registries: Record<string, RegistrationRegistry> = {
        storageKinds: kinds,
        settingsRegistry: settings
      }
      // Activate once per runtime half: the other half's handles record and dispose no-op entries.
      for (const name of ["macros", "stages", "projections", "transforms", "leafPlanners", "maintenancePlanners"])
        registries[name] = recording()
      registries.stateKeys = {
        ...keys,
        register: (value: never) => {
          const entry = value as Parameters<typeof keys.register>[0]
          if (!entry.id.startsWith(manifest.id + "/") && !manifest.replaces.includes(`stateKeys:${entry.id}`))
            return Effect.die(new Error("Plugin state key must be namespaced"))
          return keys.register(entry)
        }
      }
      const handles = declaredHandles(manifest, "worker", registries, scope, claims, () => {
        throw new PluginFault(manifest.id)
      })
      yield* activate(
        Object.freeze({
          api: 1,
          id: manifest.id,
          registries: Object.freeze(handles),
          ...(manifest.surfaces.includes("worker:storage") ? { storage: yield* workerStorage(manifest.id) } : {})
        })
      ).pipe(
        Effect.setContext(Context.make(Scope.Scope, scope)),
        Effect.timeout("5 seconds"),
        Effect.catchCause(() => Effect.die(new PluginFault(manifest.id)))
      )
    })
export const installWorkerAssembly =
  (manifest: PluginManifest, activate: Activate): InstallAssemblyModule =>
  (assembler) =>
    Effect.gen(function* () {
      const scope: Scope.Scope = yield* Effect.scope
      const registries: Record<string, RegistrationRegistry> = {}
      for (const name of [
        "macros",
        "stages",
        "projections",
        "transforms",
        "leafPlanners",
        "maintenancePlanners"
      ] as const)
        registries[name] = assembler[name]
      registries.storageKinds = recording()
      registries.settingsRegistry = recording()
      registries.stateKeys = recording()
      const handles = {
        ...declaredHandles(manifest, "worker", registries, scope, claims, () => {
          throw new PluginFault(manifest.id)
        })
      }

      yield* activate(
        Object.freeze({
          api: 1,
          id: manifest.id,
          registries: Object.freeze(handles),
          ...(manifest.surfaces.includes("worker:storage") ? { storage: yield* workerStorage(manifest.id) } : {})
        })
      ).pipe(
        Effect.setContext(Context.make(Scope.Scope, scope)),
        Effect.timeout("5 seconds"),
        Effect.catchCause(() => Effect.die(new PluginFault(manifest.id)))
      )
    })
