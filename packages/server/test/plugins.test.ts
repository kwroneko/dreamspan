import { expect, describe, it } from "vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { writeFile, symlink, link, mkdir, readFile, truncate } from "node:fs/promises"
import { join } from "node:path"
import { makeRegistry } from "@rp/shared/registry.ts"
import { PluginManifest } from "@rp/shared/plugins.ts"
import { declaredHandles, pluginArguments } from "../src/plugins/handles.ts"
import { commitFiles, diskFiles, limits, pluginFolder, saveFiles, snapshot, validPath } from "../src/plugins/repo.ts"
import { tempDir } from "./support/tempDir.ts"

const manifest = (id = "tiny") => ({
  id,
  name: "Synthetic",
  api: 1 as const,
  server: "index.ts",
  worker: null,
  client: null,
  surfaces: [],
  replaces: [],
  overrides: [],
  base: null,
  network: false
})
describe("plugin source confinement", () => {
  for (const path of ["../escape", "/absolute.ts", "a/../../x", "a\\x", "C:/x", "a/.git/config", "a/./x"])
    it(`refuses ${path}`, () => expect(() => validPath(path)).toThrow())
  it("validates entry paths before code is considered", () => {
    for (const path of ["../escape.ts", "/outside.ts", "a/../../outside.ts"])
      expect(Schema.is(PluginManifest)({ ...manifest(), server: path })).toBe(false)
  })
  it("never executes package scripts or Git hooks/config; snapshots exactly the committed tree", async () => {
    const dir = tempDir("plugin-git"),
      folder = pluginFolder(dir, "", "tiny")
    const files = {
      "rp-plugin.json": JSON.stringify(manifest()),
      "index.ts": "export const activate = () => undefined",
      "package.json": JSON.stringify({
        scripts: { install: "touch SHOULD_NOT_EXIST", prepare: "touch SHOULD_NOT_EXIST" }
      })
    }
    const first = await saveFiles(dir, "", "tiny", files, true, "Initial")
    await mkdir(join(folder, ".git/hooks"), { recursive: true })
    await writeFile(join(folder, ".git/hooks/pre-commit"), "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n", { mode: 0o755 })
    await writeFile(
      join(folder, ".git/config"),
      '[core]\n hooksPath = hooks\n fsmonitor = "touch SHOULD_NOT_EXIST"\n sshCommand = "touch SHOULD_NOT_EXIST"\n[includeIf "gitdir:*"]\n path = /unreadable-synthetic-include\n[filter "evil"]\n clean = "touch SHOULD_NOT_EXIST"\n smudge = "touch SHOULD_NOT_EXIST"\n'
    )
    await mkdir(join(folder, ".git/objects/info"), { recursive: true })
    await writeFile(join(folder, ".git/objects/info/alternates"), "/unreadable-synthetic-objects\n")
    const second = await saveFiles(dir, "", "tiny", { "index.ts": "// changed" }, false, "Changed")
    expect(first).not.toBe(second)
    expect([...(await diskFiles(folder))].map(([name]) => name)).not.toContain("SHOULD_NOT_EXIST")
    const build = join(dir, "plugins/.builds/test")
    expect((await snapshot(dir, "", "tiny", second, build)).id).toBe("tiny")
    expect(await readFile(join(build, "index.ts"), "utf8")).toBe("// changed")
    await writeFile(join(folder, "index.ts"), "// uncommitted")
    await expect(snapshot(dir, "", "tiny", second, join(dir, "plugins/.builds/changed"))).rejects.toThrow("differs")
    expect((await commitFiles(folder, second)).has("package.json")).toBe(true)
  })
  it("refuses symlinks, oversized files and submodules", async () => {
    const dir = tempDir("plugin-paths"),
      folder = pluginFolder(dir, "", "tiny")
    await saveFiles(dir, "", "tiny", { "index.ts": "" }, true, "Initial")
    await symlink(join(dir, "outside"), join(folder, "escape"))
    await expect(diskFiles(folder)).rejects.toThrow("symbolic")
    const huge = tempDir("plugin-huge")
    await writeFile(join(huge, "huge"), Buffer.alloc(limits.file + 1))
    await expect(diskFiles(huge)).rejects.toThrow("size")
    const modules = tempDir("plugin-submodules")
    await writeFile(join(modules, ".gitmodules"), "[submodule evil]")
    await expect(diskFiles(modules)).rejects.toThrow("submodules")
  })
})
it("gives frozen declared handles, owns registrations and restores core entries", async () => {
  const registry = makeRegistry([{ id: "reverse", value: { text: "original" } }]),
    claims = new Map<string, string>()
  const scope = Effect.runSync(Scope.make())
  const entry = { id: "added", value: { text: "first" } }
  const a = declaredHandles(
    { ...manifest(), surfaces: ["worker:macros"], replaces: ["macros:reverse"] },
    "worker",
    { macros: registry },
    scope,
    claims,
    () => undefined
  ) as { macros: typeof registry }
  expect(Object.isFrozen(a)).toBe(true)
  expect((a as Record<string, unknown>).commands).toBeUndefined()
  await Effect.runPromise(Scope.provide(a.macros.register(entry), scope))
  entry.value.text = "mutated"
  expect(registry.get("added")?.value.text).toBe("first")
  expect(a.macros.get("added")).toEqual({ id: "added" })
  await Effect.runPromise(Scope.provide(a.macros.disable("reverse"), scope))
  const bscope = Effect.runSync(Scope.make())
  const b = declaredHandles(
    { ...manifest("other"), surfaces: ["worker:macros"], replaces: ["macros:added"] },
    "worker",
    { macros: registry },
    bscope,
    claims,
    () => undefined
  ) as { macros: typeof registry }
  await expect(
    Effect.runPromise(Scope.provide(b.macros.register({ id: "added", value: { text: "other" } }), bscope))
  ).rejects.toThrow()
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await Effect.runPromise(Scope.close(bscope, Exit.void))
  expect(registry.get("reverse")?.value.text).toBe("original")
  expect(registry.get("added")).toBeUndefined()
})
it("does not pass live clients, credentials, env or another plugin's objects to handlers", () => {
  const original = {
    userId: "actor",
    reader: { GetConnectionSecret: () => "secret" },
    writer: {},
    apiKey: "synthetic-secret",
    env: { SECRET_KEY: "secret" },
    headers: { authorization: "secret" },
    nested: { token: "secret", safe: "ok" }
  }
  const cleaned = pluginArguments(original) as { nested: { safe: string } }
  expect(JSON.stringify(cleaned)).not.toContain("secret")
  expect(Object.isFrozen(cleaned.nested)).toBe(true)
  expect(original.nested.token).toBe("secret")
})
it("contains throwing handlers without exposing their errors", async () => {
  const registry = makeRegistry<{ id: string; run: () => unknown }>(),
    scope = Effect.runSync(Scope.make())
  let failed = false
  const handles = declaredHandles(
    { ...manifest(), surfaces: ["server:macros"] },
    "server",
    { macros: registry },
    scope,
    new Map(),
    () => {
      failed = true
    }
  ) as { macros: typeof registry }
  await Effect.runPromise(
    Scope.provide(
      handles.macros.register({
        id: "bad",
        run: () => {
          throw new Error("synthetic-secret")
        }
      }),
      scope
    )
  )
  expect(() => registry.get("bad")!.run()).toThrow("Plugin handler failed")
  expect(failed).toBe(true)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

it("removes ambient Effect services from registered callbacks", async () => {
  const { Context } = await import("effect")
  const Secret = Context.Service<{ secret: string }>("synthetic/Secret")
  const registry = makeRegistry<{ id: string; run: () => Effect.Effect<boolean> }>(),
    scope = Effect.runSync(Scope.make())
  const handles = declaredHandles(
    { ...manifest(), surfaces: ["server:commands"] },
    "server",
    { commands: registry },
    scope,
    new Map(),
    () => undefined
  ) as { commands: { register: (entry: { id: string; run: () => Effect.Effect<boolean> }) => Effect.Effect<void> } }
  await Effect.runPromise(
    handles.commands.register({
      id: "context",
      run: () => Effect.contextWith((context) => Effect.succeed(context.mapUnsafe.has("synthetic/Secret")))
    })
  )
  expect(
    await Effect.runPromise(
      registry
        .get("context")!
        .run()
        .pipe(Effect.provideService(Secret, { secret: "synthetic-secret" }))
    )
  ).toBe(false)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

it("detaches arrays, cycles and standalone callable arguments", () => {
  const rows: unknown[] = [{ apiKey: "synthetic-secret", safe: "ok" }]
  rows.push(rows)
  const cleaned = pluginArguments(rows) as unknown[]
  expect(cleaned).not.toBe(rows)
  expect(cleaned[0]).toEqual({ safe: "ok" })
  expect(cleaned[1]).toBe(cleaned)
  expect(Object.isFrozen(cleaned)).toBe(true)
  expect(pluginArguments(() => "synthetic-secret")).toBeUndefined()
})

it("rejects linked files before overwriting an outside inode", async () => {
  const dir = tempDir("plugin-hardlink"),
    folder = pluginFolder(dir, "", "tiny")
  await saveFiles(dir, "", "tiny", { "index.ts": "" }, true, "Initial")
  const outside = join(dir, "synthetic-secret")
  await writeFile(outside, "keep")
  await link(outside, join(folder, "linked.ts"))
  await expect(saveFiles(dir, "", "tiny", { "linked.ts": "changed" }, false, "Edit")).rejects.toThrow()
  expect(await readFile(outside, "utf8")).toBe("keep")
  await expect(diskFiles(folder)).rejects.toThrow()
})

it("rejects portable path collisions in the working tree", async () => {
  for (const names of [
    ["A.ts", "a.ts"],
    ["é.ts", "e\u0301.ts"]
  ]) {
    const dir = tempDir("plugin-collision")
    for (const name of names) await writeFile(join(dir, name), "synthetic")
    await expect(diskFiles(dir)).rejects.toThrow()
  }
})

it("copies ast-named descriptor data and revokes retained callbacks on disable", async () => {
  const registry = makeRegistry<{ id: string; ast: unknown; run: () => unknown }>()
  const scope = Effect.runSync(Scope.make())
  const handles = declaredHandles(
    { ...manifest(), surfaces: ["server:commands"] },
    "server",
    { commands: registry },
    scope,
    new Map(),
    () => undefined
  ) as { commands: typeof registry }
  const entry = { id: "retained", ast: { text: "original" }, run: () => "ran" }
  await Effect.runPromise(Scope.provide(handles.commands.register(entry), scope))
  entry.ast.text = "mutated"
  const retained = registry.get("retained")!
  expect(retained.ast).toEqual({ text: "original" })
  await Effect.runPromise(Scope.close(scope, Exit.void))
  expect(() => retained.run()).toThrow("Plugin is disabled")
})

it("refuses provider callbacks that receive a credential as a positional string", async () => {
  const registry = makeRegistry<{ id: string; secretsOf: (key: string) => string[] }>()
  const scope = Effect.runSync(Scope.make())
  try {
    const handles = declaredHandles(
      { ...manifest(), surfaces: ["server:providerKinds"] },
      "server",
      { providerKinds: registry },
      scope,
      new Map(),
      () => undefined
    ) as { providerKinds: typeof registry }
    await expect(
      Effect.runPromise(
        Scope.provide(handles.providerKinds.register({ id: "unsafe", secretsOf: (key) => [key] }), scope)
      )
    ).rejects.toThrow()
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

it("interrupts an in-flight Effect when its plugin scope closes", async () => {
  const { Fiber } = await import("effect")
  const registry = makeRegistry<{ id: string; run: () => Effect.Effect<unknown> }>()
  const scope = Effect.runSync(Scope.make())
  const handles = declaredHandles(
    { ...manifest(), surfaces: ["server:commands"] },
    "server",
    { commands: registry },
    scope,
    new Map(),
    () => undefined
  ) as { commands: typeof registry }
  await Effect.runPromise(Scope.provide(handles.commands.register({ id: "in-flight", run: () => Effect.never }), scope))
  const fiber = Effect.runFork(registry.get("in-flight")!.run())
  await new Promise((resolve) => setTimeout(resolve, 10))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  const completed = await Promise.race([
    Effect.runPromise(Fiber.await(fiber)).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100))
  ])
  expect(completed).toBe(true)
})

it("bounds Git tree depth independently of files on disk", async () => {
  const data = tempDir("plugin-deep-tree")
  await saveFiles(data, "", "tiny", { "index.ts": "" }, true, "Initial")
  const folder = pluginFolder(data, "", "tiny")
  const git = (await import("isomorphic-git")).default
  const fs = (await import("node:fs")).default
  let oid = await git.writeTree({ fs, dir: folder, tree: [] })
  for (let depth = 0; depth < 25; depth++)
    oid = await git.writeTree({ fs, dir: folder, tree: [{ path: "dir", mode: "040000", type: "tree", oid }] })
  const commit = await git.writeCommit({
    fs,
    dir: folder,
    commit: {
      tree: oid,
      parent: [],
      author: { name: "Synthetic", email: "plugin@localhost", timestamp: 0, timezoneOffset: 0 },
      committer: { name: "Synthetic", email: "plugin@localhost", timestamp: 0, timezoneOffset: 0 },
      message: "Synthetic deep tree"
    }
  })
  await expect(commitFiles(folder, commit)).rejects.toThrow("directory limit")
})

it("contains faults and filters arguments in callbacks returned by a factory", async () => {
  const registry = makeRegistry<{ id: string; create: () => { push: (context: unknown) => unknown } }>()
  const scope = Effect.runSync(Scope.make())
  let failed = false
  try {
    const handles = declaredHandles(
      { ...manifest(), surfaces: ["server:replyParsers"] },
      "server",
      { replyParsers: registry },
      scope,
      new Map(),
      () => {
        failed = true
      }
    ) as { replyParsers: typeof registry }
    await Effect.runPromise(
      handles.replyParsers
        .register({ id: "factory", create: () => ({ push: (context) => context }) })
        .pipe(Scope.provide(scope))
    )
    expect(registry.get("factory")!.create().push({ apiKey: "synthetic-secret", safe: true })).toEqual({ safe: true })
    await Effect.runPromise(
      handles.replyParsers
        .register({
          id: "throws",
          create: () => ({
            push: () => {
              throw new Error("synthetic-secret")
            }
          })
        })
        .pipe(Scope.provide(scope))
    )
    expect(() => registry.get("throws")!.create().push({})).toThrow("Plugin handler failed")
    expect(failed).toBe(true)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

it("rejects Unicode case-fold collisions", async () => {
  const dir = tempDir("plugin-unicode-case")
  await writeFile(join(dir, "Straße.ts"), "synthetic")
  await writeFile(join(dir, "STRASSE.ts"), "synthetic")
  await expect(diskFiles(dir)).rejects.toThrow("collision")
})

it("bounds aggregate Git metadata before parsing objects", async () => {
  const data = tempDir("plugin-metadata-total")
  const commit = await saveFiles(data, "", "tiny", { "index.ts": "" }, true, "Initial")
  const folder = pluginFolder(data, "", "tiny")
  for (let index = 0; index < 5; index++) {
    const file = join(folder, ".git", `padding-${index}`)
    await writeFile(file, "")
    await truncate(file, 32 * 1024 * 1024)
  }
  await expect(commitFiles(folder, commit)).rejects.toThrow("metadata")
})
