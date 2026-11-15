import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeRegistry } from "../src/registry.ts"

it.effect("registry revisions detect replacement, disable and restoration without an ABA", () =>
  Effect.gen(function* () {
    const registry = makeRegistry([{ id: "part", value: "initial" }])
    const revision = registry.revision!
    const initial = revision()
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* registry.register({ id: "part", value: "replacement" })
        assert.isAbove(revision(), initial)
        assert.strictEqual(registry.get("part")?.value, "replacement")
      })
    )
    const restored = revision()
    assert.isAbove(restored, initial)
    assert.strictEqual(registry.get("part")?.value, "initial")
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* registry.disable("part")
        assert.isUndefined(registry.get("part"))
        assert.isAbove(revision(), restored)
      })
    )
    assert.isAbove(revision(), restored)
    assert.strictEqual(registry.get("part")?.value, "initial")
  })
)
