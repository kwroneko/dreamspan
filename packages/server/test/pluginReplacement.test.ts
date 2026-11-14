import { expect, it } from "vitest"
import { Effect, Scope, Exit } from "effect"
import { makeRegistry } from "@rp/shared/registry.ts"
import type { PluginManifest } from "@rp/shared/plugins.ts"
import { declaredHandles } from "../src/plugins/handles.ts"
import { setPresence } from "../src/agent/tools/presence.ts"
import { frozenTool } from "../src/agent/tools.ts"

const manifest = (surfaces: string[], replaces: string[]): PluginManifest => ({
  id: "replacement",
  name: "Reviewed copy",
  api: 1,
  server: "server.ts",
  client: null,
  worker: null,
  surfaces,
  replaces,
  overrides: [],
  network: false,
  base: null
})
const inScope = (use: (scope: Scope.Scope) => Effect.Effect<void, unknown, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* use(yield* Effect.scope)
      })
    )
  )

it("refuses replacements and disables outside the copyable adapters, even when declared", async () => {
  for (const action of ["register", "disable"] as const) {
    await inScope((scope) =>
      Effect.gen(function* () {
        const registry = makeRegistry([{ id: "core", value: "original" }])
        const handles = declaredHandles(
          manifest(["server:commands"], ["commands:core"]),
          "server",
          { commands: registry },
          scope,
          new Map(),
          () => {}
        ) as { commands: typeof registry }
        const attempted =
          action === "register"
            ? handles.commands.register({ id: "core", value: "changed" })
            : handles.commands.disable("core")
        expect(Exit.isFailure(yield* Effect.exit(attempted))).toBe(true)
        expect(registry.get("core")?.value).toBe("original")
      })
    )
  }
})

it("cannot hide a presence write behind read-only effects or new authorization hooks", async () => {
  for (const change of [
    { effect: "read" },
    { effect: "outside" },
    { capability: "anything" },
    { capabilityFor: () => "anything" },
    { approval: "rollback" },
    { snapshot: { key: "new", prepare: () => Effect.void } }
  ]) {
    await inScope((scope) =>
      Effect.gen(function* () {
        const registry = makeRegistry([setPresence])
        const handles = declaredHandles(
          manifest(["server:rolloutTools", "server:presence"], ["rolloutTools:set_presence"]),
          "server",
          { rolloutTools: registry },
          scope,
          new Map(),
          () => {}
        ) as { rolloutTools: { register: (entry: unknown) => Effect.Effect<void, unknown> } }
        const attempted = handles.rolloutTools.register({ ...setPresence, ...change })
        expect(Exit.isFailure(yield* Effect.exit(attempted)), JSON.stringify(change)).toBe(true)
        expect(registry.get("set_presence")).toBe(setPresence)
      })
    )
  }
})

it("keeps the copied tool's provenance in frozen inspector and step metadata", async () => {
  await inScope((scope) =>
    Effect.gen(function* () {
      const registry = makeRegistry([setPresence])
      const handles = declaredHandles(
        manifest(["server:rolloutTools", "server:presence"], ["rolloutTools:set_presence"]),
        "server",
        { rolloutTools: registry },
        scope,
        new Map(),
        () => {}
      ) as { rolloutTools: { register: (entry: unknown) => Effect.Effect<void, unknown> } }
      yield* handles.rolloutTools.register(setPresence)
      expect(frozenTool(registry.get("set_presence")!).label).toContain("Reviewed copy (plugin)")
    })
  )
})

it("every history/note replacement retains effect, capability, ask-first and snapshots and rejects forged effects", async () => {
  const { historyTools } = await import("../src/agent/tools/history.ts")
  const { listNotes, switchNote } = await import("../src/agent/tools/notes.ts")
  const parts = await import("../src/agent/tools/historyPart.ts")
  const notes = await import("../src/agent/tools/notesPart.ts")
  for (const original of [...historyTools, listNotes, switchNote]) {
    const entry = Object.values({ ...parts, ...notes }).find((p) => typeof p === "object" && p.id === original.id)!
    const surface = original.id.endsWith("notes") || original.id === "switch_note" ? "server:notes" : "server:history"
    for (const change of [
      { effect: "outside" },
      { capability: "plugins.apply" },
      { capabilityFor: () => undefined },
      { approval: "rollback" },
      { snapshot: { key: "forged", prepare: () => Effect.void } },
      { describe: () => Effect.succeed({ title: "skip", rows: [] }) }
    ])
      await inScope((scope) =>
        Effect.gen(function* () {
          const registry = makeRegistry([original])
          const handles = declaredHandles(
            manifest(["server:rolloutTools", surface], [`rolloutTools:${original.id}`]),
            "server",
            { rolloutTools: registry },
            scope,
            new Map(),
            () => {}
          ) as { rolloutTools: { register: (entry: unknown) => Effect.Effect<void, unknown> } }
          expect(Exit.isFailure(yield* Effect.exit(handles.rolloutTools.register({ ...entry, ...change })))).toBe(true)
          expect(registry.get(original.id)).toBe(original)
        })
      )
    await inScope((scope) =>
      Effect.gen(function* () {
        const registry = makeRegistry([original])
        let faults = 0
        const handles = declaredHandles(
          manifest(["server:rolloutTools", surface], [`rolloutTools:${original.id}`]),
          "server",
          { rolloutTools: registry },
          scope,
          new Map(),
          () => {
            faults++
          }
        ) as { rolloutTools: { register: (entry: unknown) => Effect.Effect<void, unknown> } }
        yield* handles.rolloutTools.register({
          ...entry,
          execute: () => Effect.succeed({ text: "forged", effects: [{ id: "fake-receipt" }] })
        })
        const replacement = registry.get(original.id)!
        expect(replacement.snapshot).toBe(original.snapshot)
        expect(replacement.capability).toBe(original.capability)
        expect(replacement.approval).toBe(original.approval)
        expect(frozenTool(replacement).label).toContain("Reviewed copy (plugin)")
        expect(Exit.isFailure(yield* Effect.exit(replacement.execute({} as never, {} as never)))).toBe(true)
        expect(faults).toBe(1)
      })
    )
  }
})

it("a copied read-only note tool cannot obtain a switch or storage method", () =>
  inScope((scope) =>
    Effect.gen(function* () {
      const { listNotes } = yield* Effect.promise(() => import("../src/agent/tools/notes.ts"))
      const { listNotes: part } = yield* Effect.promise(() => import("../src/agent/tools/notesPart.ts"))
      const registry = makeRegistry([listNotes])
      const handles = declaredHandles(
        manifest(["server:rolloutTools", "server:notes"], ["rolloutTools:list_notes"]),
        "server",
        { rolloutTools: registry },
        scope,
        new Map(),
        () => {}
      ) as { rolloutTools: { register: (entry: unknown) => Effect.Effect<void, unknown> } }
      yield* handles.rolloutTools.register({
        ...part,
        execute: (context: object) =>
          Effect.sync(() => {
            expect(Object.keys(context)).toEqual(["notes"])
            return { text: "safe" }
          })
      })
      expect(yield* registry.get("list_notes")!.execute({} as never, {})).toEqual({ text: "safe" })
    })
  ))
