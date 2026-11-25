// Refresh from several connections at once: the model picker's refresh button and the
// connections page's Refresh all models. Each connection's list is read in parallel with
// RefreshModels; a failure names its connection and never stops the others.
import type { ProviderErrorReason } from "@dreamspan/shared/errors.ts"
import type { ConnectionId } from "@dreamspan/shared/providers.ts"
import { Effect, Exit } from "effect"
import { useState } from "react"
import { useAction } from "../../actions.tsx"
import { failure as reasonWords } from "./check.tsx"
import { modelListsChanged } from "../chat/modelChoices.ts"
import { type AppError, describeCause } from "../../errors.ts"

export interface RefreshTarget {
  readonly id: ConnectionId
  readonly name: string
}

/** "Couldn't refresh NAGA: <reason>", one line per connection that failed. */
const failure = (failed: ReadonlyArray<{ name: string; error: AppError }>): AppError => {
  const lines = failed.map(({ name, error }) => {
    // A provider's failure is said in the connection check's words; any other error as the app words it.
    const why =
      error.tag === "ProviderError"
        ? reasonWords(error.reason as ProviderErrorReason | null, null)
        : error.message.replace(/\.$/, "")
    return `Couldn't refresh ${name}: ${why[0]!.toLowerCase()}${why.slice(1)}`
  })
  return { tag: "RefreshModels", message: lines[0]!, problems: lines.slice(1), reason: null }
}

/** The hover explanation: all connections, or the one named. */
export const refreshHint = (only: string | null) =>
  only === null ? "Fetch the latest model lists from all connections" : `Fetch the latest model list from ${only}`

export function useRefreshModels() {
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const run = async (targets: ReadonlyArray<RefreshTarget>) => {
    setError(null)
    const result = await action.run(
      (client) =>
        Effect.forEach(
          targets,
          (entry) =>
            Effect.exit(client("RefreshModels", { connectionId: entry.id })).pipe(
              Effect.map((exit) => ({ name: entry.name, exit }))
            ),
          { concurrency: "unbounded" }
        ),
      ["models"]
    )
    modelListsChanged()
    if (!result.ok) return setError(result.error)
    const failed = result.value.flatMap(({ name, exit }) =>
      Exit.isFailure(exit) ? [{ name, error: describeCause(exit.cause) }] : []
    )
    if (failed.length > 0) setError(failure(failed))
  }
  return { run, pending: action.pending, error }
}
