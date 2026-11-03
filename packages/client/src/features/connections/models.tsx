import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { DEFAULT_RESPONSE, DEFAULT_SAMPLERS, ModelSettings } from "@rp/shared/modelSettings.ts"
import { Schema } from "effect"
import { StSettingsImporter } from "./StSettingsImport.tsx"
// A connection's models: what the provider lists, merged with the user's edits
// (spec/PROVIDERS.md §3.1). Each field shows where its value came from.
import type { ModelRefresh } from "@rp/shared/api.ts"
import { type CatalogMatch, type FieldSource, type Model, ModelOverrides, resolveModel } from "@rp/shared/providers.ts"
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Fieldset, focusFirstInvalid, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { modelsAtom, parseOptionalInt } from "./data.ts"
import type { ConnectionSectionProps } from "./detail.tsx"

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))

/** Where a field's value came from, in words. */
export const sourceTitle = (
  source: FieldSource,
  model: { readonly catalog: CatalogMatch | null },
  unknown = "Unknown: no source reports it, so a safe default is used"
) =>
  source === "user"
    ? "Set by you"
    : source === "learned"
      ? "Learned from the provider's context-length error"
      : source === "catalog" && model.catalog
        ? `From ${model.catalog.label} (${model.catalog.match})`
        : source === "unknown"
          ? unknown
          : "Reported by the provider"

/** A field's value, marked when no source knows it (the default is shown, never as fact). */
function Value({
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

/** The model settings fields a link can open at. */
export type ModelField = "context" | "maxOutput" | "openai_max_context" | "openai_max_tokens"

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
/** "Auto" names what the provider says, so the choice reads without opening it. */
const triItems = (upstream: boolean | undefined) => [
  {
    value: "auto" as const,
    label: upstream === undefined ? "Unknown" : `Provider: ${upstream ? "yes" : "no"}`,
    description:
      upstream === undefined
        ? "Treated as no until the provider reports it or you choose."
        : "Use what the provider reports, including later updates."
  },
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
        ? "Unknown"
        : upstream === "assistant"
          ? "Provider: yes"
          : upstream === "tool_schema"
            ? "Provider: yes, the OpenAI way"
            : "Provider: no",
    description:
      upstream === undefined
        ? "No prefill is sent, and Continue stays off until you choose."
        : "Use what the provider reports, including later updates."
  },
  {
    value: "assistant" as const,
    label: "Yes",
    description: "Start replies with the preset’s prefill, and let Continue pick up where a reply stopped."
  },
  {
    value: "none" as const,
    label: "No",
    description: "Leave out the preset’s prefill. Continue asks the model to go on from the reply so far."
  },
  {
    value: "tool_schema" as const,
    label: "Yes, the OpenAI way",
    description: "Start OpenAI replies with the preset’s prefill."
  }
]

type SamplerKey = keyof NonNullable<ModelSettings["samplers"]>

/** The generation settings with fields of their own; the rest are in the JSON below them. */
const SETTING_FIELDS: ReadonlyArray<readonly [key: SamplerKey, label: string, numeric: boolean]> = [
  ["openai_max_context", "Context to send (tokens)", true],
  ["openai_max_tokens", "Reply length (tokens)", true],
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
  openai_max_context: "All of its window",
  openai_max_tokens: `Up to ${DEFAULT_RESPONSE}`
}

/**
 * One of the model's limits as its sources report it, read-only; the pencil opens the user's
 * own value, which wins over theirs. Open from the start when the user has one, or when a link
 * asked for this field.
 */
function Limit({
  label,
  field,
  resolved,
  model,
  value,
  onValueChange,
  problem,
  open: initiallyOpen,
  assumed = false
}: {
  label: string
  field: ModelField
  /** What the sources under the user's own value say. */
  resolved: ReturnType<typeof resolveModel>["context"]
  model: ReturnType<typeof resolveModel>
  value: string
  onValueChange: (value: string) => void
  problem: string | null
  open: boolean
  /** A window nobody reports is assumed, and says so (`ASSUMED_CONTEXT`). */
  assumed?: boolean
}) {
  const [editing, setEditing] = useState(initiallyOpen)
  const open = editing || value !== ""
  // The pencil's click moves the cursor into the field it opens, once that's there.
  const input = useRef<HTMLInputElement>(null)
  const focusing = useRef(false)
  useEffect(() => {
    if (!open || !focusing.current) return
    focusing.current = false
    input.current?.focus()
  }, [open])
  const unknown = resolved.source === "unknown"
  const source =
    unknown && assumed
      ? "Assumed: nothing reports this model's window. Set it, or Refresh from provider to match it in a catalog."
      : unknown
        ? "Not reported: a safe default is used."
        : `${sourceTitle(resolved.source, model)}.`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex max-w-controls items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-sm">
            <span className={`tabular-nums ${unknown && assumed ? "font-medium text-warning" : ""}`}>
              {resolved.value.toLocaleString()} tokens
            </span>{" "}
            <span className="text-xs text-muted">{source}</span>
          </span>
        </div>
        <IconButton
          icon="edit"
          disabled={open}
          focusableWhenDisabled
          hint={open ? "This limit is already open for editing." : `Set the ${label.toLowerCase()} yourself.`}
          label={`Set the ${label.toLowerCase()} yourself`}
          onClick={() => {
            focusing.current = true
            setEditing(true)
          }}
        />
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
          <Field
            label={`Your ${label.toLowerCase()} (tokens)`}
            about="Use this limit instead of the reported one. Empty uses the reported limit."
            error={problem}
          >
            <Input
              ref={input}
              value={value}
              onValueChange={onValueChange}
              inputMode="numeric"
              data-model-field={field}
              placeholder={String(resolved.value)}
            />
          </Field>
          <Button
            variant="ghost"
            className="self-start"
            hint="Clears your value, so what the provider reports applies again."
            onClick={() => {
              onValueChange("")
              setEditing(false)
            }}
          >
            Use what&rsquo;s reported
          </Button>
        </div>
      )}
    </div>
  )
}

/** A headed part of the form: what's reported, what it can do, your settings. A fieldset, named by its title. */
function Section({ title, about, children }: { title: string; about?: string; children: ReactNode }) {
  return (
    <Fieldset
      legend={<span className="text-base font-semibold">{title}</span>}
      aboutLabel={title}
      about={about}
      className="gap-3 pt-2"
    >
      {children}
    </Fieldset>
  )
}

/** Edits the user's overrides. Empty fields fall back to what the provider reports. */
export function ModelSettingsEditor({
  model,
  onSaved,
  focus
}: {
  model: Model
  onSaved?: () => void
  /** A field to focus when it opens, as a link from the budget note asks. */
  focus?: ModelField | undefined
}) {
  const action = useAction()
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!focus) return
    const input = form.current?.querySelector<HTMLInputElement>(`[data-model-field="${focus}"]`)
    input?.scrollIntoView({ block: "center" })
    input?.focus()
  }, [focus])
  const forget = useAction()
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
        // A learned size is saved and forgotten by its own buttons, never by a draft's stale copy.
        learned: savedModel.overrides.learned,
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
    let savedVersion = values.rowVersion
    await durable
      .commit(
        durable.text,
        async () => {
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
            savedVersion = result.value.rowVersion
            setCommitted(result.value)
          }
          return result.ok
        },
        (text) => JSON.stringify({ ...JSON.parse(text), rowVersion: savedVersion })
      )
      .then((ok) => {
        if (ok) onSaved?.()
      })
  }

  // What an empty limit means: the sources under the user's own values.
  const { context: _own, maxOutput: _ownOutput, ...beneathOverrides } = savedModel.overrides
  void _own
  void _ownOutput
  const effective = resolveModel(model.key, savedModel.upstream, beneathOverrides)
  const learned = savedModel.overrides.learned
  return (
    <form ref={form} onSubmit={submit} className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]" noValidate>
      <UserDraftStatus draft={durable} history />
      <Field label="Display name">
        <Input value={name} onValueChange={setName} placeholder={model.upstream.name ?? model.key} />
      </Field>
      <Section title="Model limits" about="Set how much the model can read and write if the reported limits are wrong.">
        <Limit
          label="Context window"
          field="context"
          resolved={effective.context}
          model={effective}
          value={context}
          onValueChange={setContext}
          problem={contextValue.problem}
          open={focus === "context"}
          assumed
        />
        <Limit
          label="Longest reply"
          field="maxOutput"
          resolved={effective.maxOutput}
          model={effective}
          value={maxOutput}
          onValueChange={setMaxOutput}
          problem={maxOutputValue.problem}
          open={focus === "maxOutput"}
        />
      </Section>
      {learned && (
        <Alert
          title={`Learned context size: ${learned.context.toLocaleString()} tokens`}
          actions={
            <Button
              variant="ghost"
              pending={forget.pending}
              hint="Stops using the learned size, so the provider’s figure applies again."
              onClick={async () => {
                const result = await forget.run(
                  (client) => client("SaveLearnedContext", { modelId: model.id, context: null }),
                  ["models"]
                )
                if (result.ok) setCommitted(result.value)
              }}
            >
              Forget it
            </Button>
          }
        >
          Saved from the provider&rsquo;s context-length error on {new Date(learned.at).toLocaleDateString()}. It stands
          in for the provider&rsquo;s figure; a window you set above wins over it.
          <ErrorAlert error={forget.error} />
        </Alert>
      )}
      <Section title="What it can do">
        {/* Two columns only where there's room for the choices (a dialog, not the chat's panel). */}
        <div className="@container">
          <div className="grid gap-4 @lg:grid-cols-2">
            <Field label="Vision" about="Let the model see images. No leaves images out of its requests.">
              <Select items={triItems(model.upstream.vision)} value={vision} onValueChange={setVision} />
            </Field>
            <Field
              label="Reasoning"
              about="Let the model think before replying. Reasoning effort controls how much thinking to ask for."
            >
              <Select items={triItems(model.upstream.reasoning)} value={reasoning} onValueChange={setReasoning} />
            </Field>
            <Field
              label="Tools"
              about="Mark whether the model can call tools. Tool use isn’t available yet, so this has no effect."
            >
              <Select items={triItems(model.upstream.tools)} value={tools} onValueChange={setTools} />
            </Field>
            <Field
              label="Prefill"
              about="Let replies start with text you supply, for the preset’s prefill and Continue. Choose Yes only if the model supports it."
            >
              <Select items={prefillItems(model.upstream.prefill)} value={prefill} onValueChange={setPrefill} />
            </Field>
          </div>
        </div>
      </Section>
      <Section
        title="Your settings for this model"
        about="Choose how much context to send and how replies are written. Empty uses the default shown; context and reply length stay within the model’s limits."
      >
        {/* Numbers: two a row in a narrow panel, more as it widens, none wider than it needs. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {SETTING_FIELDS.map(([key, label, numeric]) => {
            const value = current?.samplers?.[key]
            return (
              <Field key={key} label={label}>
                <Input
                  data-model-field={key}
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
      </Section>
      <Field
        label="Advanced model settings (JSON)"
        about='Control stopping, word preferences, streaming, prompt reuse, routing and message roles. Example: {"stop":["END"],"squash":true,"names_behavior":"content","cacheRetention":"long"}'
      >
        <Textarea
          className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-sm text-text"
          value={settings}
          onChange={(event) => replaceSettings(event.currentTarget.value)}
        />
      </Field>
      <details>
        <summary className="cursor-pointer text-sm text-muted">Advanced capabilities</summary>
        <Field
          label="Capability overrides (JSON)"
          about='For example: {"maxImages":8,"midChatSystem":true,"cacheTtlS":300,"cacheBreakpoints":"explicit","compat":{"supportsSystemRole":false}}. For settings shown above, use those controls instead.'
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
              hint="Drops your changes here and shows the settings saved meanwhile."
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
      <Button
        type="submit"
        variant="primary"
        pending={action.pending}
        className="self-start"
        hint="Saves these settings for this model, in every chat that uses it."
      >
        Save model settings
      </Button>
    </form>
  )
}

function EditModelDialog({
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
    <Dialog open onOpenChange={onOpenChange} title={model ? `Edit ${model.key}` : "Model settings"}>
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
    <Dialog open onOpenChange={onOpenChange} title="Add a model">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <UserDraftStatus draft={durable} />
        <Field label="Model id" about="The exact id the provider's API expects.">
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
  const [selectedModel, setSelectedModel] = usePlaceParam("model", "")
  const editing = selectedModel === model.id
  const setEditing = (on: boolean) => setSelectedModel(on ? model.id : "")
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
        {resolved.name.value !== model.key && (
          <p className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{model.key}</p>
        )}
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <span>
            Context <Value resolved={resolved.context} model={resolved} show={tokens} assumed />
          </span>
          <span>
            Output <Value resolved={resolved.maxOutput} model={resolved} show={tokens} />
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
          hint={
            model.hidden
              ? "Lists it again where you choose a model."
              : "Leaves it out of the lists where you choose a model."
          }
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
  const [hidden, setHidden] = usePlaceParam("models", "visible", ["visible", "all"])
  const includeHidden = hidden === "all"
  const setIncludeHidden = (on: boolean) => setHidden(on ? "all" : "visible", true)
  const [selectedModel] = usePlaceParam("model", "")
  const modelAtom = modelsAtom(connection.id, includeHidden || selectedModel !== "")
  const modelList = useAtomValue(modelAtom)
  usePlaceNotice(
    selectedModel && AsyncResult.isSuccess(modelList) && !modelList.value.some((m) => m.id === selectedModel)
      ? "This model is no longer available on this connection."
      : null
  )
  const [adding, setAdding] = useState(false)
  const [refreshed, setRefreshed] = useState<ModelRefresh | null>(null)
  return (
    <Card>
      <CardHeader
        title="Models"
        about="* marks your own values, ? values nobody reports; a context size nobody reports is assumed."
        actions={
          <>
            <Button
              pending={refresh.pending}
              hint="Reads the provider’s model list again. Your own settings for each model stay."
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
            <Button
              variant="ghost"
              hint="Adds one the provider doesn’t list, by its id."
              onClick={() => setAdding(true)}
            >
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
        <AsyncView atom={modelAtom} loading="Loading models…">
          {(models) =>
            models.length === 0 ? (
              <EmptyState title="No models">
                <p>Refresh from the provider, or add one by its id.</p>
              </EmptyState>
            ) : (
              <ul className="flex flex-col divide-y divide-border" aria-label="Models">
                {models
                  .filter((model) => includeHidden || !model.hidden || model.id === selectedModel)
                  .map((model) => (
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
