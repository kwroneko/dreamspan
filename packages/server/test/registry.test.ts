import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { makeRegistry } from "../src/registry.ts"

describe("registry", () => {
  it.effect("overrides stack per id, and closing a scope restores what it hid, in any order", () =>
    Effect.gen(function* () {
      const registry = makeRegistry<{ id: string; value: string }>()
      const core = yield* Scope.make()
      const pluginA = yield* Scope.make()
      const pluginB = yield* Scope.make()
      yield* Scope.provide(core)(registry.register({ id: "macro", value: "core" }))
      yield* Scope.provide(core)(registry.register({ id: "stage", value: "core" }))
      yield* Scope.provide(pluginA)(registry.register({ id: "macro", value: "A" }))
      yield* Scope.provide(pluginB)(registry.disable("stage"))
      assert.strictEqual(registry.get("macro")?.value, "A")
      assert.isUndefined(registry.get("stage"))
      assert.deepStrictEqual(
        registry.list().map((e) => e.value),
        ["A"]
      )
      // A wraps on top of the core entry; B's disable goes away first.
      yield* Scope.close(pluginB, Exit.void)
      assert.strictEqual(registry.get("stage")?.value, "core")
      yield* Scope.close(pluginA, Exit.void)
      assert.strictEqual(registry.get("macro")?.value, "core")
      yield* Scope.close(core, Exit.void)
      assert.deepStrictEqual(registry.list(), [])
    })
  )
})
