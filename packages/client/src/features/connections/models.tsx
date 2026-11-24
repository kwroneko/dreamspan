// A connection's models: what the provider lists, merged with the user's edits
// (spec/PROVIDERS.md §3.1). Each field shows where its value came from.
import { type Model, resolveModel } from "@dreamspan/shared/providers.ts"
import { type FormEvent, useEffect, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { formatCost } from "../chat/versionMetrics.tsx"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { type ModelField, ModelSettingsEditor, sourceTitle, useEndpointsFetch } from "./ModelSettingsEditor.tsx"

export { ModelSettingsEditor, sourceTitle, type ModelField, useEndpointsFetch }

export const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))

/** A field's value, marked when no source knows it (the default is shown, never as fact). */
export function Value({
  resolved,
  model,
  show,
  assumed = false
}: {
  resolved: ReturnType<typeof resolveModel>["context"]
  model: ReturnType<typeof resolveModel>
  show: (n: number) => string
  /** Says "assumed" instead of "?": the context window's default is a guess shown as one. */
  assumed?: boolean
}) {
  return resolved.source === "unknown" ? (
    <span
      className="text-muted"
      title={
        assumed
          ? "Assumed: nothing reports this model's window. Set it in Edit, or refresh to match it in a catalog."
          : sourceTitle(resolved.source, model)
      }
    >
      {show(resolved.value)}
      {assumed ? " (assumed)" : "?"}
    </span>
  ) : (
    <span title={sourceTitle(resolved.source, model)}>
      {show(resolved.value)}
      {resolved.source === "user" && "*"}
      {resolved.source === "learned" && " (learned)"}
    </span>
  )
}

export const capabilityBadges = (model: ReturnType<typeof resolveModel>) =>
  (
    [
      ["vision", model.vision],
      ["reasoning", model.reasoning],
      ["tools", model.tools]
    ] as const
  )
    // An assumed capability (reasoning nobody reports) isn't shown as fact.
    .filter(([, resolved]) => resolved.value && resolved.source !== "unknown")

export function EditModelDialog({
  model,
  onOpenChange,
  focus
}: {
  model: Model
  onOpenChange: (open: boolean) => void
  focus?: ModelField | undefined
}) {
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Edit ${model.key}`}
      size="wide"
      initialFocus={
        focus ? () => document.querySelector<HTMLElement>(`[role="dialog"] [data-model-field="${focus}"]`) : undefined
      }
    >
      <ModelSettingsEditor model={model} focus={focus} onSaved={() => onOpenChange(false)} />
    </Dialog>
  )
}

/** A model's settings in a dialog, opened at a field: the budget note's and the refusal's action. */
export function ModelSettingsDialog({
  connectionId,
  modelId,
  focus,
  onOpenChange
}: {
  connectionId: string
  modelId: string
  focus?: ModelField | undefined
  onOpenChange: (open: boolean) => void
}) {
  const load = useAction()
  const [model, setModel] = useState<Model | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let live = true
    void load
      .run((client) =>
        client("ListModels", { connectionId: connectionId as Model["connectionId"], includeHidden: true })
      )
      .then((result) => {
        if (!live || !result.ok) return
        const found = result.value.find((entry) => entry.id === modelId) ?? null
        setModel(found)
        setMissing(found === null)
      })
    return () => {
      live = false
    }
  }, [connectionId, modelId]) // eslint-disable-line react-hooks/exhaustive-deps
  // One dialog throughout: the form replaces the loading line, and focuses its field when it mounts.
  return (
    <Dialog open onOpenChange={onOpenChange} title={model ? `Edit ${model.key}` : "Model settings"} size="wide">
      {model ? (
        <ModelSettingsEditor model={model} focus={focus} onSaved={() => onOpenChange(false)} />
      ) : load.error ? (
        <ErrorAlert error={load.error} />
      ) : missing ? (
        <p className="text-sm text-muted">This model is gone: its connection or the model was deleted.</p>
      ) : (
        <p className="text-sm text-muted">Loading the model…</p>
      )}
    </Dialog>
  )
}

export function AddModelDialog({
  connectionId,
  onOpenChange
}: {
  connectionId: Model["connectionId"]
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const durable = useUserDraft(`connection:${connectionId}`, "New model id", "")
  const { text: key, setText: setKey } = durable
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await durable
      .commit(key, async () => {
        const result = await action.run(
          (client) => client("AddUserModel", { connectionId, key: key.trim(), overrides: {} }),
          ["models"]
        )
        return result.ok
      })
      .then((ok) => {
        if (ok) onOpenChange(false)
      })
  }
  return (
    <Dialog open onOpenChange={onOpenChange} title="Add a model">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <UserDraftStatus draft={durable} />
        <Field label="Model id" about="The exact id the provider's API expects.">
          <Input value={key} onValueChange={setKey} autoCapitalize="none" spellCheck={false} />
        </Field>
        <ErrorAlert error={action.error} title="Not added" />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Adds this model to the connection."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={key.trim() === ""}
          >
            Add model
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

const fetchedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

/**
 * The price a model row shows and where it came from (spec/PRICES.md §7), in the order costs use
 * them: this server's price list when the user turned it on, a pinned provider's own price, the
 * provider's model list, else the app's built-in prices.
 */
export const shownPrice = (model: Model, resolved: ReturnType<typeof resolveModel>, priceEndpoint: boolean) => {
  const feed = priceEndpoint ? model.upstream.priceFeed : undefined
  if (feed?.price && feed.available !== false)
    return {
      price: feed.price,
      source: "endpoint",
      text: `from this server’s price list, fetched ${fetchedFormat.format(feed.fetchedAt)}${
        feed.pctOfList === undefined ? "" : `, ${feed.pctOfList} % of list price`
      }`,
      hint: "This server’s own price for the model, fetched when models were last refreshed."
    }
  if (!resolved.price) return null
  if (resolved.priceSource?.state === "pinned")
    return {
      price: resolved.price,
      source: "pinned",
      text: `from ${resolved.priceSource.name}`,
      hint: `${resolved.priceSource.name}’s own price, because the routing pins it.`
    }
  // A pinned provider without its own price: the model's usual price, marked so (see priceNote).
  const fallback = resolved.priceSource?.state === "fallback"
  return model.upstream.priceFrom === "list"
    ? {
        price: resolved.price,
        source: fallback ? "fallback" : "list",
        text: "from the provider’s model list",
        hint: "The price the provider lists for the model. A price you set in Settings → Costs comes first."
      }
    : {
        price: resolved.price,
        source: fallback ? "fallback" : "builtin",
        text: "built in",
        hint: "The app’s own price for the model. A price you set in Settings → Costs comes first."
      }
}

/** The routes a price endpoint lists for a model (PRICES §4.4): where it may send it, at what price. */
export function FeedRoutes({ feed }: { feed: Model["upstream"]["priceFeed"] }) {
  const routes = (feed?.routes ?? []).filter((route) => route.price !== null)
  if (routes.length === 0) return null
  return (
    <Tooltip label="Where this server may send the model, and each route’s price. A request is charged at a route’s price when the server says that route served it.">
      <span className="text-muted" data-price-routes={routes.length}>
        Routes:{" "}
        {routes
          .map((route) => {
            const price = route.price!
            const currency = price.currency ?? "USD"
            const input = formatCost({ amount: price.input, currency })
            const output = formatCost({ amount: price.output, currency })
            return `${route.target ?? route.upstream} ${input} / ${output}${
              route.pctOfList === undefined ? "" : ` (${route.pctOfList} %)`
            }`
          })
          .join(", ")}
      </span>
    </Tooltip>
  )
}
