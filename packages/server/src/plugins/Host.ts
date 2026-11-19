import { configurationRevision, trackAutoConfiguration } from "../chat/autoConfiguration.ts"
import { stateKeys } from "@dreamspan/shared/state.ts"
import { settingsRegistry } from "../db/settings.ts"
import { storageKinds } from "../db/storageKinds.ts"
// Full-trust server plugins, scoped registrations and worker bridges. Consent is never inferred.
import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  PluginRejected,
  type PluginPin,
  type PluginReport,
  type PluginView,
  type PluginDetails,
  type BuiltinPart,
  type BuiltinComparison,
  type CopyBuiltinResult
} from "@dreamspan/shared/plugins.ts"
import type { User, UserId } from "@dreamspan/shared/domain.ts"
import { hasServerCode, pluginAccessGrows } from "@dreamspan/shared/pluginConsent.ts"
import { Reader, Writer } from "../db/Database.ts"
import { AppConfig } from "../config.ts"
import { ExecutionRegistry } from "../execution.ts"
import { Commands } from "../commands.ts"
import { ProviderRegistry } from "../providers/registry.ts"
import { DecisionEngine } from "../decision/engine.ts"
import { StateModules } from "../db/stateModules.ts"
import { AssemblyModules } from "../assembler/modules.ts"
import { Notices } from "../chat/Notices.ts"
import { Network } from "../net/Network.ts"
import { checkPlugin, readBuild, readClientBuild, readRuntimeBuild } from "./check.ts"
import { declaredHandles, type RegistrationRegistry } from "./handles.ts"
import { makePluginAuthoring } from "../agent/tools/plugins.ts"
import type { RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { repoTask } from "./repoTask.ts"
import type { Activate, ServerHost } from "../../../plugin-api/src/server.ts"
import { builtinCopies, builtinCopy, missingBuiltinAdapter, unavailableDisplayBodies } from "./builtins.ts"

type Target = { readonly scope: "instance" | "user"; readonly id: string }
type Version = Target & { readonly commit: string; readonly expectedRevision?: number }
type Failure = PluginRejected
import type { ClientPlugin } from "@dreamspan/shared/pluginClient.ts"
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new PluginRejected({ message: "Plugin files are unavailable or invalid" })
  })
export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly builtinParts: (actor: User) => Effect.Effect<ReadonlyArray<typeof BuiltinPart.Type>, unknown>
    readonly copyBuiltin: (
      actor: User,
      input: { registry: string; id: string; pluginId: string }
    ) => Effect.Effect<typeof CopyBuiltinResult.Type, unknown>
    readonly undoEffect: (actor: User, effect: RolloutEffect) => Effect.Effect<RolloutEffect, unknown>
    readonly clients: (actor: User) => Effect.Effect<ReadonlyArray<ClientPlugin>, unknown>
    readonly clientAsset: (actor: User, target: Version) => Effect.Effect<Uint8Array, unknown>
    readonly list: (actor: User) => Effect.Effect<ReadonlyArray<typeof PluginView.Type>, Failure | unknown>
    readonly get: (actor: User, target: Target) => Effect.Effect<typeof PluginDetails.Type, Failure | unknown>
    readonly goBack: (
      actor: User,
      target: Target & { readonly expectedRevision: number }
    ) => Effect.Effect<PluginReport, Failure | unknown>
    readonly create: (
      actor: User,
      target: Target,
      files: Readonly<Record<string, string>>
    ) => Effect.Effect<string, Failure | unknown>
    readonly commit: (
      actor: User,
      target: Target,
      files: Readonly<Record<string, string>>,
      message: string
    ) => Effect.Effect<string, Failure | unknown>
    readonly log: (
      actor: User,
      target: Target
    ) => Effect.Effect<ReadonlyArray<{ commit: string; message: string }>, Failure>
    readonly diff: (
      actor: User,
      target: Target,
      before: string,
      after: string
    ) => Effect.Effect<ReadonlyArray<string>, Failure>
    readonly check: (actor: User, target: Version) => Effect.Effect<PluginReport, Failure>
    readonly pin: (actor: User, target: Version) => Effect.Effect<PluginReport, Failure | unknown>
    readonly enable: (actor: User, target: Version) => Effect.Effect<PluginReport, Failure | unknown>
    readonly disable: (actor: User, target: Target) => Effect.Effect<void, Failure | unknown>
    readonly deleteData: (actor: User, target: Target) => Effect.Effect<void, Failure | unknown>
  }
>()("rp/plugins/PluginHost") {
  static readonly layer = Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const config = yield* AppConfig,
        reader = yield* Reader,
        writer = yield* Writer
      const execution = yield* ExecutionRegistry,
        commands = yield* Commands,
        providers = yield* ProviderRegistry
      const decisions = yield* DecisionEngine,
        states = yield* StateModules,
        assemblies = yield* AssemblyModules
      const notices = yield* Notices,
        network = yield* Network
      const lifetime = yield* Effect.scope
      const active = new Map<string, Scope.Closeable>(),
        claims = new Map<string, string>(),
        reports = new Map<string, PluginReport>()
      const replacements = new Map<string, { owner: string; parts: ReadonlyArray<string> }>()
      const lock = yield* Semaphore.make(1)
      const assetChecks = yield* Semaphore.make(4)
      const keyOf = (owner: string, id: string) => `${owner}/${id}`
      const ownerOf = (actor: User, target: Target, admin = false) => {
        if ((admin || target.scope === "instance") && actor.role !== "admin")
          throw new PluginRejected({ message: "Only an admin can manage this plugin" })
        return target.scope === "instance" ? "" : actor.id
      }
      const authorize = (actor: User, target: Target, admin = false) =>
        Effect.try({
          try: () => ownerOf(actor, target, admin),
          catch: () => new PluginRejected({ message: "Only an admin can manage this plugin" })
        })
      const registryMap: Record<string, RegistrationRegistry> = {
        rolloutTools: execution.rolloutTools,
        operationTools: execution.operationTools,
        workshopCapabilities: execution.workshopCapabilities,
        orchestrationModes: execution.orchestrationModes,
        replyStrategies: execution.replyStrategies,
        replyParsers: execution.replyParsers,
        liveRewrites: execution.liveRewrites,
        chatKinds: execution.chatKinds,
        commands: commands,
        providerKinds: providers.kinds,
        requestTransforms: providers.transforms,
        responseObservers: providers.observers,
        costFormulas: providers.costs,
        decisionPoints: decisions.points
      }
      // Registration and restoration happen before pin writes. Revisions change in the
      // same synchronous step as the part, so that interval cannot authorize an Auto send.
      const requestRegistries = [
        ...Object.values(registryMap),
        ...Object.values(execution),
        ...Object.values(providers),
        assemblies,
        states,
        stateKeys,
        settingsRegistry,
        storageKinds
      ]
      yield* trackAutoConfiguration(() => requestRegistries.map(configurationRevision))
      const notify = (userId: UserId, id: string, message: string) =>
        notices.publish(userId, { _tag: "PluginsChanged", id, message })
      const close = (owner: string, id: string) =>
        Effect.gen(function* () {
          const key = keyOf(owner, id),
            scope = active.get(key)
          active.delete(key)
          replacements.delete(key)
          if (scope) yield* Scope.close(scope, Exit.void)
        })
      const suspend = (actor: User, owner: string, id: string, report: PluginReport) =>
        Effect.gen(function* () {
          yield* close(owner, id)
          reports.set(keyOf(owner, id), report)
          const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
          if (pins.value[id])
            yield* writer.SetPluginPins({
              userId: actor.id,
              owner,
              revision: pins.revision,
              value: {
                ...pins.value,
                [id]: {
                  ...pins.value[id],
                  suspended: { reason: report.message, at: Date.now(), appStamp: report.appStamp }
                }
              }
            })
          if (owner) notify(owner as UserId, id, report.message)
          else for (const user of yield* reader.ListUsers()) notify(user.id, id, report.message)
        })
      const activate = (actor: User, owner: string, id: string, commit: string, report: PluginReport) =>
        Effect.gen(function* () {
          const { manifest, server, worker } = yield* attempt(() => readRuntimeBuild(config.dataDir, owner, id, commit))
          for (const [key, other] of replacements) {
            if (key === keyOf(owner, id) || (owner && other.owner && owner !== other.owner)) continue
            if (manifest.replaces.some((part) => other.parts.includes(part)))
              return yield* new PluginRejected({
                message: "Another enabled plugin already replaces this part. Turn it off first."
              })
          }
          const scope = yield* Scope.make()
          const fail = () => {
            Effect.runFork(
              Semaphore.withPermit(lock)(
                Effect.suspend(() =>
                  active.get(keyOf(owner, id)) === scope
                    ? suspend(actor, owner, id, {
                        ...report,
                        ok: false,
                        step: "activate",
                        message: "Plugin handler failed; plugin turned off"
                      })
                    : Effect.void
                )
              ).pipe(Effect.catchCause(() => Effect.void))
            )
          }
          const effect = Effect.gen(function* () {
            if (manifest.server) {
              const module = yield* attempt(() => import(server!) as Promise<{ activate: Activate }>)
              const fetch = network.fetchFor({ mode: "inherit" }, (route) => {
                Effect.runFork(Effect.logInfo(`Plugin ${id} network request via ${route.via}`))
              })
              const host: ServerHost = Object.freeze({
                api: 1,
                id,
                registries: declaredHandles(manifest, "server", registryMap, scope, claims, fail),
                ...(manifest.surfaces.includes("server:storage")
                  ? {
                      storage: Object.freeze({
                        get: (key: string) => reader.GetPluginData({ userId: actor.id, pluginId: id, owner, key }),
                        list: () => reader.ListPluginData({ userId: actor.id, pluginId: id, owner }),
                        set: (key: string, value: unknown, revision: number) =>
                          writer.SetPluginData({ userId: actor.id, pluginId: id, owner, key, value, revision }),
                        delete: (key: string, revision: number) =>
                          writer.DeletePluginData({ userId: actor.id, pluginId: id, owner, key, revision })
                      })
                    }
                  : {}),
                ...(manifest.network ? { network: Object.freeze({ fetch }) } : {}),
                // Untrusted text is never logged: even a thrown message may contain a secret.
                log: () => {
                  Effect.runFork(Effect.logInfo(`Plugin ${id} log event`))
                },
                notices: Object.freeze({ publish: () => notify(actor.id, id, "Plugin notification") })
              })
              yield* Effect.suspend(() => module.activate(host)).pipe(
                Effect.setContext(Context.make(Scope.Scope, scope)),
                Effect.timeout("5 seconds")
              )
            }
            if (manifest.worker) {
              const module = worker!
              yield* states.onFailure(id, fail)
              yield* states.register({ id: `plugin:${id}`, module, exportName: "state" })
              yield* assemblies.register({ id: `plugin:${id}`, module, exportName: "assembly" })
            }
          })
          yield* Scope.provide(effect, scope).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
          active.set(keyOf(owner, id), scope)
          replacements.set(keyOf(owner, id), { owner, parts: manifest.replaces })
          yield* Scope.addFinalizer(lifetime, Scope.close(scope, Exit.void))
        })
      const check = (actor: User, target: Version) =>
        Effect.gen(function* () {
          const owner = yield* authorize(actor, target, true)
          const report = yield* attempt(() => checkPlugin(config.dataDir, owner, target.id, target.commit))
          reports.set(keyOf(owner, target.id), report)
          return report
        })
      const enable = (actor: User, target: Version) =>
        Effect.gen(function* () {
          const owner = yield* authorize(actor, target, true)
          const before = yield* reader.GetPluginPins({ userId: actor.id, owner })
          if (target.expectedRevision !== undefined && before.revision !== target.expectedRevision)
            return yield* new PluginRejected({ message: "Plugins changed elsewhere. Review this version again." })
          if (!config.plugins) return yield* new PluginRejected({ message: "Plugins are disabled by the server" })
          const report = yield* check(actor, target)
          if (!report.ok) return report
          const previous = before.value[target.id]
          if (previous?.commit === target.commit && !previous.suspended && active.has(keyOf(owner, target.id)))
            return report
          // Files are durable before settings. A kill here leaves code present but unenabled.
          yield* close(owner, target.id)
          const loaded = yield* activate(actor, owner, target.id, target.commit, report).pipe(Effect.exit)
          if (Exit.isFailure(loaded)) {
            const conflict = loaded.cause.reasons.some((r) => r._tag === "Fail" && r.error instanceof PluginRejected)
            const failed: PluginReport = {
              ...report,
              ok: false,
              step: "activate",
              message: conflict
                ? "Another enabled plugin already replaces this part. Turn it off first."
                : "Plugin activation failed; plugin turned off"
            }
            yield* suspend(actor, owner, target.id, failed)
            return failed
          }
          const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
          yield* writer
            .SetPluginPins({
              userId: actor.id,
              owner,
              revision: pins.revision,
              value: {
                ...pins.value,
                [target.id]: {
                  commit: target.commit,
                  enabledAt: Date.now(),
                  enabledBy: actor.id,
                  ...(previous?.commit && previous.commit !== target.commit
                    ? { previousCommit: previous.commit }
                    : previous?.previousCommit
                      ? { previousCommit: previous.previousCommit }
                      : {}),
                  enabledCommits: [
                    ...new Set([
                      target.commit,
                      ...(previous?.enabledCommits ?? []),
                      ...(previous ? [previous.commit] : [])
                    ])
                  ].slice(0, 50)
                }
              }
            })
            .pipe(Effect.onError(() => close(owner, target.id)))
          if (owner) notify(actor.id, target.id, "Plugins changed")
          else for (const user of yield* reader.ListUsers()) notify(user.id, target.id, "Plugins changed")
          return report
        })
      const get = (actor: User, target: Target) =>
        Effect.gen(function* () {
          const owner = target.scope === "instance" ? "" : actor.id
          const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
          const pin: PluginPin | null = pins.value[target.id] ?? null
          const { commit, manifest } = yield* attempt(() =>
            repoTask<Pick<typeof PluginView.Type, "commit" | "manifest">>(config.dataDir, {
              op: "info",
              owner,
              id: target.id,
              ...(pin && !pin.suspended ? { selected: pin.commit } : {})
            })
          ).pipe(Effect.catch(() => Effect.succeed({ commit: pin?.commit ?? null, manifest: null })))
          const report =
            reports.get(keyOf(owner, target.id)) ??
            (pin?.suspended
              ? {
                  commit: pin.commit,
                  appStamp: pin.suspended.appStamp,
                  ok: false,
                  step: "activate" as const,
                  message: pin.suspended.reason,
                  at: pin.suspended.at
                }
              : null)
          return { ...target, commit, manifest, pin, report }
        })
      const details = (actor: User, target: Target) =>
        Effect.gen(function* () {
          const view = yield* get(actor, target)
          const owner = target.scope === "instance" ? "" : actor.id
          const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
          const versions = yield* attempt(() =>
            repoTask<typeof PluginDetails.Type.versions>(config.dataDir, {
              op: "versions",
              owner,
              id: target.id,
              extra: [
                ...(pins.value[target.id]?.enabledCommits ?? []),
                ...(pins.value[target.id] ? [pins.value[target.id]!.commit] : [])
              ]
            })
          ).pipe(Effect.catch(() => Effect.succeed([])))
          const data =
            target.scope === "instance" && actor.role !== "admin"
              ? null
              : yield* reader.PluginDataInfo({ userId: actor.id, pluginId: target.id, owner })
          const original = view.commit
            ? yield* attempt(() =>
                repoTask<typeof BuiltinComparison.Type | null>(config.dataDir, {
                  op: "compareBuiltin",
                  owner,
                  id: target.id,
                  commit: view.pin && !view.pin.suspended ? view.pin.commit : view.commit!
                })
              ).pipe(Effect.catch(() => Effect.succeed(null)))
            : null
          return { ...view, pin: pins.value[target.id] ?? null, revision: pins.revision, versions, data, original }
        })
      const authorizeLocal = (actor: User, target: Target) =>
        Effect.gen(function* () {
          const owner = yield* authorize(actor, target)
          if (actor.role !== "admin") {
            const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
            const info = yield* attempt(() =>
              repoTask<Pick<typeof PluginView.Type, "commit" | "manifest">>(config.dataDir, {
                op: "info",
                owner,
                id: target.id,
                ...(pins.value[target.id] ? { selected: pins.value[target.id]!.commit } : {})
              })
            )
            if (!info.manifest || hasServerCode(info.manifest))
              return yield* new PluginRejected({ message: "Only an admin can manage server plugins" })
          }
          return owner
        })
      const rollback = (actor: User, target: Version) =>
        Effect.gen(function* () {
          const owner = yield* authorize(actor, target, true)
          const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
          if (target.expectedRevision !== undefined && pins.revision !== target.expectedRevision)
            return yield* new PluginRejected({ message: "Plugins changed elsewhere. Review this version again." })
          const pin = pins.value[target.id]
          if (pin?.commit === target.commit && !pin.suspended) return yield* enable(actor, target)
          // Persist suspension before checkout. Failed checks must leave the plugin off.
          if (pin && !pin.suspended)
            yield* suspend(actor, owner, target.id, {
              commit: pin.commit,
              appStamp: "",
              ok: false,
              step: "snapshot",
              message: "Plugin version changed; turn it on to apply it",
              at: Date.now()
            })
          else yield* close(owner, target.id)
          yield* attempt(() =>
            repoTask(config.dataDir, { op: "checkout", owner, id: target.id, commit: target.commit })
          )
          // The revision changed when suspension was persisted; the outer guard already ran under the same lock.
          return yield* enable(actor, { scope: target.scope, id: target.id, commit: target.commit })
        })
      const clients = (actor: User) =>
        Effect.gen(function* () {
          if (!config.plugins) return []
          const result: Array<ClientPlugin> = []
          for (const scope of ["instance", "user"] as const) {
            const owner = scope === "instance" ? "" : actor.id
            const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
            for (const [id, pin] of Object.entries(pins.value)) {
              if (pin.suspended || !active.has(keyOf(owner, id))) continue
              const build = yield* attempt(() => readBuild(config.dataDir, owner, id, pin.commit)).pipe(Effect.option)
              if (build._tag === "Some" && build.value.manifest.client)
                result.push({ scope, id, commit: pin.commit, manifest: build.value.manifest })
            }
          }
          return result
        })
      const service: PluginHost["Service"] = PluginHost.of({
        builtinParts: (actor) =>
          Effect.gen(function* () {
            const plugins = yield* service.list(actor)
            const parts: Array<typeof BuiltinPart.Type> = builtinCopies.map((p) => ({
              registry: p.registry,
              id: p.id,
              label: p.label,
              copyable: true,
              reason:
                p.registry === "macros"
                  ? "An editable copy starts off. Copied macros can reduce prompt cache reuse: their text is treated as changing on every reply."
                  : "An editable copy starts off. Review it before turning it on.",
              replacedBy: plugins
                .filter((v) => v.pin && !v.pin.suspended && v.manifest?.replaces.includes(`${p.registry}:${p.id}`))
                .map(({ scope, id }) => ({ scope, id }))
            }))
            parts.push(...unavailableDisplayBodies)
            for (const tool of execution.rolloutTools.list()) {
              if (parts.some((p) => p.registry === "rolloutTools" && p.id === tool.id) || !tool.source) continue
              parts.push({
                registry: "rolloutTools",
                id: tool.id,
                label: tool.explanation ?? tool.label,
                copyable: false,
                reason: missingBuiltinAdapter(tool.id),
                replacedBy: []
              })
            }
            return parts
          }),
        copyBuiltin: (actor, input) =>
          Semaphore.withPermit(lock)(
            Effect.gen(function* () {
              if (actor.role !== "admin")
                return yield* new PluginRejected({ message: "Only an admin can create a copy here" })
              const part = builtinCopy(input.registry, input.id)
              if (!part) return yield* new PluginRejected({ message: "This part does not have a copy adapter yet" })
              const scope = part.side !== "client" ? ("instance" as const) : ("user" as const)
              const owner = scope === "instance" ? "" : actor.id
              const result = yield* attempt(() =>
                repoTask<{ commit?: string; unsupported?: ReadonlyArray<string> }>(config.dataDir, {
                  op: "copyBuiltin",
                  owner,
                  id: input.pluginId,
                  registry: input.registry,
                  partId: input.id,
                  key: randomUUID()
                })
              )
              if (result.unsupported)
                return yield* new PluginRejected({
                  message: "This built-in needs an adapter for: " + result.unsupported.join(", ") + "."
                })
              const report = yield* check(actor, { scope, id: input.pluginId, commit: result.commit! })
              return { scope, id: input.pluginId, commit: result.commit!, report }
            })
          ),
        undoEffect: (actor, effect) => authoring.undoEffect(actor, effect),
        clients,
        clientAsset: (actor, target) =>
          Semaphore.withPermit(assetChecks)(
            Effect.gen(function* () {
              const authorize = Semaphore.withPermit(lock)(
                Effect.gen(function* () {
                  // The membership test of clients(), for the requested plugin only.
                  const owner = target.scope === "instance" ? "" : actor.id
                  const pin = config.plugins
                    ? (yield* reader.GetPluginPins({ userId: actor.id, owner })).value[target.id]
                    : undefined
                  let enabled =
                    pin !== undefined &&
                    !pin.suspended &&
                    pin.commit === target.commit &&
                    active.has(keyOf(owner, target.id))
                  if (enabled) {
                    const build = yield* attempt(() => readBuild(config.dataDir, owner, target.id, target.commit)).pipe(
                      Effect.option
                    )
                    enabled = build._tag === "Some" && !!build.value.manifest.client
                  }
                  if (!enabled) return yield* new PluginRejected({ message: "Plugin is off" })
                })
              )
              yield* authorize
              const build = yield* attempt(() =>
                readClientBuild(config.dataDir, target.scope === "instance" ? "" : actor.id, target.id, target.commit)
              ).pipe(
                Effect.tapError(() =>
                  Semaphore.withPermit(lock)(
                    Effect.gen(function* () {
                      const owner = target.scope === "instance" ? "" : actor.id
                      const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
                      if (pins.value[target.id]?.commit === target.commit && !pins.value[target.id]?.suspended) {
                        const users = yield* reader.ListUsers()
                        const admin =
                          users.find(
                            (u) => u.id === pins.value[target.id]!.enabledBy && u.role === "admin" && !u.disabled
                          ) ?? users.find((u) => u.role === "admin" && !u.disabled)
                        if (admin)
                          yield* suspend(admin, owner, target.id, {
                            commit: target.commit,
                            appStamp: "",
                            ok: false,
                            step: "snapshot",
                            message:
                              "The approved plugin files changed. Check this version before turning it on again.",
                            at: Date.now()
                          })
                        else yield* close(owner, target.id)
                      }
                    })
                  )
                )
              )
              // A disable/update admitted during the file check wins before any bytes are returned.
              yield* authorize
              return build.bytes
            })
          ),
        check: (actor, target) => Semaphore.withPermit(lock)(check(actor, target)),
        enable: (actor, target) => Semaphore.withPermit(lock)(enable(actor, target)),
        pin: (actor, target) => Semaphore.withPermit(lock)(rollback(actor, target)),
        goBack: (actor, target) =>
          Semaphore.withPermit(lock)(
            Effect.gen(function* () {
              const owner = yield* authorize(actor, target, true)
              const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
              const previous = pins.value[target.id]?.previousCommit
              if (!previous) return yield* new PluginRejected({ message: "No earlier enabled version is available" })
              const versions = yield* attempt(() =>
                repoTask<typeof PluginDetails.Type.versions>(config.dataDir, {
                  op: "versions",
                  owner,
                  id: target.id,
                  extra: [pins.value[target.id]!.commit, previous]
                })
              )
              const currentManifest = versions.find((v) => v.commit === pins.value[target.id]!.commit)?.manifest
              const previousManifest = versions.find((v) => v.commit === previous)?.manifest
              if (!previousManifest)
                return yield* new PluginRejected({
                  message: "The earlier version is unavailable. Choose another version."
                })
              if (pluginAccessGrows(currentManifest, previousManifest))
                return yield* new PluginRejected({
                  message: "This version adds access. Review it before turning it on."
                })
              return yield* rollback(actor, { ...target, commit: previous })
            })
          ),
        get: (actor, target) => Semaphore.withPermit(lock)(details(actor, target)),
        list: (actor) =>
          Effect.gen(function* () {
            const result: Array<typeof PluginView.Type> = []
            for (const scope of ["instance", "user"] as const) {
              const base = join(
                config.dataDir,
                "plugins",
                ...(scope === "instance" ? ["instance"] : ["users", actor.id])
              )
              const folders = yield* attempt(() => readdir(base)).pipe(Effect.catch(() => Effect.succeed([])))
              const pins = yield* reader.GetPluginPins({
                userId: actor.id,
                owner: scope === "instance" ? "" : actor.id
              })
              const ids = new Set([...folders, ...Object.keys(pins.value)])
              result.push(
                ...(yield* Effect.forEach(
                  [...ids].filter((id) => /^[a-z][a-z0-9-]{0,63}$/.test(id)),
                  (id) => get(actor, { scope, id }),
                  { concurrency: 4 }
                ))
              )
            }
            return result
          }),
        create: (actor, target, files) =>
          Semaphore.withPermit(lock)(
            Effect.gen(function* () {
              const owner = yield* authorize(actor, target, true)
              return yield* attempt(() =>
                repoTask<string>(config.dataDir, {
                  op: "save",
                  owner,
                  id: target.id,
                  files,
                  initial: true,
                  message: "Initial plugin"
                })
              )
            })
          ),
        commit: (actor, target, files, message) =>
          Semaphore.withPermit(lock)(
            Effect.gen(function* () {
              const owner = yield* authorize(actor, target, true)
              return yield* attempt(() =>
                repoTask<string>(config.dataDir, { op: "save", owner, id: target.id, files, initial: false, message })
              )
            })
          ),
        log: (actor, target) =>
          Effect.gen(function* () {
            const owner = yield* authorize(actor, target)
            return yield* attempt(async () =>
              repoTask<ReadonlyArray<{ commit: string; message: string }>>(config.dataDir, {
                op: "log",
                owner,
                id: target.id
              })
            )
          }),
        diff: (actor, target, before, after) =>
          Effect.gen(function* () {
            const owner = yield* authorize(actor, target)
            return yield* attempt(async () =>
              repoTask<ReadonlyArray<string>>(config.dataDir, { op: "diff", owner, id: target.id, before, after })
            )
          }),
        disable: (actor, target) =>
          Semaphore.withPermit(lock)(
            Effect.gen(function* () {
              const owner = yield* authorizeLocal(actor, target)
              const pins = yield* reader.GetPluginPins({ userId: actor.id, owner }),
                pin = pins.value[target.id]
              yield* close(owner, target.id)
              if (pin)
                yield* suspend(actor, owner, target.id, {
                  commit: pin.commit,
                  appStamp: "",
                  ok: false,
                  step: "ready",
                  message: "Plugin turned off",
                  at: Date.now()
                })
            })
          ),
        deleteData: (actor, target) =>
          Semaphore.withPermit(lock)(
            Effect.gen(function* () {
              const owner = yield* authorizeLocal(actor, target)
              yield* writer.DeletePluginData({ userId: actor.id, pluginId: target.id, owner, key: null, revision: 0 })
              if (owner) notify(owner as UserId, target.id, "Plugins changed")
              else for (const user of yield* reader.ListUsers()) notify(user.id, target.id, "Plugins changed")
            })
          )
      })
      const dirty = (actor: User, target: Target) =>
        Effect.gen(function* () {
          const owner = yield* authorize(actor, target)
          const pins = yield* reader.GetPluginPins({ userId: actor.id, owner })
          const pin = pins.value[target.id]
          if (pin) {
            yield* authorizeLocal(actor, target)
            if (!pin.suspended)
              yield* suspend(actor, owner, target.id, {
                commit: pin.commit,
                appStamp: "",
                ok: false,
                step: "snapshot",
                message: "Plugin turned off",
                at: Date.now()
              })
          } else yield* close(owner, target.id)
        })
      const authoring = makePluginAuthoring({
        host: { ...service, get: details },
        lock,
        dataDir: config.dataDir,
        reader,
        writer,
        rollback,
        dirty
      })
      if (config.plugins) for (const tool of authoring.tools) yield* execution.rolloutTools.register(tool)
      if (config.plugins) {
        const users = yield* reader.ListUsers()
        const pins = yield* reader.AllPluginPins()
        const pending = pins
          .flatMap((group) => Object.entries(group.value).map(([id, pin]) => ({ owner: group.owner, id, pin })))
          .sort((a, b) => a.pin.enabledAt - b.pin.enabledAt || keyOf(a.owner, a.id).localeCompare(keyOf(b.owner, b.id)))
        for (const { owner, id, pin } of pending) {
          if (pin.suspended) continue
          const actor = users.find((u) => u.id === pin.enabledBy && u.role === "admin" && !u.disabled)
          if (!actor) {
            const admin = users.find((u) => u.role === "admin" && !u.disabled)
            if (admin)
              yield* suspend(admin, owner, id, {
                commit: pin.commit,
                appStamp: "",
                ok: false,
                step: "activate",
                message: "Plugin author is no longer an active admin",
                at: Date.now()
              })
            continue
          }
          const user: User = { id: actor.id, handle: actor.handle, displayName: actor.displayName, role: actor.role }
          const report = yield* attempt(() =>
            checkPlugin(config.dataDir, owner, id, pin.commit, {
              working: false,
              admin: true,
              historical: true,
              approved: true
            })
          )
          reports.set(keyOf(owner, id), report)
          if (!report.ok) {
            yield* suspend(user, owner, id, report)
            continue
          }
          yield* activate(user, owner, id, pin.commit, report).pipe(
            Effect.catchCause((cause) =>
              suspend(user, owner, id, {
                ...report,
                ok: false,
                step: "activate",
                message: cause.reasons.some((r) => r._tag === "Fail" && r.error instanceof PluginRejected)
                  ? "Another enabled plugin already replaces this part. Turn it off first."
                  : "Plugin startup activation failed; plugin turned off"
              })
            )
          )
        }
      }
      return service
    })
  )
}
