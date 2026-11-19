// Resolve summary destinations in one place. Only a missing model falls through; other
// read failures retain their ordinary error. This performs local reads, never inference.
import { Effect } from "effect"
import type { ChatState } from "@dreamspan/shared/state.ts"
import type { AssemblySources } from "./pipeline.ts"

export const resolveSummaryModel = Effect.fnUntraced(function* (
  sources: AssemblySources["Service"],
  bindings: ChatState["modelBindings"]
) {
  const defaults = sources.lcmDefaults ? yield* sources.lcmDefaults() : null
  const candidates = [bindings["summarizer"], defaults?.summarizer, bindings["narrator"], bindings[""], null]
  let unavailable = false
  for (const binding of candidates) {
    if (binding === undefined) continue
    const result = yield* sources.model(binding).pipe(
      Effect.map((model) => ({ model })),
      Effect.catchTag("AssemblyFailed", (error) =>
        error.reason === "no_model" ? Effect.succeed(null) : Effect.fail(error)
      )
    )
    if (result?.model) return { model: result.model, unavailable }
    if (binding !== null) unavailable = true
  }
  return { model: null, unavailable }
})
