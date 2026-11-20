import { Tooltip } from "../../ui/Tooltip.tsx"
// The top of a connection's page: which model new chats use. A connection just created here
// shows what its model list held, fetching it first unless the form already did. Nothing is
// ever chosen for the user (owner, 2026-11-20): with no default model, it says so and links to
// the picker.
import type { ModelRefresh } from "@dreamspan/shared/api.ts"
import { type Model, resolveModel } from "@dreamspan/shared/providers.ts"
import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { freshConnections, generationDefaultsAtom, modelsAtom } from "./data.ts"
import type { ConnectionSectionProps } from "./detail.tsx"

const modelName = (model: Model) => resolveModel(model.key, model.upstream, model.overrides).name.value

const change = (label: string) => (
  <Tooltip label="Opens the default model picker.">
    <Link to="/settings/chats" className="font-medium text-accent underline-offset-4 hover:underline">
      {label}
    </Link>
  </Tooltip>
)

const statusLine =
  "flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-border bg-surface px-4 py-3 text-sm"

export function DefaultModelSection({ connection }: ConnectionSectionProps) {
  const fetching = useAction()
  // What the form's fetch found, when it fetched the list itself.
  const [fetched, setFetched] = useState<ModelRefresh | null>(() => freshConnections.get(connection.id) ?? null)
  useEffect(() => {
    if (!freshConnections.has(connection.id)) return
    const done = freshConnections.get(connection.id)
    freshConnections.delete(connection.id)
    if (done) return
    void fetching
      .run((client) => client("RefreshModels", { connectionId: connection.id }), ["models"])
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
      Found {fetched.added} {fetched.added === 1 ? "model" : "models"}.
    </span>
  )
  if (chosen === null)
    return (
      <div role="status" className={statusLine}>
        {found}
        <span>No model is set for new chats</span>
        <span aria-hidden="true" className="text-muted">
          ·
        </span>
        {change("Choose")}
      </div>
    )
  if (!model) return found ? <p role="status">{found}</p> : null
  return (
    <div role="status" className={statusLine}>
      {found}
      <span>
        Using <strong className="font-medium [overflow-wrap:anywhere]">{modelName(model)}</strong> for new chats
      </span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      {change("Change")}
    </div>
  )
}
