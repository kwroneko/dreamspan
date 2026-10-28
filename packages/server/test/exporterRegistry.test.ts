import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Exporters, exportFile, type Exporter } from "../src/importer/exporters.ts"
import { makeRegistry } from "../src/registry.ts"

it.effect("direct export dispatch honors the scoped exporter service and restores it", () => {
  const supplied = makeRegistry<Exporter>()
  return Effect.gen(function* () {
    const registry = yield* Exporters
    const input = {
      format: "synthetic",
      docJson: "{}",
      noteDocJson: null,
      notesDocJson: [],
      avatar: null,
      assets: []
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* registry.register({
          id: "synthetic",
          kind: "card",
          label: "Synthetic",
          mime: "text/plain",
          extension: "txt",
          media: "none",
          write: () => Effect.succeed(new TextEncoder().encode("Plugin export."))
        })
        assert.strictEqual(new TextDecoder().decode(yield* exportFile(input)), "Plugin export.")
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* registry.disable(input.format)
            const error = yield* exportFile(input).pipe(Effect.flip)
            assert.include(error.message, "Unknown export format")
          })
        )
        assert.strictEqual(new TextDecoder().decode(yield* exportFile(input)), "Plugin export.")
      })
    )
    assert.include((yield* exportFile(input).pipe(Effect.flip)).message, "Unknown export format")
  }).pipe(Effect.provideService(Exporters, supplied))
})
