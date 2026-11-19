// Subagent types as replaceable parts (spec/SUBAGENTS.md §10, subagents9): the built-in workshop
// types are plain data a plugin can copy and replace by id; the helper can't be; a type's short
// explanation and an "every tool" rule are checked when registered. Synthetic data only.
import { assert, expect, it } from "vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { PluginManifest } from "@dreamspan/shared/plugins.ts"
import { builtinReplacement } from "@dreamspan/shared/builtinParts.ts"
import { prepareBuiltinCopy } from "../src/plugins/copy.ts"
import { saveFiles } from "../src/plugins/repo.ts"
import { checkPlugin } from "../src/plugins/check.ts"
import { declaredHandles } from "../src/plugins/handles.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { builtinSubagentTypes, mayUse, NEVER, typesFor } from "../src/agent/subagents.ts"
import { installPluginToolDefinitions } from "./support/pluginToolDefinitions.ts"
import { tempDir } from "./support/tempDir.ts"

const manifest = (replaces: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(PluginManifest)({
    id: "types",
    name: "Types",
    api: 1,
    server: "server.ts",
    worker: null,
    client: null,
    surfaces: ["server:subagentTypes"],
    overrides: [],
    replaces,
    base: null,
    network: false
  })

it("a copy of a built-in type registers its data through the plugin API, replacing it by id", async () => {
  const prepared = await prepareBuiltinCopy("subagentTypes", "research", "research-copy", tempDir("type-copy"))
  const plugin = JSON.parse(prepared.files["dreamspan-plugin.json"]!)
  expect(plugin.replaces).toEqual(["subagentTypes:research"])
  expect(plugin.surfaces).toEqual(["server:subagentTypes"])
  expect(prepared.files["src/server.ts"]).toContain("host.registries.subagentTypes!.register(researchType)")
  const part = prepared.files["src/part/subagentTypesPart.ts"]!
  expect(part).toContain('from "@dreamspan/plugin-api/server"')
  expect(part).not.toMatch(/from "\.\.?\//)
  for (const id of ["research", "code", "general"])
    expect(builtinReplacement(`subagentTypes:${id}`)?.side).toBe("server")
  // The story helper has its own settings and no copy.
  expect(builtinReplacement("subagentTypes:helper")).toBeUndefined()
  await expect(prepareBuiltinCopy("subagentTypes", "helper", "helper-copy", tempDir("helper-copy"))).rejects.toThrow(
    "adapter"
  )
})

it(
  "the copied type checks as a plugin through the public server API",
  { timeout: 60_000, tags: ["slow"] },
  async () => {
    const data = tempDir("type-check")
    const prepared = await prepareBuiltinCopy("subagentTypes", "code", "code-copy", data)
    const commit = await saveFiles(data, "", "code-copy", prepared.files, true, "Copy the code type")
    const report = await checkPlugin(data, "", "code-copy", commit)
    expect(report, JSON.stringify(report)).toMatchObject({ ok: true, step: "ready" })
  }
)

it("a plugin replaces a built-in type only when it declares it, never the helper, and closing restores it", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* ExecutionRegistry
        const original = execution.subagentTypes.get("research")!
        type Handles = { subagentTypes: { register: (type: unknown) => Effect.Effect<void, unknown> } }
        const handlesFor = (replaces: ReadonlyArray<string>, scope: Scope.Scope) =>
          declaredHandles(
            manifest(replaces),
            "server",
            { subagentTypes: execution.subagentTypes },
            scope,
            new Map(),
            () => {}
          ) as unknown as Handles
        const replacement = { ...original, label: "Look it up, my way", explanation: "Reads, my way." }

        const undeclared = yield* Scope.make()
        const refused = yield* handlesFor([], undeclared).subagentTypes.register(replacement).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(refused))
        assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), "Replacement was not declared")

        const helperScope = yield* Scope.make()
        const helper = yield* handlesFor(["subagentTypes:helper"], helperScope)
          .subagentTypes.register({ ...execution.subagentTypes.get("helper")!, label: "Mine" })
          .pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(helper))
        assert.include(String(Exit.isFailure(helper) ? helper.cause : ""), "copy adapter")

        const scope = yield* Scope.make()
        yield* handlesFor(["subagentTypes:research"], scope).subagentTypes.register(replacement)
        assert.strictEqual(execution.subagentTypes.get("research")!.label, "Look it up, my way")
        const listed = typesFor(execution.subagentTypes.list(), [])
        assert.deepInclude(
          listed.map((t) => [t.id, t.source, t.explanation]),
          ["research", "plugin", "Reads, my way."]
        )
        // A user's change still applies on top of the replacement.
        const changed = typesFor(execution.subagentTypes.list(), [{ id: "research", explanation: "Mine now." }])
        assert.strictEqual(changed.find((t) => t.id === "research")!.explanation, "Mine now.")
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual(execution.subagentTypes.get("research"), original)
      }).pipe(Effect.provide(ExecutionRegistry.layer))
    )
  ))

it("explanations and an every-tool rule are checked; general gets every tool but those no subagent gets", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* installPluginToolDefinitions
        const base = {
          id: "mine",
          label: "Mine",
          description: "A synthetic type.",
          kinds: ["workshop"],
          defaultAlias: "same",
          instructions: "You are a synthetic subagent."
        }
        const long = yield* execution.subagentTypes
          .register({ ...base, tools: { all: true }, explanation: "x".repeat(201) })
          .pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(long))
        const badRule = yield* execution.subagentTypes
          .register({ ...base, tools: { all: "yes" } as never })
          .pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(badRule))
        yield* execution.subagentTypes.register({ ...base, tools: { all: true }, explanation: "Does things." })
        const general = builtinSubagentTypes.find((t) => t.id === "general")!
        const tools = execution.rolloutTools.list()
        for (const tool of tools) assert.strictEqual(mayUse(general, tool), !NEVER.has(tool.id), tool.id)
        for (const type of builtinSubagentTypes) assert.isAbove(type.explanation?.length ?? 0, 0, type.id)
      })
    ).pipe(Effect.provide(ExecutionRegistry.layer))
  ))
