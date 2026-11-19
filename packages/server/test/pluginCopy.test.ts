import { checkPlugin } from "../src/plugins/check.ts"
import { expect, it } from "vitest"
import { Effect, Scope, Exit } from "effect"
import { Type } from "@earendil-works/pi-ai"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { builtinReplacement, builtinCopyStem } from "@dreamspan/shared/builtinParts.ts"
import { builtinCopies, builtinCopyListing, missingBuiltinAdapter } from "../src/plugins/builtins.ts"
import { prepareBuiltinCopy, compareBuiltin, copyBuiltin } from "../src/plugins/copy.ts"
import { rewriteImports } from "../src/plugins/importPolicy.ts"
import { saveFiles, pluginFolder, commitFiles } from "../src/plugins/repo.ts"
import { tempDir } from "./support/tempDir.ts"
import { makeMacroRegistry } from "@dreamspan/shared/macros/registry.ts"
import { registerBuiltinMacros } from "@dreamspan/shared/macros/builtins.ts"
import { setPresence } from "../src/agent/tools/presence.ts"
import { presenceContext } from "../src/agent/tools/presenceAdapter.ts"
import { appSource } from "../src/plugins/reference.ts"
import { frozenTool, type ToolContext } from "../src/agent/tools.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { installPluginToolDefinitions } from "./support/pluginToolDefinitions.ts"
import { declaredHandles } from "../src/plugins/handles.ts"
import { PluginManifest } from "@dreamspan/shared/plugins.ts"
import { Schema } from "effect"
import { pluginConsent, pluginAccessGrows } from "@dreamspan/shared/pluginConsent.ts"
import { makeRegistry } from "@dreamspan/shared/registry.ts"

it("all built-in tools, including generated tools, declare shipped source; only allowlisted adapters copy", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const macros = makeMacroRegistry()
        yield* registerBuiltinMacros(macros)
        for (const macro of macros.list()) expect(macro.source, macro.id).toMatch(/^file:.*\.ts$/)
        const registry = yield* installPluginToolDefinitions
        for (const tool of registry.rolloutTools.list()) expect(tool.source, tool.id).toMatch(/^file:.*\.ts$/)
      }).pipe(Effect.provide(ExecutionRegistry.layer))
    )
  )
  await expect(prepareBuiltinCopy("replyStrategies", "default", "no-copy", tempDir("no-copy"))).rejects.toThrow(
    "adapter"
  )
})

it("every unavailable story tool refuses both declared replacement and disable", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* installPluginToolDefinitions
        const unavailable = execution.rolloutTools
          .list()
          .filter((tool) => !builtinCopies.some((part) => part.registry === "rolloutTools" && part.id === tool.id))
        // 37 was the list before sandbox1's file and command tools (read_file, list_files,
        // search_files, write_file, edit_file, bash), subagents1's agent tool, subagents5's message_agent and subagents8's
        // ask_helper arrived: they declare shipped source like every other built-in, but have no
        // copyable adapter yet.
        expect(unavailable).toHaveLength(46)
        for (const original of unavailable) {
          expect(builtinReplacement(`rolloutTools:${original.id}`)).toBeUndefined()
          const registry = makeRegistry([original])
          const handles = declaredHandles(
            {
              id: "unavailable-copy",
              name: "Unavailable copy",
              api: 1,
              server: "server.ts",
              worker: null,
              client: null,
              surfaces: ["server:rolloutTools"],
              replaces: [`rolloutTools:${original.id}`],
              overrides: [],
              network: false,
              base: null
            },
            "server",
            { rolloutTools: registry },
            yield* Effect.scope,
            new Map(),
            () => {}
          ) as { rolloutTools: typeof registry }
          expect(Exit.isFailure(yield* Effect.exit(handles.rolloutTools.register(original))), original.id).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(handles.rolloutTools.disable(original.id))), original.id).toBe(true)
          expect(registry.get(original.id)).toBe(original)
        }
      }).pipe(Effect.provide(ExecutionRegistry.layer))
    )
  ))

it.each(builtinCopies)("copies exact declared source for $registry/$id", async (part) => {
  expect(builtinCopyStem(part.id)).toMatch(/^[a-z][a-z0-9-]{0,41}$/)
  expect(builtinReplacement(`${part.registry}:${part.id}`)?.side).toBe(part.side)
  const prepared = await prepareBuiltinCopy(part.registry, part.id, "fixture-copy", tempDir("copy-source"))
  const manifest = JSON.parse(prepared.files["dreamspan-plugin.json"]!)
  const base = JSON.parse(prepared.files["builtin-base.json"]!)
  expect(manifest.replaces).toEqual([
    `${part.registry}:${part.id}`,
    ...("aliases" in part ? part.aliases.map((alias) => `${part.registry}:${alias}`) : [])
  ])
  expect(manifest.base.path).toBe(part.path)
  for (const path of part.files) expect(base.files[path]).toBe(await readFile(path, "utf8"))
  expect(manifest.base.sha256).toBe(
    createHash("sha256")
      .update(await readFile(part.path))
      .digest("hex")
  )
  expect(prepared.files["NOTICE.md"]).toContain("No third-party implementation")
  if (part.side === "client") expect(await appSource({ path: part.path })).toContain("copyable client parts")
  expect(Object.keys(prepared.files)).not.toContain(".git/rp-create")
})

it.each(builtinCopies.filter((part, index) => builtinCopies.findIndex((p) => p.path === part.path) === index))(
  "compares committed $registry base after a simulated update without merging or path authority",
  async (part) => {
    const data = tempDir("copy-update"),
      prepared = await prepareBuiltinCopy(part.registry, part.id, "updated-copy", data)
    const manifest = JSON.parse(prepared.files["dreamspan-plugin.json"]!)
    const snapshot = JSON.parse(prepared.files["builtin-base.json"]!)
    const path = manifest.base.path
    // Simulate the older shipped build in the saved base, without mutating installed sources.
    snapshot.files[path] += "\n// earlier shipped version\n"
    const sha = (s: string) => createHash("sha256").update(s).digest("hex")
    manifest.base.sha256 = sha(snapshot.files[path])
    snapshot.digest = sha(JSON.stringify(snapshot.files))
    prepared.files["dreamspan-plugin.json"] = JSON.stringify(manifest)
    prepared.files["builtin-base.json"] = JSON.stringify(snapshot)
    const commit = await saveFiles(data, "", "updated-copy", prepared.files, true, "Earlier app copy")
    const before = await commitFiles(pluginFolder(data, "", "updated-copy"), commit)
    const comparison = await compareBuiltin(data, "", "updated-copy", commit)
    expect(comparison).toMatchObject({ changed: true, available: true })
    expect(comparison!.files[0]!.before).toContain("earlier shipped")
    expect(comparison!.files[0]!.current).not.toContain("earlier shipped")
    expect(await commitFiles(pluginFolder(data, "", "updated-copy"), commit)).toEqual(before)
    // Dirty text never becomes provenance or a path authority.
    await writeFile(join(pluginFolder(data, "", "updated-copy"), "builtin-base.json"), "forged")
    expect(await compareBuiltin(data, "", "updated-copy", commit)).toEqual(comparison)
    manifest.base.path = "../../../../secret.key"
    prepared.files["dreamspan-plugin.json"] = JSON.stringify(manifest)
    const bad = await saveFiles(
      data,
      "",
      "bad-base",
      { ...prepared.files, "dreamspan-plugin.json": JSON.stringify({ ...manifest, id: "bad-base" }) },
      true,
      "Bad metadata"
    )
    expect(await compareBuiltin(data, "", "bad-base", bad)).toEqual({ changed: true, available: false, files: [] })
    await expect(
      prepareBuiltinCopy(
        "noticeChannels",
        "notifications.completion-sound",
        "data-copy",
        process.cwd() + "/packages/client/src"
      )
    ).rejects.toThrow("Data")
  }
)

it("rewrites syntax only and refuses path tricks, re-exports, type imports, dynamic imports and require", () => {
  const allowed = (s: string) =>
    s === "./helper.ts" ? s : s === "../ui/Choice.tsx" ? "@dreamspan/plugin-api/client" : undefined
  const source = `// import nope from 'node:fs'\nconst literal = "../ui/Choice.tsx"; import {Switch} from "../ui/Choice.tsx";export {x} from './helper.ts'`
  const result = rewriteImports(source, "part.tsx", allowed)
  expect(result.unsupported).toEqual([])
  expect(result.text).toContain('const literal = "../ui/Choice.tsx"')
  expect(result.text).toContain('from "@dreamspan/plugin-api/client"')
  for (const attack of [
    'import "../../../plugins/other/client.ts"',
    'export * from "node:fs"',
    'export {x} from "../chat/session.ts"',
    'type X = import("node:fs").Stats',
    'import("./helper.ts")',
    'import("node:"+"fs")',
    'require("./helper.ts")',
    'const r=require;r("node:fs")',
    'import x = require("node:fs")',
    'import "./%2e%2e/secret.ts"',
    'import "..\\\\server/secret.ts"'
  ])
    expect(rewriteImports(attack, "part.ts", allowed).unsupported.length, attack).toBeGreaterThan(0)
})

it("keeps model-visible set_presence request bytes identical to the preceding built-in", () => {
  const before = {
    ...frozenTool(setPresence as never),
    parameters: Type.Object({
      character: Type.String({ description: "The character's name." }),
      present: Type.Boolean({ description: "True when the character is in the scene." })
    })
  }
  expect(JSON.stringify(frozenTool(setPresence as never))).toBe(JSON.stringify(before))
})

it("presence access exposes only causal cast and validated ordinary presence writes", async () => {
  const calls: Array<unknown> = []
  const context = {
    userId: "owner",
    chatId: "chat",
    forkId: null,
    leafSlotId: "before",
    rolloutId: "run",
    toolCallId: "call",
    reader: {
      StateEventsAt: (args: unknown) => {
        calls.push(args)
        return Effect.succeed(
          [
            { key: "participant.join", value: { entity: "card" } },
            { key: "participant.join", value: { entity: "narrator" } },
            { key: "cast.role", value: { entity: "narrator", role: "narrator" } }
          ].map((data) => ({ data, scope: "branch" }))
        )
      },
      CastCards: () =>
        Effect.succeed([
          { entityId: "card", name: "Ada", modelName: null },
          { entityId: "narrator", name: "Narrator", modelName: null }
        ])
    },
    writer: {
      ApplyRolloutEffect: (args: unknown) => {
        calls.push(args)
        return Effect.succeed({ result: "saved" })
      }
    }
  } as unknown as ToolContext
  const access = presenceContext(context)
  expect(Object.keys(access).sort()).toEqual(["cast", "set"])
  expect((await Effect.runPromise(access.cast)).map((c) => c.id)).toEqual(["card", "narrator"])
  await expect(Effect.runPromise(access.set("outsider", false, "no"))).rejects.toThrow()
  await expect(Effect.runPromise(access.set("narrator", false, "no"))).rejects.toThrow()
  expect(await Effect.runPromise(access.set("card", false, "saved"))).toBe("saved")
  expect(calls.at(-1)).toMatchObject({
    userId: "owner",
    rolloutId: "run",
    toolCallId: "call",
    events: [{ key: "away.set", value: { entity: "card", away: true } }]
  })
  expect(calls[0]).toMatchObject({ slotId: "before" })
})

it("a throwing replacement signals suspension and closing its scope restores the exact original object and request bytes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* ExecutionRegistry
        const original = execution.rolloutTools.get("set_presence")!,
          bytes = JSON.stringify(frozenTool(original))
        const scope = yield* Scope.make()
        let failed = false
        const manifest = Schema.decodeUnknownSync(PluginManifest)({
          id: "fault",
          name: "Fault",
          api: 1,
          server: "server.ts",
          worker: null,
          client: null,
          surfaces: ["server:rolloutTools", "server:presence"],
          overrides: [],
          replaces: ["rolloutTools:set_presence"],
          base: null,
          network: false
        })
        const handles = declaredHandles(
          manifest,
          "server",
          { rolloutTools: execution.rolloutTools },
          scope,
          new Map(),
          () => {
            failed = true
          }
        ) as { rolloutTools: { register: (tool: unknown) => Effect.Effect<void, unknown> } }
        yield* handles.rolloutTools.register({ ...original, execute: () => Effect.die("synthetic") })
        yield* execution.rolloutTools
          .get("set_presence")!
          .execute({} as ToolContext, {} as never)
          .pipe(Effect.exit)
        expect(failed).toBe(true)
        yield* Scope.close(scope, Exit.void)
        expect(execution.rolloutTools.get("set_presence")).toBe(original)
        expect(JSON.stringify(frozenTool(execution.rolloutTools.get("set_presence")!))).toBe(bytes)
        expect(pluginAccessGrows(manifest, { ...manifest, surfaces: [...manifest.surfaces, "server:storage"] })).toBe(
          true
        )
        expect(
          pluginConsent({ ...manifest, surfaces: [...manifest.surfaces, "server:storage"] }, "instance").join(" ")
        ).toContain("Stores its own data")
      }).pipe(Effect.provide(ExecutionRegistry.layer))
    )
  )
})

it("copy creation recovers its own completed journal before consulting changed installed sources", async () => {
  const data = tempDir("copy-recover")
  const first = await copyBuiltin(
    data,
    "noticeChannels",
    "notifications.completion-sound",
    "recover-copy",
    "",
    "server-owned-copy-key"
  )
  const recovered = await copyBuiltin(data, "not-a-registry", "not-a-part", "recover-copy", "", "server-owned-copy-key")
  if ("unsupported" in first || "unsupported" in recovered) throw new Error("Unexpected copy import failure")
  expect(recovered.commit).toBe(first.commit)
  await expect(
    copyBuiltin(data, "noticeChannels", "notifications.completion-sound", "recover-copy", "", "another-key")
  ).rejects.toThrow("exists")
})

it("retained presence readers/setters refuse after their supplying plugin scope closes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* ExecutionRegistry,
          scope = yield* Scope.make()
        let retained: ReturnType<typeof presenceContext> | undefined
        const manifest = Schema.decodeUnknownSync(PluginManifest)({
          id: "retained-presence",
          name: "Retained",
          api: 1,
          server: "server.ts",
          worker: null,
          client: null,
          surfaces: ["server:rolloutTools", "server:presence"],
          overrides: [],
          replaces: ["rolloutTools:set_presence"],
          base: null,
          network: false
        })
        const handles = declaredHandles(
          manifest,
          "server",
          { rolloutTools: execution.rolloutTools },
          scope,
          new Map(),
          () => {}
        ) as { rolloutTools: { register: (tool: unknown) => Effect.Effect<void, unknown> } }
        yield* handles.rolloutTools.register({
          ...setPresence,
          execute: (access: ReturnType<typeof presenceContext>) => {
            retained = access
            return Effect.succeed({ text: "saved context" })
          }
        })
        let reads = 0,
          writes = 0
        const context = {
          reader: {
            StateEventsAt: () =>
              Effect.sync(() => {
                reads++
                return [{ scope: "branch", data: { key: "participant.join", value: { entity: "card" } } }]
              }),
            CastCards: () => Effect.succeed([{ entityId: "card", name: "Ada", modelName: null }])
          },
          writer: {
            ApplyRolloutEffect: () =>
              Effect.sync(() => {
                writes++
                return { result: "saved" }
              })
          }
        } as unknown as ToolContext
        yield* execution.rolloutTools.get("set_presence")!.execute(context, {} as never)
        expect(retained).toBeDefined()
        expect((yield* retained!.cast).map((c) => c.id)).toEqual(["card"])
        expect(yield* retained!.set("card", false, "before off")).toBe("saved")
        reads = 0
        writes = 0
        yield* Scope.close(scope, Exit.void)
        expect((yield* retained!.cast.pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* retained!.set("card", false, "late").pipe(Effect.exit))._tag).toBe("Failure")
        expect(reads).toBe(0)
        expect(writes).toBe(0)
      }).pipe(Effect.provide(ExecutionRegistry.layer))
    )
  )
})

for (const part of builtinCopies.filter(
  (part, index, all) => part.registry === "macros" && all.findIndex((p) => p.path === part.path) === index
))
  it(
    `checks the complete shipped ${part.id} macro family through the public worker API`,
    { timeout: 30000, tags: ["slow"] },
    async () => {
      const data = tempDir("macro-family")
      const prepared = await prepareBuiltinCopy("macros", part.id, "family-copy", data)
      const commit = await saveFiles(data, "", "family-copy", prepared.files, true, "Copy macro family")
      const report = await checkPlugin(data, "", "family-copy", commit)
      expect(report, JSON.stringify(report)).toMatchObject({ ok: true, step: "ready" })
    }
  )

it("the assistant catalog keeps every new part within its unchanged result budget", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* installPluginToolDefinitions
        const parts = [
          ...builtinCopies.map((p) => ({
            registry: p.registry,
            id: p.id,
            label: p.label,
            copyable: true,
            reason:
              "An editable copy starts off. Copied macros can reduce prompt cache reuse: their text is treated as changing on every reply.",
            replacedBy: []
          })),
          ...registry.rolloutTools
            .list()
            .filter((t) => !builtinCopies.some((p) => p.registry === "rolloutTools" && p.id === t.id))
            .map((t) => ({
              registry: "rolloutTools",
              id: t.id,
              label: t.label,
              copyable: false,
              reason: missingBuiltinAdapter(t.id),
              replacedBy: []
            }))
        ]
        const text = JSON.stringify(builtinCopyListing(parts))
        expect(text.length).toBeLessThan(14500)
        const listed = builtinCopyListing(parts)
          .filter((g) => g.copyable)
          .flatMap((g) => g.parts.map((p) => `${g.registry}:${p.id}`))
        expect(listed.toSorted()).toEqual(builtinCopies.map((p) => `${p.registry}:${p.id}`).toSorted())
        for (const part of parts.filter((p) => !p.copyable)) expect(text).toContain(JSON.stringify(part.id))
      }).pipe(Effect.provide(ExecutionRegistry.layer))
    )
  )
})
