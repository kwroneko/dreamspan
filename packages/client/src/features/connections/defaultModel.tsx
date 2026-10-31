// The top of a connection's page: which model new chats use. A connection just created here
// fetches its model list at once, and when the account has no default model yet its first
// model becomes the default (ST's Connect picks one the same way).
import type { ModelRefresh } from "@rp/shared/api.ts"
import type { GenerationDefaults } from "@rp/shared/generation.ts"
import { type Model, resolveModel } from "@rp/shared/providers.ts"
import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { freshConnections, generationDefaultsAtom, modelsAtom } from "./data.ts"
import type { ConnectionSectionProps } from "./detail.tsx"

const modelName = (model: Model) => resolveModel(model.key, model.upstream, model.overrides).name.value

const change = (
  <Link to="/settings/chats" className="font-medium text-accent underline-offset-4 hover:underline">
    Change
  </Link>
)

export function DefaultModelSection({ connection }: ConnectionSectionProps) {
  const fetching = useAction()
  const [fetched, setFetched] = useState<{ refresh: ModelRefresh; adopted: boolean } | null>(null)
  useEffect(() => {
    if (!freshConnections.delete(connection.id)) return
    void fetching
      .run(
        (client) =>
          Effect.gen(function* () {
            const refresh = yield* client("RefreshModels", { connectionId: connection.id })
            const models: ReadonlyArray<Model> = yield* client("ListModels", {
              connectionId: connection.id,
              includeHidden: false
            })
            const defaults: GenerationDefaults = yield* client("GetGenerationDefaults", undefined)
            const first = models[0]
            if (defaults.model || !first) return { refresh, adopted: false }
            yield* client("ChangeGenerationDefaults", {
              change: { model: { connection: connection.id, model: first.id } }
            })
            return { refresh, adopted: true }
          }),
        ["models", "settings"]
      )
      .then((result) => result.ok && setFetched(result.value))
  }, [connection.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const defaults = useAtomValue(generationDefaultsAtom)
  const models = useAtomValue(modelsAtom(connection.id, true))
  if (fetching.pending)
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> Fetching the model list…
      </p>
    )
  if (fetching.error) return <ErrorAlert error={fetching.error} title="The model list couldn't be fetched" />
  if (!AsyncResult.isSuccess(defaults) || !AsyncResult.isSuccess(models)) return null
  const chosen = defaults.value.model
  const model = chosen?.connection === connection.id ? models.value.find((m) => m.id === chosen.model) : undefined
  if (fetched && models.value.length === 0)
    return (
      <Alert tone="warning" title="The provider listed no models">
        <p>Add one by its id under Models.</p>
      </Alert>
    )
  const found = fetched && (
    <span className="text-muted">
      Found {fetched.refresh.added} {fetched.refresh.added === 1 ? "model" : "models"}.
    </span>
  )
  if (!model) return found ? <p role="status">{found}</p> : null
  return (
    <div
      role="status"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
    >
      {found}
      <span>
        Using <strong className="font-medium [overflow-wrap:anywhere]">{modelName(model)}</strong> for new chats
      </span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      {change}
    </div>
  )
}
