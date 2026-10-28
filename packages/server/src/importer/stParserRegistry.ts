// A parser registration must cross a worker boundary, so it names a module export rather
// than a closure. The selected source travels with each job, including after a respawn.
import { Context, Effect, Layer } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import type { StParserSource } from "./ops.ts"
import type { StParsers } from "./stParse.ts"

interface StParser extends StParserSource {
  readonly id: keyof StParsers
}

/**
 * Register an absolute file URL and an export with the corresponding StParsers signature.
 * Code is loaded only in the worker. Use a new module URL for changed code (ESM caches
 * modules); closing the registration scope restores the previous source for future jobs.
 */
export class StParserRegistry extends Context.Service<StParserRegistry, Registry<StParser>>()(
  "rp/importer/StParserRegistry"
) {}

export const layer = Layer.effect(
  StParserRegistry,
  Effect.gen(function* () {
    const registry = makeRegistry<StParser>()
    const ids: ReadonlyArray<keyof StParsers> = ["chat-part", "settings", "group", "library-file", "persona"]
    for (const id of ids) yield* registry.register({ id, module: "rp:st-parsers", exportName: id })
    return registry
  })
)
