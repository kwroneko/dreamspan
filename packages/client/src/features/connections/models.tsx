import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { DEFAULT_RESPONSE, DEFAULT_SAMPLERS, ModelSettings } from "@rp/shared/modelSettings.ts"
import { Schema } from "effect"
import { StSettingsImporter } from "./StSettingsImport.tsx"
// A connection's models: what the provider lists, merged with the user's edits
// (spec/PROVIDERS.md §3.1). Each field shows where its value came from.
import type { ModelRefresh } from "@rp/shared/api.ts"
import { type Model, ModelOverrides, resolveModel } from "@rp/shared/providers.ts"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, focusFirstInvalid, Input, Textarea } from "../../ui/Field.tsx"
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

type SamplerKey = keyof NonNullable<ModelSettings["samplers"]>

/** The generation settings with fields of their own; the rest are in the JSON below them. */
const SETTING_FIELDS: ReadonlyArray<readonly [key: SamplerKey, label: string, numeric: boolean]> = [
  ["openai_max_context", "Context size (tokens)", true],
  ["openai_max_tokens", "Response length (tokens)", true],
  ["temperature", "Temperature", true],
  ["top_p", "Top P", true],
  ["top_k", "Top K", true],
  ["min_p", "Min P", true],
  ["top_a", "Top A", true],
  ["frequency_penalty", "Frequency penalty", true],
  ["presence_penalty", "Presence penalty", true],
  ["repetition_penalty", "Repetition penalty", true],
  ["seed", "Seed (-1: none)", true],
  ["reasoning_effort", "Reasoning effort", false],
  ["verbosity", "Verbosity", false]
]

/** What an empty field means where the default isn't a fixed number. */
const DEFAULT_LABELS: Partial<Record<SamplerKey, string>> = {
  openai_max_context: "Its window",
  openai_max_tokens: `Up to ${DEFAULT_RESPONSE}`
}

/** Edits the user's overrides. Empty fields fall back to what the provider reports. */
export function ModelSettingsEditor({ model, onSaved }: { model: Model; onSaved?: () => void }) {
  const action = useAction()
  const [committed, setCommitted] = useState<Model | null>(null)
  const savedModel = committed ?? model
  const durable = useUserDraft(
    `model:${model.id}`,
    "Custom settings",
    JSON.stringify({
      name: savedModel.overrides.name ?? "",
      context: savedModel.overrides.context?.toString() ?? "",
      maxOutput: savedModel.overrides.maxOutput?.toString() ?? "",
      vision: triOf(savedModel.overrides.vision),
      reasoning: triOf(savedModel.overrides.reasoning),
      tools: triOf(savedModel.overrides.tools),
      prefill: savedModel.overrides.prefill ?? "auto",
      capabilities: JSON.stringify(savedModel.overrides, null, 2),
      settings: JSON.stringify(savedModel.overrides.settings ?? {}, null, 2),
      drafts: {},
      rowVersion: savedModel.rowVersion
    })
  )
  const values = JSON.parse(durable.text) as {
    name: string
    context: string
    maxOutput: string
    vision: Tri
    reasoning: Tri
    tools: Tri
    prefill: PrefillChoice
    capabilities: string
    settings: string
    drafts: Readonly<Record<string, string>>
    rowVersion: number
  }
  const { name, context, maxOutput, vision, reasoning, tools, prefill, capabilities, settings, drafts } = values
  const edit = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) =>
    durable.setText(JSON.stringify({ ...values, [key]: value }))
  const setName = (value: string) => edit("name", value)
  const setContext = (value: string) => edit("context", value)
  const setMaxOutput = (value: string) => edit("maxOutput", value)
  const setVision = (value: Tri) => edit("vision", value)
  const setReasoning = (value: Tri) => edit("reasoning", value)
  const setTools = (value: Tri) => edit("tools", value)
  const setPrefill = (value: PrefillChoice) => edit("prefill", value)
  const setCapabilities = (value: string) => edit("capabilities", value)
  const [problem, setProblem] = useState<string | null>(null)
  let current: typeof ModelSettings.Type | null = null
  try {
    current = Schema.decodeUnknownSync(ModelSettings)(JSON.parse(settings))
  } catch {
    // The JSON editor shows the problem on save; the fields wait until it's valid.
  }
  const replaceSettings = (next: string) => {
    durable.setText(JSON.stringify({ ...values, settings: next, drafts: {} }))
  }
  const contextValue = parseOptionalInt(context, 1)
  const maxOutputValue = parseOptionalInt(maxOutput, 1)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (contextValue.problem || maxOutputValue.problem) return focusFirstInvalid(event.currentTarget)
    let extra: ModelOverrides
    try {
      extra = Schema.decodeUnknownSync(ModelOverrides)(JSON.parse(capabilities))
    } catch {
      setProblem("Check the advanced capabilities JSON.")
      return
    }
    let parsed: typeof ModelSettings.Type
    try {
      parsed = Schema.decodeUnknownSync(ModelSettings)(JSON.parse(settings))
    } catch {
      setProblem("Check the advanced settings JSON and its values.")
      return
    }
    if (Object.values(drafts).some((text) => text.trim() !== "" && !Number.isFinite(Number(text)))) {
      setProblem("Check the generation settings: each takes a number, or nothing for the default.")
      return
    }
    const flag = (tri: Tri) => (tri === "auto" ? undefined : tri === "yes")
    const overrides: ModelOverrides = Object.fromEntries(
      Object.entries({
        ...extra,
        settings: parsed,
        name: name.trim() || undefined,
        context: contextValue.value ?? undefined,
        maxOutput: maxOutputValue.value ?? undefined,
        vision: flag(vision),
        reasoning: flag(reasoning),
        tools: flag(tools),
        prefill: prefill === "auto" ? undefined : prefill
      }).filter(([, value]) => value !== undefined)
    )
    await durable
      .commit(durable.text, async () => {
        const result = await action.run(
          (client) =>
            client("EditModel", {
              modelId: model.id,
              overrides,
              expectedRowVersion:
                committed === null ? values.rowVersion : Math.max(values.rowVersion, committed.rowVersion)
            }),
          ["models"]
        )
        if (result.ok) {
          setCommitted(result.value)
        }
        return result.ok
      })
      .then((ok) => {
        if (ok) onSaved?.()
      })
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]" noValidate>
      <UserDraftStatus draft={durable} />
      <Field label="Display name">
        <Input value={name} onValueChange={setName} placeholder={model.upstream.name ?? model.key} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Context window (tokens)"
          description="The most the model takes. Empty: what the provider reports."
          error={contextValue.problem}
        >
          <Input
            value={context}
            onValueChange={setContext}
            inputMode="numeric"
            placeholder={model.upstream.context?.toString()}
          />
        </Field>
        <Field
          label="Max output (tokens)"
          description="The most it writes in one reply. Empty: what the provider reports."
          error={maxOutputValue.problem}
        >
          <Input
            value={maxOutput}
            onValueChange={setMaxOutput}
            inputMode="numeric"
            placeholder={model.upstream.maxOutput?.toString()}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
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
      <div className="grid gap-3 sm:grid-cols-2">
        {SETTING_FIELDS.map(([key, label, numeric]) => {
          const value = current?.samplers?.[key]
          return (
            <Field key={key} label={label}>
              <Input
                value={drafts[key] ?? (value === undefined ? "" : String(value))}
                placeholder={DEFAULT_LABELS[key] ?? String(DEFAULT_SAMPLERS[key])}
                inputMode={numeric ? "decimal" : undefined}
                disabled={current === null}
                onValueChange={(text) => {
                  if (current === null) return
                  const { [key]: _, ...rest } = current.samplers ?? {}
                  void _
                  const number = Number(text)
                  // Empty means the default; a number not yet complete stays a draft.
                  const samplers =
                    text.trim() === ""
                      ? rest
                      : !numeric
                        ? { ...rest, [key]: text }
                        : Number.isFinite(number)
                          ? { ...rest, [key]: number }
                          : (current.samplers ?? {})
                  durable.setText(
                    JSON.stringify({
                      ...values,
                      settings: JSON.stringify({ ...current, samplers }, null, 2),
                      drafts: { ...drafts, [key]: text }
                    })
                  )
                }}
              />
            </Field>
          )
        })}
      </div>
      <Field
        label="Advanced model settings (JSON)"
        description='Stop strings, logit bias, streaming, cache retention, provider routing and wire roles. Example: {"stop":["END"],"squash":true,"names_behavior":"content","cacheRetention":"long"}'
      >
        <Textarea
          className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-sm text-text"
          value={settings}
          onChange={(event) => replaceSettings(event.currentTarget.value)}
        />
      </Field>
      <details>
        <summary className="cursor-pointer text-sm text-muted">
          Advanced capabilities: images, wire compatibility, cache and sampling
        </summary>
        <Field
          label="Capability overrides (JSON)"
          description='For example: {"maxImages":8,"midChatSystem":true,"cacheTtlS":300,"cacheBreakpoints":"explicit","compat":{"supportsSystemRole":false}}. The controls above take precedence for their fields.'
        >
          <Textarea
            className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-sm text-text"
            value={capabilities}
            onChange={(event) => setCapabilities(event.currentTarget.value)}
          />
        </Field>
      </details>
      {problem && (
        <Alert tone="danger" title="Not saved">
          {problem}
        </Alert>
      )}
      <StSettingsImporter
        surface="model"
        apply={async (preview) => {
          if (!preview.model) return
          const base = current ?? {}
          replaceSettings(
            JSON.stringify(
              { ...base, ...preview.model, samplers: { ...base.samplers, ...preview.model.samplers } },
              null,
              2
            )
          )
        }}
      />
      <ErrorAlert
        error={action.error}
        title="Not saved"
        actions={
          action.error?.tag === "StaleWrite" ? (
            <Button
              variant="ghost"
              onClick={() =>
                void durable.discard(async () => {
                  const result = await action.run((client) =>
                    client("ListModels", { connectionId: model.connectionId, includeHidden: true })
                  )
                  if (!result.ok) return false
                  const latest = result.value.find((entry) => entry.id === model.id)
                  if (!latest) return false
                  setCommitted(latest)
                  return true
                })
              }
            >
              Load the latest
            </Button>
          ) : undefined
        }
      />
      <Button type="submit" variant="primary" pending={action.pending}>
        Save model settings
      </Button>
    </form>
  )
}

function EditModelDialog({ model, onOpenChange }: { model: Model; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Edit ${model.key}`}
      description="Model settings apply everywhere this connection and model are used."
    >
      <ModelSettingsEditor model={model} onSaved={() => onOpenChange(false)} />
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
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Add a model"
      description="For a model the provider doesn't list. Use the exact id the API expects."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <UserDraftStatus draft={durable} />
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
