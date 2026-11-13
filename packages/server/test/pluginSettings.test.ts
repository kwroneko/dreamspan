import { rm } from "node:fs/promises"
import { expect, it } from "vitest"
import { Effect } from "effect"
import { client, login, serverLayer, testConfig } from "./support/config.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { checkoutCommit, pluginFolder, saveFiles } from "../src/plugins/repo.ts"

const files = (id: string, source = "export const activate = () => {}", server = false) => ({
  "rp-plugin.json": JSON.stringify({
    id,
    name: "Synthetic",
    api: 1,
    client: server ? null : "client.ts",
    server: server ? "server.ts" : null,
    worker: null,
    surfaces: [],
    overrides: [],
    replaces: [],
    network: false,
    base: null
  }),
  [server ? "server.ts" : "client.ts"]: source
})
it("guards exact-version races, retains rollback history, shows failed checks, and deletes enabled data", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client(),
          user = yield* api.Whoami(),
          reader = yield* Reader,
          writer = yield* Writer
        const target = { scope: "instance" as const, id: "settings-fixture" }
        const first = yield* api.CreatePlugin({ ...target, files: files(target.id) })
        const before = yield* api.GetPlugin(target)
        const raced = yield* Effect.all(
          [
            api
              .EnablePlugin({ ...target, commit: first, consent: true, expectedRevision: before.revision })
              .pipe(Effect.exit),
            api
              .EnablePlugin({ ...target, commit: first, consent: true, expectedRevision: before.revision })
              .pipe(Effect.exit)
          ],
          { concurrency: 2 }
        )
        expect(raced.map((r) => r._tag).sort()).toEqual(["Failure", "Success"])
        const second = yield* api.CommitPlugin({
          ...target,
          files: files(target.id, "export const activate = () => { /* second */ }"),
          message: "Second version"
        })
        const detail = yield* api.GetPlugin(target)
        expect(detail.versions.find((v) => v.commit === first)?.manifest?.server).toBeNull()
        expect((yield* api.EnablePlugin({ ...target, commit: second, consent: true })).ok).toBe(true)
        const enabled = yield* api.GetPlugin(target)
        expect(enabled.pin?.previousCommit).toBe(first)
        expect((yield* api.GoBackPlugin({ ...target, expectedRevision: enabled.revision })).ok).toBe(true)
        const restored = yield* api.GetPlugin(target)
        expect(restored.pin?.commit).toBe(first)
        expect(restored.pin?.previousCommit).toBe(second)
        expect(restored.versions.map((v) => v.commit)).toContain(second)
        yield* writer.SetPluginData({
          userId: user.id,
          owner: "",
          pluginId: target.id,
          key: "saved",
          value: "synthetic",
          revision: 0
        })
        expect((yield* api.GetPlugin(target)).data).toEqual([{ key: "saved", bytes: 11 }])
        yield* api.DeletePluginData(target)
        expect((yield* api.GetPlugin(target)).pin?.suspended).toBeUndefined()
        expect(yield* reader.PluginDataInfo({ userId: user.id, owner: "", pluginId: target.id })).toEqual([])
        const bad = yield* api.CommitPlugin({
          ...target,
          files: files(target.id, 'const n: number = "bad"; export const activate = () => {}'),
          message: "Broken version"
        })
        const failed = yield* api.EnablePlugin({ ...target, commit: bad, consent: true })
        expect(failed).toMatchObject({ ok: false, step: "types", commit: bad })
        expect((yield* api.GetPlugin(target)).report).toMatchObject({ ok: false, commit: bad })
        expect((yield* api.GetPlugin(target)).pin?.commit).toBe(first)
        // A previous enabled version must pass the current checks, even during immediate recovery.
        yield* Effect.promise(() => checkoutCommit(config.dataDir, "", target.id, first))
        const pins = yield* reader.GetPluginPins({ userId: user.id, owner: "" })
        yield* writer.SetPluginPins({
          userId: user.id,
          owner: "",
          revision: pins.revision,
          value: {
            ...pins.value,
            [target.id]: { ...pins.value[target.id]!, previousCommit: bad }
          }
        })
        const latest = yield* api.GetPlugin(target)
        expect((yield* api.GoBackPlugin({ ...target, expectedRevision: latest.revision })).ok).toBe(false)
        expect((yield* api.GetPlugin(target)).pin?.suspended).toBeDefined()
        yield* Effect.promise(() => rm(pluginFolder(config.dataDir, "", target.id), { recursive: true }))
        expect((yield* api.ListPlugins()).find((plugin) => plugin.id === target.id)?.pin?.suspended).toBeDefined()
        expect((yield* api.GetPlugin(target)).versions).toEqual([])
      })
    ).pipe(Effect.provide(serverLayer(config)))
  )
}, 120_000)

it("never takes consent metadata from a changed working copy", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client(),
          target = { scope: "instance" as const, id: "changed-surfaces" }
        const first = yield* api.CreatePlugin({ ...target, files: files(target.id) })
        const next = yield* api.CommitPlugin({
          ...target,
          files: files(
            target.id,
            'import {Effect} from "@rp/plugin-api/server"; export const activate = () => Effect.void',
            true
          ),
          message: "Adds server code"
        })
        const detail = yield* api.GetPlugin(target)
        expect(detail.versions.find((v) => v.commit === first)?.manifest?.server).toBeNull()
        expect(detail.versions.find((v) => v.commit === next)?.manifest?.server).toBe("server.ts")
        expect((yield* api.EnablePlugin({ ...target, commit: first, consent: true })).ok).toBe(false)
      })
    ).pipe(Effect.provide(serverLayer(config)))
  )
}, 60_000)

it("enforces every management RPC directly and permits only a regular account's own browser recovery", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* client(),
          admin = yield* local.Whoami(),
          writer = yield* Writer
        yield* local.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "synthetic-admin-password" })
        const adminApi = yield* client({ cookie: (yield* login(admin.handle, "synthetic-admin-password")).cookie })
        const user = yield* adminApi.CreateUser({
          handle: "plugins-user",
          displayName: "Plugins user",
          role: "user",
          password: "synthetic-user-password"
        })
        const own = yield* Effect.promise(() =>
          saveFiles(config.dataDir, user.id, "owned-client", files("owned-client"), true, "Own client")
        )
        yield* Effect.promise(() =>
          saveFiles(
            config.dataDir,
            user.id,
            "owned-server",
            files("owned-server", "export const activate = () => {}", true),
            true,
            "Own invalid server"
          )
        )
        const privateCommit = yield* adminApi.CreatePlugin({
          scope: "user",
          id: "private-admin",
          files: files("private-admin")
        })
        const userApi = yield* client({ cookie: (yield* login("plugins-user", "synthetic-user-password")).cookie })
        for (const target of [
          { scope: "instance" as const, id: "shared" },
          { scope: "user" as const, id: "owned-server" }
        ]) {
          const results = yield* Effect.all([
            userApi.CreatePlugin({ ...target, files: {} }).pipe(Effect.exit),
            userApi.CommitPlugin({ ...target, files: {}, message: "no" }).pipe(Effect.exit),
            userApi.CheckPlugin({ ...target, commit: own }).pipe(Effect.exit),
            userApi.EnablePlugin({ ...target, commit: own, consent: true }).pipe(Effect.exit),
            userApi.PinPluginCommit({ ...target, commit: own, consent: true }).pipe(Effect.exit),
            userApi.GoBackPlugin({ ...target, expectedRevision: 0 }).pipe(Effect.exit),
            userApi.DisablePlugin(target).pipe(Effect.exit),
            userApi.DeletePluginData(target).pipe(Effect.exit)
          ])
          expect(results.every((result) => result._tag === "Failure")).toBe(true)
        }
        yield* writer.SetPluginPins({
          userId: admin.id,
          owner: user.id,
          revision: 0,
          value: { "owned-client": { commit: own, enabledAt: 1, enabledBy: admin.id } }
        })
        yield* writer.SetPluginData({
          userId: user.id,
          owner: user.id,
          pluginId: "owned-client",
          key: "saved",
          value: true,
          revision: 0
        })
        const foreign = { scope: "user" as const, id: "private-admin", owner: admin.id }
        expect((yield* userApi.GetPlugin(foreign)).commit).toBeNull()
        expect((yield* userApi.GetPlugin(foreign)).versions).toEqual([])
        expect((yield* userApi.PluginLog(foreign).pipe(Effect.exit))._tag).toBe("Failure")
        expect(
          (yield* userApi.PluginDiff({ ...foreign, before: privateCommit, after: privateCommit }).pipe(Effect.exit))
            ._tag
        ).toBe("Failure")
        yield* userApi.DisablePlugin({ scope: "user", id: "owned-client" })
        yield* userApi.DeletePluginData({ scope: "user", id: "owned-client" })
        expect((yield* userApi.GetPlugin({ scope: "user", id: "owned-client" })).data).toEqual([])
        expect((yield* adminApi.GetPlugin({ scope: "user", id: "private-admin" })).commit).toBe(privateCommit)
      })
    ).pipe(Effect.provide(serverLayer(config)))
  )
}, 60_000)
