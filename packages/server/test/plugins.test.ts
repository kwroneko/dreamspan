import { expect, describe, it } from "vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { writeFile, symlink, mkdir, readFile } from "node:fs/promises"
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
      '[core]\n hooksPath = hooks\n fsmonitor = "touch SHOULD_NOT_EXIST"\n[filter "evil"]\n clean = "touch SHOULD_NOT_EXIST"\n smudge = "touch SHOULD_NOT_EXIST"\n'
    )
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
  const registry = makeRegistry([{ id: "core", value: { text: "original" } }]),
    claims = new Map<string, string>()
  const scope = Effect.runSync(Scope.make())
  const entry = { id: "added", value: { text: "first" } }
  const a = declaredHandles(
    { ...manifest(), surfaces: ["server:macros"], replaces: ["macros:core"] },
    "server",
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
  await Effect.runPromise(Scope.provide(a.macros.disable("core"), scope))
  const bscope = Effect.runSync(Scope.make())
  const b = declaredHandles(
    { ...manifest("other"), surfaces: ["server:macros"], replaces: ["macros:added"] },
    "server",
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
  expect(registry.get("core")?.value.text).toBe("original")
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
