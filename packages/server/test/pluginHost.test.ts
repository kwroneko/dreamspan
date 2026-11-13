import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, it, describe } from "vitest"
import { Effect } from "effect"
import { checkPlugin } from "../src/plugins/check.ts"
import { pluginFolder, saveFiles } from "../src/plugins/repo.ts"
import { runPluginChild } from "../src/plugins/process.ts"
import { client, login, serverLayer, testConfig } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"

const fixture = (id: string, source: string, options: Record<string, unknown> = {}) => ({
  "rp-plugin.json": JSON.stringify({
    id,
    name: "Synthetic plugin",
    api: 1,
    server: "index.ts",
    worker: null,
    client: null,
    surfaces: [],
    overrides: [],
    replaces: [],
    network: false,
    base: null,
    ...options
  }),
  "index.ts": source
})
const empty =
  'import { Effect, type Activate } from "@rp/plugin-api/server"; export const activate: Activate = () => Effect.void;'
it("checks a synthetic plugin and rejects type, import, activation, undeclared access and changed-tree attacks", async () => {
  const data = tempDir("plugin-check")
  const good = await saveFiles(data, "", "tiny", fixture("tiny", empty), true, "Initial")
  expect(await checkPlugin(data, "", "tiny", good)).toMatchObject({ ok: true, step: "ready" })
  const attacks = [
    ["types", 'const n: number = "wrong"; ' + empty],
    ["probe", 'throw new Error("synthetic-secret"); ' + empty],
    [
      "probe",
      'import { Effect, type Activate } from "@rp/plugin-api/server"; export const activate: Activate = () => Effect.sync(() => {throw new Error("synthetic-secret")});'
    ],
    [
      "probe",
      'import { Effect, type Activate } from "@rp/plugin-api/server"; export const activate: Activate = (host) => host.registries.commands!.disable("unknown");'
    ],
    [
      "probe",
      'import { Effect, type Activate } from "@rp/plugin-api/server"; export const activate: Activate = () => Effect.never;'
    ],
    ["types", 'import fs from "node:fs"; ' + empty]
  ] as const
  for (const [index, [step, source]] of attacks.entries()) {
    const id = `attack-${index}`,
      commit = await saveFiles(data, "", id, fixture(id, source), true, "Synthetic attack")
    const report = await checkPlugin(data, "", id, commit)
    expect(report, `attack ${index}`).toMatchObject({ ok: false, step })
    expect(JSON.stringify(report)).not.toContain("synthetic-secret")
  }
  await writeFile(join(pluginFolder(data, "", "tiny"), "index.ts"), empty + "// changed")
  expect(await checkPlugin(data, "", "tiny", good)).toMatchObject({ ok: false, step: "snapshot" })
}, 180_000)
it("checks worker activation and refuses a non-instance server entry", async () => {
  const data = tempDir("plugin-worker-check")
  const files = fixture(
    "worker-demo",
    'import {Effect, Schema, type Activate} from "@rp/plugin-api/worker"; export const activate: Activate = host => host.registries.stateKeys!.register({id:"worker-demo/flag",value:Schema.Boolean,ids:{ids:{}},scope:"branch"});',
    { server: null, worker: "index.ts", surfaces: ["worker:stateKeys"] }
  )
  const commit = await saveFiles(data, "", "worker-demo", files, true, "Initial")
  expect(await checkPlugin(data, "", "worker-demo", commit)).toMatchObject({ ok: true })
  const user = await saveFiles(data, "synthetic-user", "private", fixture("private", empty), true, "Initial")
  expect(await checkPlugin(data, "synthetic-user", "private", user)).toMatchObject({ ok: false, step: "manifest" })
}, 60_000)
it("kills only its own hanging and memory-exhausting check children", async () => {
  const data = tempDir("plugin-child")
  const hang = join(data, "hang.mjs"),
    memory = join(data, "memory.mjs")
  await writeFile(hang, "while(true) {}")
  await writeFile(memory, "const keep=[];while(true) keep.push(new Array(100000).fill('synthetic'))")
  expect((await runPluginChild(new URL(`file://${hang}`), [], { timeout: 500, memory: 32 })).ok).toBe(false)
  expect((await runPluginChild(new URL(`file://${memory}`), [], { timeout: 5000, memory: 32 })).ok).toBe(false)
  expect((await runPluginChild(new URL(`file://${hang}`), [], { timeout: 200, memory: 32 })).ok).toBe(false)
}, 15_000)
it("survives SIGKILL between file publication and the settings write without enabling anything", async () => {
  const data = tempDir("plugin-kill"),
    script = join(data, "prepare.mjs")
  const files = fixture("crash-demo", empty)
  const repo = new URL("../src/plugins/repo.ts", import.meta.url).href
  await writeFile(
    script,
    `import { saveFiles } from ${JSON.stringify(repo)}; const commit=await saveFiles(${JSON.stringify(data)},"","crash-demo",${JSON.stringify(files)},true,"Initial"); const { checkPlugin } = await import(${JSON.stringify(new URL("../src/plugins/check.ts", import.meta.url).href)}); const report=await checkPlugin(${JSON.stringify(data)},"","crash-demo",commit); if(!report.ok) throw new Error("Check failed"); console.log("FILES_READY"); setInterval(()=>{},1000);`
  )
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"], env: {} })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("No preparation marker"))
    }, 30_000)
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("FILES_READY")) child.kill("SIGKILL")
    })
    child.once("error", reject)
    child.once("close", (_code, signal) => {
      clearTimeout(timer)
      if (signal === "SIGKILL") resolve()
      else reject(new Error("Unexpected child exit"))
    })
  })
  const config = testConfig({ dataDir: data })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        expect((yield* api.GetPlugin({ scope: "instance", id: "crash-demo" })).pin).toBeNull()
        expect(yield* api.ListClientPlugins()).toEqual([])
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 45_000)
describe("plugin lifecycle", () => {
  it("enables explicitly, restores scoped entries, and keeps startup healthy when a pinned tree changes", async () => {
    const data = tempDir("plugin-lifecycle"),
      config = testConfig({ dataDir: data })
    let commit = ""
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* client()
          commit = yield* api.CreatePlugin({ scope: "instance", id: "lifecycle", files: fixture("lifecycle", empty) })
          expect((yield* api.GetPlugin({ scope: "instance", id: "lifecycle" })).pin).toBeNull()
          expect(yield* api.EnablePlugin({ scope: "instance", id: "lifecycle", commit, consent: true })).toMatchObject({
            ok: true
          })
          expect((yield* api.GetPlugin({ scope: "instance", id: "lifecycle" })).pin?.commit).toBe(commit)
        }).pipe(Effect.provide(serverLayer(config)))
      )
    )
    await writeFile(join(pluginFolder(data, "", "lifecycle"), "index.ts"), "throw new Error('synthetic-secret')")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* client()
          const plugin = yield* api.GetPlugin({ scope: "instance", id: "lifecycle" })
          expect(plugin.pin?.suspended).toBeDefined()
          expect(plugin.report?.ok).toBe(false)
          expect(JSON.stringify(plugin)).not.toContain("synthetic-secret")
          expect(yield* api.ListClientPlugins()).toEqual([])
        }).pipe(Effect.provide(serverLayer(config)))
      )
    )
    expect(await readFile(join(pluginFolder(data, "", "lifecycle"), "index.ts"), "utf8")).toContain("throw")
    await mkdir(join(data, "plugins/.builds"), { recursive: true })
  }, 90_000)
})

for (const workers of ["source", "bundle"] as const)
  it(`installs tool and worker registries, then removes them in ${workers} workers`, async () => {
    const config = testConfig({ dbWorkers: workers })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* client(),
            user = yield* api.Whoami()
          const { Reader, Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
          const { ExecutionRegistry } = yield* Effect.promise(() => import("../src/execution.ts"))
          const reader = yield* Reader,
            writer = yield* Writer,
            execution = yield* ExecutionRegistry
          const files = {
            ...fixture(
              "integrated",
              'import {Effect,type Activate} from "@rp/plugin-api/server"; export const activate: Activate = host => host.registries.rolloutTools!.register({id:"synthetic_tool",label:"Synthetic",description:"Synthetic read",effect:"read",parameters:{type:"object",properties:{}},execute:()=>Effect.succeed({text:"synthetic result"})});',
              {
                worker: "worker.ts",
                surfaces: ["server:rolloutTools", "worker:stateKeys", "worker:macros", "worker:projections"]
              }
            ),
            "worker.ts":
              'import {Effect,Schema,registerMacro,type Activate} from "@rp/plugin-api/worker"; export const activate: Activate = host => Effect.gen(function*(){yield* host.registries.stateKeys!.register({id:"integrated/flag",value:Schema.Boolean,ids:{ids:{}},scope:"branch"});yield* registerMacro(host.registries.macros!,{kind:"value",name:"synthetic",handler:()=>"Hello"});yield* host.registries.projections!.register({id:"integrated/roles",label:"Synthetic roles",role:()=>"user"});});'
          }
          const commit = yield* api.CreatePlugin({ scope: "instance", id: "integrated", files })
          const report = yield* api.EnablePlugin({ scope: "instance", id: "integrated", commit, consent: true })
          expect(report, JSON.stringify(report)).toMatchObject({ ok: true })
          expect(execution.rolloutTools.get("synthetic_tool")).toBeDefined()
          expect((yield* reader.RoleProjections()).some((p) => p.id === "integrated/roles")).toBe(true)
          const chat = yield* writer.CreateChat({
            userId: user.id,
            kind: "rp",
            status: "active",
            title: "Synthetic",
            participants: [],
            greeting: null
          })
          yield* writer.AddStateEvent({
            userId: user.id,
            chatId: chat.id,
            forkId: chat.currentForkId,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "integrated/flag", value: true } as never
          })
          const { foldState } = yield* Effect.promise(() => import("@rp/shared/state.ts"))
          expect(
            foldState(
              yield* reader.StateEventsAt({
                userId: user.id,
                chatId: chat.id,
                forkId: chat.currentForkId,
                slotId: null
              })
            ).plugin?.["integrated/flag"]
          ).toBe(true)
          yield* api.DisablePlugin({ scope: "instance", id: "integrated" })
          expect(execution.rolloutTools.get("synthetic_tool")).toBeUndefined()
          expect((yield* reader.RoleProjections()).some((p) => p.id === "integrated/roles")).toBe(false)
          expect((yield* api.GetPlugin({ scope: "instance", id: "integrated" })).pin?.suspended).toBeDefined()
        }).pipe(Effect.provide(serverLayer(config)))
      )
    )
  }, 60_000)

it("rejects probe writes outside its folder and runs only bundled, vendored plugin tests", async () => {
  const data = tempDir("plugin-probe-write"),
    outside = join(data, "outside")
  const source = `import {Effect,type Activate} from "@rp/plugin-api/server"; const fs = await Function('return import("node:fs")')(); fs.writeFileSync(${JSON.stringify(outside)},"denied"); export const activate: Activate = () => Effect.void;`
  const commit = await saveFiles(
    data,
    "",
    "probe-write",
    fixture("probe-write", source),
    true,
    "Synthetic denied write"
  )
  expect(await checkPlugin(data, "", "probe-write", commit)).toMatchObject({ ok: false, step: "probe" })
  await expect(readFile(outside)).rejects.toThrow()
  const files = {
    ...fixture("tested", empty),
    "test/example.test.ts":
      'import {test} from "node:test"; import assert from "node:assert/strict"; test("synthetic",()=>assert.equal(1+1,2));'
  }
  const tested = await saveFiles(data, "", "tested", files, true, "Tests")
  expect(await checkPlugin(data, "", "tested", tested)).toMatchObject({ ok: true })
}, 60_000)

it("suspends a throwing registered tool and bounds a nonreturning asynchronous handler", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        const { ExecutionRegistry } = yield* Effect.promise(() => import("../src/execution.ts"))
        const execution = yield* ExecutionRegistry
        const source =
          'import {Effect,type Activate} from "@rp/plugin-api/server"; export const activate: Activate = host => host.registries.rolloutTools!.register({id:"synthetic_failure",label:"Synthetic",description:"Synthetic read",effect:"read",parameters:{type:"object",properties:{}},execute:()=>Effect.die(new Error("synthetic-secret"))});'
        const commit = yield* api.CreatePlugin({
          scope: "instance",
          id: "handler-fault",
          files: fixture("handler-fault", source, { surfaces: ["server:rolloutTools"] })
        })
        expect(
          yield* api.EnablePlugin({ scope: "instance", id: "handler-fault", commit, consent: true })
        ).toMatchObject({ ok: true })
        const result = yield* execution.rolloutTools
          .get("synthetic_failure")!
          .execute({} as never, {} as never)
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        yield* Effect.sleep(100)
        const view = yield* api.GetPlugin({ scope: "instance", id: "handler-fault" })
        expect(view.pin?.suspended).toBeDefined()
        expect(JSON.stringify(view.report)).not.toContain("synthetic-secret")
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
  const { declaredHandles } = await import("../src/plugins/handles.ts")
  const { makeRegistry } = await import("@rp/shared/registry.ts")
  const { Scope, Exit } = await import("effect")
  const registry = makeRegistry<{ id: string; run: () => Effect.Effect<never> }>(),
    scope = Effect.runSync(Scope.make())
  let failed = false
  const handles = declaredHandles(
    {
      id: "bounded",
      name: "Bounded",
      api: 1,
      server: "index.ts",
      worker: null,
      client: null,
      surfaces: ["server:commands"],
      overrides: [],
      replaces: [],
      network: false,
      base: null
    },
    "server",
    { commands: registry },
    scope,
    new Map(),
    () => {
      failed = true
    }
  ) as { commands: { register: (entry: { id: string; run: () => Effect.Effect<never> }) => Effect.Effect<void> } }
  await Effect.runPromise(handles.commands.register({ id: "never", run: () => Effect.never }))
  await expect(Effect.runPromise(registry.get("never")!.run())).rejects.toThrow("Plugin handler failed")
  expect(failed).toBe(true)
  await Effect.runPromise(Scope.close(scope, Exit.void))
}, 45_000)

it("uses app-stamped checked artifacts and rechecks a changed build", async () => {
  const data = tempDir("plugin-cache"),
    commit = await saveFiles(data, "", "cached", fixture("cached", empty), true, "Initial")
  expect(await checkPlugin(data, "", "cached", commit)).toMatchObject({ ok: true, cached: false })
  expect(await checkPlugin(data, "", "cached", commit)).toMatchObject({ ok: true, cached: true })
  await writeFile(
    join(data, "plugins/.builds/instance/cached", commit, "server.mjs"),
    "throw new Error('changed build')"
  )
  expect(await checkPlugin(data, "", "cached", commit)).toMatchObject({ ok: true, cached: false })
}, 60_000)

it("suspends a worker callback failure and keeps the server available", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client(),
          user = yield* api.Whoami()
        const { Reader, Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
        const reader = yield* Reader,
          writer = yield* Writer
        const source =
          'import {Effect,Schema,type Activate} from "@rp/plugin-api/worker"; export const activate: Activate = host => host.registries.stateKeys!.register({id:"worker-fault/flag",value:Schema.Boolean,ids:{ids:{}},scope:"branch",reduce:()=>{throw new Error("synthetic-secret")}});'
        const commit = yield* api.CreatePlugin({
          scope: "instance",
          id: "worker-fault",
          files: fixture("worker-fault", source, { server: null, worker: "index.ts", surfaces: ["worker:stateKeys"] })
        })
        expect(yield* api.EnablePlugin({ scope: "instance", id: "worker-fault", commit, consent: true })).toMatchObject(
          { ok: true }
        )
        const chat = yield* writer.CreateChat({
          userId: user.id,
          kind: "rp",
          status: "active",
          title: "Synthetic fault",
          participants: [],
          greeting: null
        })
        yield* writer.AddStateEvent({
          userId: user.id,
          chatId: chat.id,
          forkId: chat.currentForkId,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "worker-fault/flag", value: true } as never
        })
        expect(
          (yield* reader
            .LcmSettingsAt({ userId: user.id, chatId: chat.id, forkId: chat.currentForkId, leafSlotId: null })
            .pipe(Effect.exit))._tag
        ).toBe("Failure")
        yield* Effect.sleep(100)
        const view = yield* api.GetPlugin({ scope: "instance", id: "worker-fault" })
        expect(view.pin?.suspended).toBeDefined()
        expect(JSON.stringify(view.report)).not.toContain("synthetic-secret")
        expect((yield* api.Whoami()).id).toBe(user.id)
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 60_000)

it("PLUGINS=off suppresses activation and client descriptors without erasing pins", async () => {
  const data = tempDir("plugin-off"),
    config = testConfig({ dataDir: data })
  let commit = ""
  const source =
    'import {Effect,type Activate} from "@rp/plugin-api/server"; export const activate: Activate = host => host.registries.rolloutTools!.register({id:"synthetic_off",label:"Synthetic",description:"Synthetic",effect:"read",parameters:{type:"object",properties:{}},execute:()=>Effect.succeed({text:"off"})});'
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        commit = yield* api.CreatePlugin({
          scope: "instance",
          id: "safe-start",
          files: {
            ...fixture("safe-start", source, { client: "client.ts", surfaces: ["server:rolloutTools"] }),
            "client.ts": "export const activate = () => undefined"
          }
        })
        expect(yield* api.EnablePlugin({ scope: "instance", id: "safe-start", commit, consent: true })).toMatchObject({
          ok: true
        })
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* client()
        const { ExecutionRegistry } = yield* Effect.promise(() => import("../src/execution.ts"))
        expect((yield* ExecutionRegistry).rolloutTools.get("synthetic_off")).toBeUndefined()
        expect(yield* api.ListClientPlugins()).toEqual([])
        expect((yield* api.GetPlugin({ scope: "instance", id: "safe-start" })).pin?.commit).toBe(commit)
        expect(
          (yield* api.EnablePlugin({ scope: "instance", id: "safe-start", commit, consent: true }).pipe(Effect.exit))
            ._tag
        ).toBe("Failure")
      }).pipe(Effect.provide(serverLayer({ ...config, plugins: false })))
    )
  )
}, 60_000)

it("isolates every user-scoped read and data RPC in both directions, including an admin", async () => {
  const config = testConfig()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* client(),
          alice = yield* local.Whoami()
        yield* local.SetPassword({ userId: alice.id, currentPassword: null, newPassword: "synthetic-alice-password" })
        const aliceApi = yield* client({ cookie: (yield* login(alice.handle, "synthetic-alice-password")).cookie })
        yield* aliceApi.CreateUser({
          handle: "synthetic-bob",
          displayName: "Synthetic Bob",
          role: "user",
          password: "synthetic-bob-password"
        })
        const bobApi = yield* client({ cookie: (yield* login("synthetic-bob", "synthetic-bob-password")).cookie }),
          bob = yield* bobApi.Whoami()
        const { Reader, Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
        const reader = yield* Reader,
          writer = yield* Writer
        const parties = [
          { api: aliceApi, user: alice, id: "alice-private" },
          { api: bobApi, user: bob, id: "bob-private" }
        ]
        const commits: Record<string, string> = {}
        for (const party of parties) {
          const commit = yield* Effect.promise(() =>
            saveFiles(
              config.dataDir,
              party.user.id,
              party.id,
              {
                ...fixture(party.id, "export const unused = true", { server: null, client: "client.ts" }),
                "client.ts": "export const activate = () => undefined"
              },
              true,
              "Synthetic private plugin"
            )
          )
          commits[party.id] = commit
          // Trusted synthetic setup: the public management RPCs still require an admin.
          yield* writer.SetPluginPins({
            userId: party.user.id,
            owner: party.user.id,
            revision: 0,
            value: { [party.id]: { commit, enabledAt: 0, enabledBy: alice.id } }
          })
          yield* writer.SetPluginData({
            userId: party.user.id,
            owner: party.user.id,
            pluginId: party.id,
            key: "private",
            value: party.id,
            revision: 0
          })
        }
        for (const [index, party] of parties.entries()) {
          const other = parties[1 - index]!
          expect((yield* party.api.ListPlugins()).map((p) => p.id)).toEqual([party.id])
          expect((yield* party.api.ListClientPlugins()).map((p) => p.id)).toEqual([party.id])
          expect(yield* party.api.GetPlugin({ scope: "user", id: other.id })).toMatchObject({
            commit: null,
            manifest: null,
            pin: null,
            report: null
          })
          expect((yield* party.api.PluginLog({ scope: "user", id: other.id }).pipe(Effect.exit))._tag).toBe("Failure")
          expect(
            (yield* party.api
              .PluginDiff({ scope: "user", id: other.id, before: commits[other.id]!, after: commits[other.id]! })
              .pipe(Effect.exit))._tag
          ).toBe("Failure")
          yield* party.api.DisablePlugin({ scope: "user", id: other.id })
          yield* party.api.DeletePluginData({ scope: "user", id: other.id })
          expect((yield* other.api.GetPlugin({ scope: "user", id: other.id })).pin?.suspended).toBeUndefined()
          expect(
            (yield* reader.GetPluginData({
              userId: other.user.id,
              owner: other.user.id,
              pluginId: other.id,
              key: "private"
            }))?.value
          ).toBe(other.id)
        }
        yield* bobApi.DisablePlugin({ scope: "user", id: "bob-private" })
        expect(yield* bobApi.ListClientPlugins()).toEqual([])
        yield* bobApi.DeletePluginData({ scope: "user", id: "bob-private" })
        expect(
          yield* reader.GetPluginData({ userId: bob.id, owner: bob.id, pluginId: "bob-private", key: "private" })
        ).toBeNull()
      }).pipe(Effect.provide(serverLayer(config)))
    )
  )
}, 60_000)
