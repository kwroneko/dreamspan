// A connection's models: what the provider lists, merged with the user's edits
// (spec/PROVIDERS.md §3.1). Each field shows where its value came from.
import type { ModelRefresh } from "@rp/shared/api.ts"
import { type Model, type ModelOverrides, resolveModel } from "@rp/shared/providers.ts"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, focusFirstInvalid, Input } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { modelsAtom, parseOptionalInt } from "./data.ts"
import type { ConnectionSectionProps } from "./detail.tsx"

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))

/** A field's value, marked when no source knows it (the default is shown, never as fact). */
function Value({
  resolved,
  show
}: {
  resolved: ReturnType<typeof resolveModel>["context"]
  show: (n: number) => string
}) {
  return resolved.source === "unknown" ? (
    <span className="text-muted" title="Unknown: no source reports it, so a safe default is used">
      {show(resolved.value)}?
    </span>
  ) : (
    <span title={resolved.source === "user" ? "Set by you" : "From the provider"}>
      {show(resolved.value)}
      {resolved.source === "user" && "*"}
    </span>
  )
}

const capabilityBadges = (model: ReturnType<typeof resolveModel>) =>
  (
    [
      ["vision", model.vision],
      ["reasoning", model.reasoning],
      ["tools", model.tools]
    ] as const
  ).filter(([, resolved]) => resolved.value)

type Tri = "auto" | "yes" | "no"
const triOf = (value: boolean | undefined): Tri => (value === undefined ? "auto" : value ? "yes" : "no")
const triItems = [
  { value: "auto" as const, label: "As the provider says" },
  { value: "yes" as const, label: "Yes" },
  { value: "no" as const, label: "No" }
]

type PrefillChoice = "auto" | NonNullable<ModelOverrides["prefill"]>
/**
 * Whether the model takes the start of its reply natively or through a strict tool schema.
 * Absent provider information stays unknown until the user declares support.
 */
const prefillItems = (upstream: ModelOverrides["prefill"]) => [
  {
    value: "auto" as const,
    label:
      upstream === undefined
        ? "Unknown: no provider information"
        : upstream === "assistant"
          ? "Provider: assistant prefill"
          : upstream === "tool_schema"
            ? "Provider: tool schema"
            : "Provider: no prefill"
  },
  { value: "assistant" as const, label: "Yes: start an assistant reply" },
  { value: "none" as const, label: "No" },
  { value: "tool_schema" as const, label: "Through a tool schema" }
]

/** Edits the user's overrides. Empty fields fall back to what the provider reports. */
function EditModelDialog({ model, onOpenChange }: { model: Model; onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const [name, setName] = useState(model.overrides.name ?? "")
  const [context, setContext] = useState(model.overrides.context?.toString() ?? "")
  const [maxOutput, setMaxOutput] = useState(model.overrides.maxOutput?.toString() ?? "")
  const [vision, setVision] = useState<Tri>(triOf(model.overrides.vision))
  const [reasoning, setReasoning] = useState<Tri>(triOf(model.overrides.reasoning))
  const [tools, setTools] = useState<Tri>(triOf(model.overrides.tools))
  const [prefill, setPrefill] = useState<PrefillChoice>(model.overrides.prefill ?? "auto")
  const contextValue = parseOptionalInt(context, 1)
  const maxOutputValue = parseOptionalInt(maxOutput, 1)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (contextValue.problem || maxOutputValue.problem) return focusFirstInvalid(event.currentTarget)
    const flag = (tri: Tri) => (tri === "auto" ? undefined : tri === "yes")
    const overrides: ModelOverrides = Object.fromEntries(
      Object.entries({
        ...model.overrides,
        name: name.trim() || undefined,
        context: contextValue.value ?? undefined,
        maxOutput: maxOutputValue.value ?? undefined,
        vision: flag(vision),
        reasoning: flag(reasoning),
        tools: flag(tools),
        prefill: prefill === "auto" ? undefined : prefill
      }).filter(([, value]) => value !== undefined)
    )
    const result = await action.run(
      (client) => client("EditModel", { modelId: model.id, overrides, expectedRowVersion: model.rowVersion }),
      ["models"]
    )
    if (result.ok) onOpenChange(false)
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Edit ${model.key}`}
      description="Your values win over the provider's, and a refresh never changes them. Leave a field empty to use the provider's."
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Display name">
          <Input value={name} onValueChange={setName} placeholder={model.upstream.name ?? model.key} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Context (tokens)" error={contextValue.problem}>
            <Input
              value={context}
              onValueChange={setContext}
              inputMode="numeric"
              placeholder={model.upstream.context?.toString()}
            />
          </Field>
          <Field label="Max output (tokens)" error={maxOutputValue.problem}>
            <Input
              value={maxOutput}
              onValueChange={setMaxOutput}
              inputMode="numeric"
              placeholder={model.upstream.maxOutput?.toString()}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Vision">
            <Select items={triItems} value={vision} onValueChange={setVision} />
          </Field>
          <Field label="Reasoning">
            <Select items={triItems} value={reasoning} onValueChange={setReasoning} />
          </Field>
          <Field label="Tools">
            <Select items={triItems} value={tools} onValueChange={setTools} />
          </Field>
        </div>
        <Field
          label="Prefill"
          description="Whether it takes the start of its reply: the preset's prefill and Continue need it. Unknown support leaves Continue unavailable until declared."
        >
          <Select items={prefillItems(model.upstream.prefill)} value={prefill} onValueChange={setPrefill} />
        </Field>
        <ErrorAlert
          error={action.error}
          title="Not saved"
          actions={
            action.error?.tag === "StaleWrite" ? (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close and reload
              </Button>
            ) : undefined
          }
        />
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" pending={action.pending}>
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function AddModelDialog({
  connectionId,
  onOpenChange
}: {
  connectionId: Model["connectionId"]
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const [key, setKey] = useState("")
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action.run(
      (client) => client("AddUserModel", { connectionId, key: key.trim(), overrides: {} }),
      ["models"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Add a model"
      description="For a model the provider doesn't list. Use the exact id the API expects."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Model id">
          <Input value={key} onValueChange={setKey} autoCapitalize="none" spellCheck={false} />
        </Field>
        <ErrorAlert error={action.error} title="Not added" />
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" pending={action.pending} disabled={key.trim() === ""}>
            Add model
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function ModelRow({ model, compat }: { model: Model; compat: ConnectionSectionProps["connection"]["compat"] }) {
  const hide = useAction()
  const [editing, setEditing] = useState(false)
  const resolved = resolveModel(model.key, model.upstream, model.overrides, compat)
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium [overflow-wrap:anywhere]">{resolved.name.value}</span>
          {model.source === "user" && <Badge>added by you</Badge>}
          {model.hidden && <Badge>hidden</Badge>}
          {model.missingSince !== null && <Badge tone="warning">no longer listed</Badge>}
        </div>
        <p className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{model.key}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <span>
            Context <Value resolved={resolved.context} show={tokens} />
          </span>
          <span>
            Output <Value resolved={resolved.maxOutput} show={tokens} />
          </span>
          {resolved.price && (
            <span className="text-muted">
              ${resolved.price.input} / ${resolved.price.output} per M tokens
            </span>
          )}
          {capabilityBadges(resolved).map(([label]) => (
            <Badge key={label} tone="accent">
              {label}
            </Badge>
          ))}
          {resolved.prefill.value === "assistant" && <Badge tone="accent">prefill</Badge>}
        </p>
        <ErrorAlert error={hide.error} />
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${model.key}`}>
          Edit
        </Button>
        <Button
          variant="ghost"
          pending={hide.pending}
          aria-label={`${model.hidden ? "Show" : "Hide"} ${model.key}`}
          onClick={() =>
            void hide.run(
              (client) => client("SetModelHidden", { modelId: model.id, hidden: !model.hidden }),
              ["models"]
            )
          }
        >
          {model.hidden ? "Show" : "Hide"}
        </Button>
      </div>
      {editing && <EditModelDialog model={model} onOpenChange={setEditing} />}
    </li>
  )
}

const refreshSummary = (refresh: ModelRefresh) =>
  [
    `${refresh.added} added`,
    `${refresh.updated} updated`,
    ...(refresh.missing > 0 ? [`${refresh.missing} no longer listed`] : [])
  ].join(", ")

export function ModelsSection({ connection }: ConnectionSectionProps) {
  const refresh = useAction()
  const [includeHidden, setIncludeHidden] = useState(false)
  const [adding, setAdding] = useState(false)
  const [refreshed, setRefreshed] = useState<ModelRefresh | null>(null)
  return (
    <Card>
      <CardHeader
        title="Models"
        description="What the provider lists, with your edits on top. * marks your values, ? values nobody reports."
        actions={
          <>
            <Button
              pending={refresh.pending}
              onClick={async () => {
                setRefreshed(null)
                const result = await refresh.run(
                  (client) => client("RefreshModels", { connectionId: connection.id }),
                  ["models"]
                )
                if (result.ok) setRefreshed(result.value)
              }}
            >
              Refresh from provider
            </Button>
            <Button variant="ghost" onClick={() => setAdding(true)}>
              Add a model
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-4">
        {refreshed && (
          <Alert tone="success" title="Model list refreshed">
            <p>{refreshSummary(refreshed)}.</p>
            {refreshed.route && <p className="text-muted">Route: {refreshed.route}</p>}
          </Alert>
        )}
        <ErrorAlert error={refresh.error} title="The model list couldn't be fetched" />
        <Switch checked={includeHidden} onCheckedChange={setIncludeHidden}>
          Show hidden models
        </Switch>
        <AsyncView atom={modelsAtom(connection.id, includeHidden)} loading="Loading models…">
          {(models) =>
            models.length === 0 ? (
              <EmptyState title="No models">
                <p>Refresh from the provider, or add one by its id.</p>
              </EmptyState>
            ) : (
              <ul className="flex flex-col divide-y divide-border" aria-label="Models">
                {models.map((model) => (
                  <ModelRow key={model.id} model={model} compat={connection.compat} />
                ))}
              </ul>
            )
          }
        </AsyncView>
      </div>
      {adding && <AddModelDialog connectionId={connection.id} onOpenChange={setAdding} />}
    </Card>
  )
}
