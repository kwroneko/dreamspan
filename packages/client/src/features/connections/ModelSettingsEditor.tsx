// A model's settings (spec/PROVIDERS.md §3.1): its name, how it thinks, how much it reads and
// writes within its limits, its samplers and what it can do; the rest under Advanced. Every
// value is a control: the stored overrides and settings are edited path by path, and what has no
// control of its own is kept as it was.
import { useAtomValue } from "@effect/atom-react"
import { DEFAULT_RESPONSE, ModelSettings, supportedEfforts } from "@dreamspan/shared/modelSettings.ts"
import {
  type CatalogMatch,
  ENDPOINTS_RETRY_MS,
  endpointsStale,
  type FieldSource,
  type PriceSource,
  type Model,
  ModelOverrides,
  pinnedRoute,
  resolveModel,
  routedPrice,
  routedUpstream
} from "@dreamspan/shared/providers.ts"
import { SAMPLER_KEYS, samplersSent, takesVerbosity } from "@dreamspan/shared/samplerRules.ts"
import { AsyncResult } from "effect/reactivity"
import { Schema } from "effect"
import { type FormEvent, Fragment, type ReactNode, useEffect, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { AboutHint, LabelWithHelp } from "../../ui/AboutHint.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset, Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Disclosure } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { CopySettingsButton } from "./CopySettings.tsx"
import { connectionsAtom } from "./data.ts"
import { Group, type Limit, RangeField, RowsEditor } from "./modelControls.tsx"
import {
  biasRowProblem,
  draftProblems,
  type FieldId,
  NUMBER_RULES,
  parseNumber,
  SAMPLERS,
  wholeText
} from "./modelFields.ts"
import {
  copyInto,
  type Draft,
  draftOf,
  flagOf,
  getAt,
  isScalar,
  listOf,
  type PrefillChoice,
  readDraft,
  recordOf,
  type Row,
  rowsOf,
  setAt,
  showList,
  type Tri,
  typeOf,
  parseTyped
} from "./modelForm.ts"
import { breakpointItems } from "./providerFields.tsx"
import { ReasoningEffortSelect } from "./ReasoningEffort.tsx"
import { StSettingsImporter } from "./StSettingsImport.tsx"

/** The model settings fields a link can open at. */
export type ModelField = "context" | "maxOutput" | "openai_max_context" | "openai_max_tokens"

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

/** Several models at once: "Auto" leaves each to what its own provider reports. */
const EACH = {
  label: "Each model’s own",
  description: "Removes your choice, so each model uses what its provider reports."
}

/** "Auto" names what the provider says, so the choice reads without opening it. */
const triItems = (upstream: boolean | undefined | "each", assumed: "yes" | "no" = "no") => [
  upstream === "each"
    ? { value: "auto" as const, ...EACH }
    : {
        value: "auto" as const,
        label:
          upstream === undefined
            ? assumed === "yes"
              ? "Yes (assumed)"
              : "Unknown"
            : `Provider: ${upstream ? "yes" : "no"}`,
        description:
          upstream === undefined
            ? assumed === "yes"
              ? "The provider doesn’t say, so it’s assumed. Choose No if the model refuses it."
              : "Treated as no until the provider reports it or you choose."
            : "Use what the provider reports, including later updates."
      },
  { value: "yes" as const, label: "Yes" },
  { value: "no" as const, label: "No" }
]

/** Whether the model takes the start of its reply natively or through a strict tool schema. */
const prefillItems = (upstream: ModelOverrides["prefill"] | "each") => [
  upstream === "each"
    ? { value: "auto" as const, ...EACH }
    : {
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

const NAMES_ITEMS = [
  { value: "default", label: "Default", description: "“Name: ” before characters’ messages, in group chats only." },
  { value: "none", label: "None", description: "No names." },
  { value: "completion", label: "Message name field", description: "Each message’s name field." },
  { value: "content", label: "In the message text", description: "“Name: ” before each message’s text." }
] as const

const POSTPROCESS_ITEMS = [
  { value: "none", label: "None" },
  { value: "merge", label: "Merge consecutive roles" },
  { value: "merge_tools", label: "Merge consecutive roles, with tools" },
  { value: "semi", label: "Semi-strict" },
  { value: "semi_tools", label: "Semi-strict, with tools" },
  { value: "strict", label: "Strict" },
  { value: "strict_tools", label: "Strict, with tools" },
  { value: "single", label: "Single user message" }
] as const

const RETENTION_ITEMS = [
  { value: "default", label: "Default", description: "The provider’s usual prompt caching." },
  { value: "none", label: "None", description: "No prompt caching: no cache markers are sent." },
  { value: "short", label: "Short", description: "The provider’s short cache lifetime (Anthropic: 5 minutes)." },
  { value: "long", label: "Long", description: "The provider’s long cache lifetime (Anthropic: 1 hour)." }
] as const

const VERBOSITY_ITEMS = [
  { value: "auto", label: "Auto", description: "The model’s default." },
  { value: "low", label: "Low", description: "Short, terse answers." },
  { value: "medium", label: "Medium", description: "Answers of the usual length." },
  { value: "high", label: "High", description: "Long, detailed answers." }
] as const

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

/** The routing fields with controls of their own (OpenRouter's `provider` object). */
const ROUTING_LISTS = [
  [
    "only",
    "Only these providers",
    "Sends the model only to these providers, by OpenRouter’s slug (together, deepinfra/fp8)."
  ],
  ["order", "Try in this order", "Tries these providers first, in order."],
  ["ignore", "Never these providers", "Never sends the model to these providers."]
] as const
const ROUTING_OWN = ["only", "order", "ignore", "allow_fallbacks"]

/** Stop strings: a line break or tab can't be typed in a one-line field, so they read as \n and \t. */
const showEscaped = (text: string) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t")
const unescape = (text: string) =>
  text.replace(/\\(\\|n|t)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"))

/** A column of the form: its own container, so each group's layout follows the column's width. */
const COLUMN = "@container flex min-w-0 flex-col gap-5"

/** What an empty limit means for `model`: the sources under the user's own values. */
export const effectiveLimits = (model: Model) => {
  const { context: _own, maxOutput: _ownOutput, ...beneathOverrides } = model.overrides
  void _own
  void _ownOutput
  return resolveModel(model.key, model.upstream, beneathOverrides)
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
  const forget = useAction()
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!focus) return
    const input = form.current?.querySelector<HTMLInputElement>(`[data-model-field="${focus}"]`)
    input?.scrollIntoView({ block: "center" })
    input?.focus()
  }, [focus])
  const [committed, setCommitted] = useState<Model | null>(null)
  const savedModel = committed ?? model
  const saved = draftOf(savedModel.overrides, savedModel.rowVersion)
  const durable = useUserDraft(`model:${model.id}`, "Custom settings", JSON.stringify(saved))
  const values = readDraft(durable.text, saved)
  const update = (next: Draft) => durable.setText(JSON.stringify(next))
  const [submitted, setSubmitted] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const settings = values.settings
  const routing = { ...model.upstream.settings, ...(settings as ModelSettings) }.routing
  useEndpointsFetch(model, pinnedRoute(routing) !== null)
  const problems = draftProblems(values)
  const contextLimit = wholeText(values.context)
  const outputLimit = wholeText(values.maxOutput)
  const biasProblem = (values.rows["settings.logit_bias"] ?? rowsOf(settings.logit_bias)).some(biasRowProblem)
  const effective = effectiveLimits(savedModel)
  const window = contextLimit.value ?? effective.context.value
  const maxOutput = outputLimit.value ?? effective.maxOutput.value

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    setProblem(null)
    if (contextLimit.problem || outputLimit.problem || Object.keys(problems).length > 0 || biasProblem) {
      setProblem("Check the fields marked below.")
      return
    }
    let settingsValue: ModelSettings
    let overrides: ModelOverrides
    try {
      settingsValue = Schema.decodeUnknownSync(ModelSettings)(settings)
      overrides = Schema.decodeUnknownSync(ModelOverrides)(
        Object.fromEntries(
          Object.entries({
            ...values.overrides,
            // A learned size is saved and forgotten by its own buttons, never by a draft's stale copy.
            learned: savedModel.overrides.learned,
            settings: settingsValue,
            name: values.name.trim() || undefined,
            context: contextLimit.value ?? undefined,
            maxOutput: outputLimit.value ?? undefined,
            vision: flagOf(values.vision),
            reasoning: flagOf(values.reasoning),
            tools: flagOf(values.tools),
            prefill: values.prefill === "auto" ? undefined : values.prefill
          }).filter(([, value]) => value !== undefined)
        )
      )
    } catch {
      setProblem("A setting under Advanced has a value the model can’t take. Check its rows.")
      return
    }
    let savedVersion = values.rowVersion
    const ok = await durable.commit(
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
      (text) => JSON.stringify({ ...JSON.parse(text), rowVersion: savedVersion, drafts: {}, rows: {}, clamped: {} })
    )
    if (ok) {
      setSubmitted(false)
      onSaved?.()
    }
  }

  const learned = savedModel.overrides.learned
  return (
    <form
      ref={form}
      onSubmit={submit}
      className="@container flex min-w-0 flex-col gap-5 [overflow-wrap:anywhere]"
      noValidate
    >
      <UserDraftNotices draft={durable} />
      <ModelFields
        models={[savedModel]}
        values={values}
        update={update}
        submitted={submitted}
        focus={focus}
        top={
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 basis-64 @2xl:max-w-xl">
              <Field label="Display name" labelEnd={<UserDraftUndo draft={durable} />}>
                <Input
                  value={values.name}
                  onValueChange={(name) => update({ ...values, name })}
                  placeholder={model.upstream.name ?? model.key}
                />
              </Field>
            </div>
            <CopySettingsButton
              model={model}
              onCopy={(source, label) =>
                update(copyInto(values, source.overrides, label, { context: window, maxOutput }))
              }
            />
          </div>
        }
        learned={
          learned && (
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
              Saved from the provider&rsquo;s context-length error on {new Date(learned.at).toLocaleDateString()}. A
              window you set wins over it.
              <ErrorAlert error={forget.error} />
            </Alert>
          )
        }
      />
      {problem && (
        <Alert tone="danger" title="Not saved">
          {problem}
        </Alert>
      )}
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

/**
 * The form's fields, for one model (`ModelSettingsEditor`) or for many at once (the model list's
 * Edit N…, `many`): there, each choice's Auto leaves every model to its own provider, the sliders
 * reach the largest limit among them, and `wrap` puts each field beside its tick.
 */
export function ModelFields({
  models,
  many = false,
  values,
  update,
  submitted,
  focus,
  top,
  learned,
  wrap = (_, node) => node
}: {
  /** The model edited, as saved; with `many`, every model selected. */
  models: ReadonlyArray<Model>
  many?: boolean
  values: Draft
  update: (next: Draft) => void
  /** Save was pressed: problems show beside their fields. */
  submitted: boolean
  focus?: ModelField | undefined
  /** Above the first group: the display name and Copy settings from…. */
  top: ReactNode
  /** Under Length: the learned context size, for one model. */
  learned?: ReactNode
  wrap?: (field: FieldId, node: ReactNode) => ReactNode
}) {
  const one = many ? null : (models[0] ?? null)
  // The Advanced section's state is in the URL, so a reload opens it again.
  const [advanced, setAdvanced] = usePlaceParam("modelAdvanced", "")

  // The connections' providers and APIs: which samplers and options they take. Unknown, all show.
  const connections = useAtomValue(connectionsAtom)
  const wires = models.map((model) => {
    const connection = AsyncResult.isSuccess(connections)
      ? connections.value.find((entry) => entry.id === model.connectionId)
      : undefined
    return connection ? { kind: connection.kind, api: connection.api, key: model.key } : null
  })
  const known = wires.length > 0 && wires.every((wire) => wire !== null)
  const knownWires = known ? (wires as ReadonlyArray<NonNullable<(typeof wires)[number]>>) : []

  // What an empty limit means: the sources under the user's own values (the largest, for many).
  const limits = models.map(effectiveLimits)
  const effective = one
    ? limits[0]!
    : {
        context: { value: Math.max(...limits.map((limit) => limit.context.value)), source: "user" as const },
        maxOutput: { value: Math.max(...limits.map((limit) => limit.maxOutput.value)), source: "user" as const },
        catalog: null
      }
  // The capabilities as edited, for what they unlock (reasoning effort's levels).
  const edited = resolveModel(one?.key ?? "", one?.upstream ?? {}, {
    ...(values.overrides as ModelOverrides),
    ...(flagOf(values.reasoning) === undefined ? {} : { reasoning: flagOf(values.reasoning)! })
  })
  const settings = values.settings
  const routing = { ...one?.upstream.settings, ...(settings as ModelSettings) }.routing
  const routed = one ? routedUpstream(one.upstream, routing) : null
  const prefillFixed = routed?.upstream.fixed?.includes("prefill") ?? false
  const rules = routed?.upstream.shims ?? []
  const unpinned = routed?.unpinned ?? []
  const note = one ? priceNote(routedPrice(one.upstream, routing).source) : null
  /** What a choice's Auto says: the one model's provider, or each model's own. */
  const reported = <K extends "reasoning" | "vision" | "tools" | "midChatSystem">(field: K) =>
    one ? one.upstream[field] : ("each" as const)

  // Number fields: the text as typed, else the value stored.
  const textAt = (key: string, root: "settings" | "overrides", path: ReadonlyArray<string>) => {
    const draft = values.drafts[key]
    if (draft !== undefined) return draft
    const value = getAt(values[root], path)
    return typeof value === "number" ? String(value) : ""
  }
  const problems = draftProblems(values)
  const contextLimit = wholeText(values.context)
  const outputLimit = wholeText(values.maxOutput)
  const shownProblem = (key: string) => (submitted ? (problems[key] ?? null) : null)
  const window = contextLimit.value ?? effective.context.value
  const maxOutput = outputLimit.value ?? effective.maxOutput.value

  /** A copied value brought down to this model's limits stops saying so once it's changed. */
  const unclamped = (path: ReadonlyArray<string>) => {
    const { [path[path.length - 1] ?? ""]: _, ...rest } = values.clamped
    void _
    return rest
  }
  /** Sets a number at `path` from its text: a number when it is one, the text kept as typed. */
  const typeNumber = (root: "settings" | "overrides", path: ReadonlyArray<string>, text: string) => {
    const key = [root, ...path].join(".")
    const parsed = parseNumber(text, NUMBER_RULES[key] ?? { label: key })
    const { [key]: _, ...drafts } = values.drafts
    void _
    update({
      ...values,
      [root]: parsed.problem ? values[root] : setAt(values[root], path, parsed.value),
      drafts: text === "" ? drafts : { ...drafts, [key]: text },
      clamped: unclamped(path)
    })
  }
  /** Sets a value at `path`, its typed text gone. */
  const set = (root: "settings" | "overrides", path: ReadonlyArray<string>, value: unknown) => {
    const key = [root, ...path].join(".")
    const { [key]: _, ...drafts } = values.drafts
    void _
    update({ ...values, [root]: setAt(values[root], path, value), drafts, clamped: unclamped(path) })
  }
  const sampler = (key: string) => getAt(settings, ["samplers", key])

  // A list control's rows: as typed, else from what's stored.
  const rowsAt = (key: string, stored: () => ReadonlyArray<Row>) => values.rows[key] ?? stored()
  const setRows = (key: string, rows: ReadonlyArray<Row>, apply: (draft: Draft) => Draft) =>
    update(apply({ ...values, rows: { ...values.rows, [key]: rows } }))

  const stopRows = rowsAt("settings.stop", () =>
    (Array.isArray(settings.stop) ? (settings.stop as ReadonlyArray<string>) : []).map((stop) => ({
      name: "",
      value: showEscaped(stop)
    }))
  )
  const biasRows = rowsAt("settings.logit_bias", () => rowsOf(settings.logit_bias))
  const biasProblem = biasRows.some(biasRowProblem)
  const routingRecord = (getAt(settings, ["routing"]) ?? {}) as Record<string, unknown>
  const routingRows = rowsAt("settings.routing", () =>
    rowsOf(Object.fromEntries(Object.entries(routingRecord).filter(([key]) => !ROUTING_OWN.includes(key))))
  )
  const extraRows = rowsAt("overrides.sampling", () => rowsOf(values.overrides.sampling))
  const compatRows = rowsAt("overrides.compat", () => rowsOf(values.overrides.compat))
  const levelRows = rowsAt("overrides.thinkingLevels", () =>
    rowsOf(values.overrides.thinkingLevels, (value) => (typeof value === "string" ? value : ""))
  )
  /** A stored list or group a row can't show stays as it was; the row says so. */
  const keptTag = (stored: unknown) => (row: Row) => {
    const before = (stored as Record<string, unknown> | undefined)?.[row.name.trim()]
    if (before !== undefined && !isScalar(before) && before !== null && row.value === "")
      return typeOf(before) === "list" ? "list, kept" : "group, kept"
    return row.name.trim() === "" && row.value === "" ? null : typeOf(parseTyped(row.value))
  }

  const contextSetting = sampler("openai_max_context")
  const size = Math.min(typeof contextSetting === "number" ? contextSetting : window, window)
  const replyDefault = Math.max(1, Math.min(maxOutput, DEFAULT_RESPONSE, Math.floor(size / 2)))
  const limitSource = (resolved: typeof effective.context, assumed: boolean) =>
    resolved.source === "unknown"
      ? assumed
        ? "Assumed: nothing reports this model’s window. Set it with the pencil, or Refresh from provider to match it in a catalog."
        : "Not reported: a safe default is used. Set it with the pencil if you know it."
      : `${sourceTitle(resolved.source, effective)}.`

  const contextLimitControl: Limit = {
    name: "context window",
    value: window,
    source:
      contextLimit.value === null
        ? limitSource(effective.context, true)
        : `Set by you. Otherwise ${effective.context.value.toLocaleString()}: ${limitSource(effective.context, true)}`,
    assumed: contextLimit.value === null && effective.context.source === "unknown",
    own: values.context,
    onOwn: (context) => update({ ...values, context }),
    problem: submitted ? contextLimit.problem : null,
    open: focus === "context",
    field: "context"
  }
  const outputLimitControl: Limit = {
    name: "output limit",
    value: maxOutput,
    source:
      outputLimit.value === null
        ? limitSource(effective.maxOutput, false)
        : `Set by you. Otherwise ${effective.maxOutput.value.toLocaleString()}: ${limitSource(effective.maxOutput, false)}`,
    assumed: false,
    own: values.maxOutput,
    onOwn: (maxOutput) => update({ ...values, maxOutput }),
    problem: submitted ? outputLimit.problem : null,
    open: focus === "maxOutput",
    field: "maxOutput"
  }

  const clampNote = (key: string) => {
    const hint = values.clamped[key]
    return hint === undefined ? undefined : { text: "Limited", hint }
  }

  // What any of the models takes (all of it while a connection is unknown).
  const sent = known
    ? SAMPLER_KEYS.filter((key) => knownWires.some((wire) => samplersSent(wire).includes(key)))
    : SAMPLER_KEYS
  const shownSamplers = SAMPLER_KEYS.filter((key) => sent.includes(key) || sampler(key) !== undefined)
  const verbosity = sampler("verbosity")
  const showVerbosity =
    !known || knownWires.some(takesVerbosity) || (typeof verbosity === "string" && verbosity !== "auto")
  const isRouter =
    !known || knownWires.some((wire) => wire.kind === "openrouter") || Object.keys(routingRecord).length > 0
  const showBias =
    !known ||
    knownWires.some((wire) => wire.api === "openai-completions") ||
    Object.keys(rowsOf(settings.logit_bias)).length > 0
  const effort = sampler("reasoning_effort")
  const cacheLayout = (values.overrides.cacheLayout ?? {}) as Record<string, unknown>
  /** For many models: a value over one's limit is brought down to it there. */
  const eachLimit = many
    ? { text: "each within its limit", hint: "A value over a model’s limit is brought down to that limit on it." }
    : undefined

  return (
    <div className="@container/model-columns">
      {/* One column; two, then three (main | samplers | what it can do and Advanced) when wide. A column's first group starts level with the first, without its divider: the named container, as each column is a container of its own. */}
      <div className="grid items-start gap-x-10 gap-y-5 @5xl:grid-cols-2 @min-[88rem]:grid-cols-3" data-model-columns>
        <div className={`${COLUMN} @5xl:row-span-2 @min-[88rem]:row-span-1`}>
          {top}

          <Group title="Thinking">
            <div className="grid max-w-3xl gap-4 @md:grid-cols-2">
              {wrap(
                "reasoning",
                <Field
                  label="Reasoning"
                  about="Whether the model thinks before it replies. Assumed yes when the provider doesn’t say; choose No for a model that refuses reasoning settings."
                >
                  <Select
                    items={triItems(reported("reasoning"), "yes")}
                    value={values.reasoning}
                    onValueChange={(reasoning: Tri) => update({ ...values, reasoning })}
                  />
                </Field>
              )}
              {wrap(
                "reasoning_effort",
                <Field
                  label="Reasoning effort"
                  about="How much the model thinks: sent as the provider’s reasoning effort or thinking budget. Auto sends none, so the model’s default applies."
                >
                  <div data-model-field="reasoning_effort">
                    <ReasoningEffortSelect
                      value={typeof effort === "string" && effort !== "auto" ? effort : null}
                      levels={supportedEfforts(edited)}
                      defaultLabel="Auto"
                      defaultDescription="Sends no effort: the model’s default."
                      disabled={!edited.reasoning.value}
                      onValueChange={(level) => set("settings", ["samplers", "reasoning_effort"], level ?? undefined)}
                    />
                  </div>
                </Field>
              )}
            </div>
          </Group>

          <Group title="Length">
            <div className="grid gap-6 @4xl:grid-cols-2">
              {wrap(
                "openai_max_context",
                <RangeField
                  label="Context"
                  about="The most tokens a request sends: older history is cut to fit. Up to the model’s context window; empty uses all of it."
                  field="openai_max_context"
                  text={textAt("settings.samplers.openai_max_context", "settings", ["samplers", "openai_max_context"])}
                  value={typeof contextSetting === "number" ? contextSetting : null}
                  fallback={window}
                  placeholder="All"
                  min={Math.min(1024, window)}
                  max={window}
                  step={1024}
                  whole
                  scale="log"
                  {...(many ? {} : { limit: contextLimitControl })}
                  note={clampNote("openai_max_context") ?? eachLimit}
                  error={shownProblem("settings.samplers.openai_max_context")}
                  onText={(text) => typeNumber("settings", ["samplers", "openai_max_context"], text)}
                  onSlide={(value) =>
                    set("settings", ["samplers", "openai_max_context"], value >= window ? undefined : value)
                  }
                />
              )}
              {wrap(
                "openai_max_tokens",
                <RangeField
                  label="Reply length"
                  about={`The most tokens a reply may have (max_tokens). Up to the model’s output limit; empty uses ${DEFAULT_RESPONSE.toLocaleString()}, within the limit and half the context.`}
                  field="openai_max_tokens"
                  text={textAt("settings.samplers.openai_max_tokens", "settings", ["samplers", "openai_max_tokens"])}
                  value={
                    typeof sampler("openai_max_tokens") === "number" ? (sampler("openai_max_tokens") as number) : null
                  }
                  fallback={replyDefault}
                  min={Math.min(64, maxOutput)}
                  max={maxOutput}
                  step={64}
                  whole
                  scale="log"
                  {...(many ? {} : { limit: outputLimitControl })}
                  note={clampNote("openai_max_tokens") ?? eachLimit}
                  error={shownProblem("settings.samplers.openai_max_tokens")}
                  onText={(text) => typeNumber("settings", ["samplers", "openai_max_tokens"], text)}
                  onSlide={(value) => set("settings", ["samplers", "openai_max_tokens"], value)}
                />
              )}
              {/* For many models, their own limits are fields of their own: one model's sit at its sliders' ends. */}
              {many &&
                wrap(
                  "context",
                  <Field
                    label="Context window (tokens)"
                    about="Your own context window for each model, over what its provider reports. Empty uses what each reports."
                    error={submitted ? contextLimit.problem : null}
                  >
                    <Input
                      value={values.context}
                      onValueChange={(context) => update({ ...values, context })}
                      inputMode="numeric"
                      placeholder="As reported"
                      data-model-field="context"
                    />
                  </Field>
                )}
              {many &&
                wrap(
                  "maxOutput",
                  <Field
                    label="Output limit (tokens)"
                    about="Your own output limit for each model, over what its provider reports. Empty uses what each reports."
                    error={submitted ? outputLimit.problem : null}
                  >
                    <Input
                      value={values.maxOutput}
                      onValueChange={(maxOutput) => update({ ...values, maxOutput })}
                      inputMode="numeric"
                      placeholder="As reported"
                      data-model-field="maxOutput"
                    />
                  </Field>
                )}
            </div>
            {wrap(
              "context_target",
              <Field
                label="Trim history to (tokens)"
                about="When history no longer fits, older messages are cut until the request is this size, so later requests reuse the cache. Empty: 80% of the context."
                error={shownProblem("settings.context_target")}
              >
                <Input
                  value={textAt("settings.context_target", "settings", ["context_target"])}
                  onValueChange={(text) => typeNumber("settings", ["context_target"], text)}
                  inputMode="numeric"
                  placeholder={Math.floor(size * 0.8).toLocaleString()}
                  data-model-field="context_target"
                />
              </Field>
            )}
            {learned}
          </Group>

          <Group title="Reply">
            {showVerbosity &&
              wrap(
                "verbosity",
                <div className="flex flex-col gap-2">
                  <LabelWithHelp
                    help={
                      <AboutHint heading="Verbosity">
                        OpenAI’s verbosity parameter (GPT-5 and later): how long and detailed the answer is. Separate
                        from reasoning effort, which sets how much the model thinks.
                      </AboutHint>
                    }
                  >
                    <span className="text-sm font-medium text-text">Verbosity</span>
                  </LabelWithHelp>
                  <Segmented
                    label="Verbosity"
                    options={VERBOSITY_ITEMS}
                    value={typeof verbosity === "string" ? verbosity : "auto"}
                    onValueChange={(next) =>
                      set("settings", ["samplers", "verbosity"], next === "auto" ? undefined : next)
                    }
                  />
                </div>
              )}
            {wrap(
              "stream",
              <Switch
                checked={settings.stream !== false}
                onCheckedChange={(on) => set("settings", ["stream"], on ? undefined : false)}
                about="Off: the reply shows once it’s finished."
              >
                Show the reply as it’s written
              </Switch>
            )}
            {wrap(
              "stop",
              <RowsEditor
                label="Stop strings"
                about="The reply ends where one of these appears (stop sequences). Type \n for a line break."
                field="stop"
                rows={stopRows}
                value={{ label: "Stop string" }}
                add="Add a stop string"
                onRows={(rows) =>
                  setRows("settings.stop", rows, (draft) => {
                    const stops = rows.map((row) => unescape(row.value)).filter((stop) => stop !== "")
                    return { ...draft, settings: setAt(draft.settings, ["stop"], stops.length ? stops : undefined) }
                  })
                }
              />
            )}
          </Group>
        </div>
        <div
          className={`${COLUMN} @5xl:col-start-2 @5xl/model-columns:[&>:first-child]:border-t-0 @5xl/model-columns:[&>:first-child]:pt-0`}
        >
          {shownSamplers.length > 0 && (
            <Group
              title="Samplers"
              about={
                many
                  ? "The samplers the selected models’ providers take. Empty uses the default shown."
                  : "The samplers this connection’s provider takes for the model. Empty uses the default shown."
              }
            >
              <div className="grid gap-x-8 gap-y-5 @3xl:grid-cols-2">
                {shownSamplers.map((key) => {
                  const stored = sampler(key)
                  const unsent = known && !sent.includes(key)
                  const note = unsent
                    ? {
                        text: "not sent",
                        hint: many
                          ? "None of these models’ providers take it, so it isn’t sent."
                          : "This provider doesn’t take it for this model, so it isn’t sent."
                      }
                    : undefined
                  if (key === "seed")
                    return (
                      <Fragment key={key}>
                        {wrap(
                          key,
                          <Field
                            label="Seed"
                            about="The same seed and settings give the same reply, where the provider supports it. Empty: random."
                            error={shownProblem("settings.samplers.seed")}
                            labelEnd={note && <span className="text-xs text-muted">{note.text}</span>}
                          >
                            <Input
                              value={
                                values.drafts["settings.samplers.seed"] ??
                                (typeof stored === "number" && stored >= 0 ? String(stored) : "")
                              }
                              onValueChange={(text) =>
                                typeNumber("settings", ["samplers", "seed"], text.trim() === "-1" ? "" : text)
                              }
                              inputMode="numeric"
                              placeholder="Random"
                              data-model-field="seed"
                            />
                          </Field>
                        )}
                      </Fragment>
                    )
                  const spec = SAMPLERS[key]
                  return (
                    <Fragment key={key}>
                      {wrap(
                        key,
                        <RangeField
                          label={spec.label}
                          about={spec.about}
                          field={key}
                          text={textAt(`settings.samplers.${key}`, "settings", ["samplers", key])}
                          value={typeof stored === "number" ? stored : null}
                          fallback={spec.fallback}
                          min={spec.min}
                          max={spec.max}
                          step={spec.step}
                          {...(note ? { note } : {})}
                          error={shownProblem(`settings.samplers.${key}`)}
                          onText={(text) => typeNumber("settings", ["samplers", key], text)}
                          onSlide={(value) => set("settings", ["samplers", key], value)}
                        />
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </Group>
          )}
        </div>
        <div
          className={`${COLUMN} @5xl:col-start-2 @min-[88rem]:col-start-3 @min-[88rem]:row-start-1 @min-[88rem]/model-columns:[&>:first-child]:border-t-0 @min-[88rem]/model-columns:[&>:first-child]:pt-0`}
        >
          <Group title="What it can do">
            <div className="grid max-w-3xl gap-4 @md:grid-cols-2 @3xl:grid-cols-3">
              {wrap(
                "vision",
                <Field label="Vision" about="Let the model see images. No leaves images out of its requests.">
                  <Select
                    items={triItems(reported("vision"))}
                    value={values.vision}
                    onValueChange={(vision: Tri) => update({ ...values, vision })}
                  />
                </Field>
              )}
              {wrap(
                "tools",
                <Field
                  label="Tools"
                  about="Mark whether the model can call tools. Nothing reads this yet, so it has no effect."
                >
                  <Select
                    items={triItems(reported("tools"))}
                    value={values.tools}
                    onValueChange={(tools: Tri) => update({ ...values, tools })}
                  />
                </Field>
              )}
              {wrap(
                "prefill",
                <Field
                  label="Prefill"
                  about={
                    prefillFixed
                      ? "This provider refuses a prefill for this model, so it stays off. Continue asks the model to go on from the reply so far."
                      : "Let replies start with text you supply, for the preset’s prefill and Continue. Choose Yes only if the model supports it."
                  }
                >
                  <Select
                    items={prefillItems(routed ? routed.upstream.prefill : "each")}
                    value={prefillFixed ? "auto" : values.prefill}
                    onValueChange={(prefill: PrefillChoice) => update({ ...values, prefill })}
                    disabled={prefillFixed}
                  />
                </Field>
              )}
            </div>
            {(rules.length > 0 || unpinned.length > 0 || note !== null) && (
              <section aria-label="Provider rules" data-provider-rules="" className="flex flex-col gap-1">
                <LabelWithHelp
                  help={
                    <AboutHint heading="Provider rules">
                      What this provider refuses or needs for this model. Every request follows them. Some apply only
                      when the model’s routing picks one provider.
                    </AboutHint>
                  }
                >
                  <span className="font-medium text-text">Provider rules</span>
                </LabelWithHelp>
                <ul className="list-disc pl-5 text-sm text-muted">
                  {rules.map((rule) => (
                    <li key={rule.id}>{rule.label}</li>
                  ))}
                  {unpinned.map((line) => (
                    <li key={line} data-route-note="">
                      {line}
                    </li>
                  ))}
                  {note !== null && (
                    <li data-price-note="">
                      <Tooltip label={note.hint}>
                        <span>{note.text}</span>
                      </Tooltip>
                    </li>
                  )}
                </ul>
              </section>
            )}
          </Group>

          <div className="border-t border-border pt-3">
            <Disclosure
              title="Advanced"
              hint="Shows message formatting, caching, routing, provider parameters, and importing settings from a preset file."
              open={advanced === "open"}
              onOpenChange={(open) => setAdvanced(open ? "open" : "", true)}
            >
              <AdvancedPart title="Messages">
                <div className="grid max-w-3xl gap-4 @md:grid-cols-2">
                  {wrap(
                    "names_behavior",
                    <Field label="Speaker names" about="How each message names its speaker.">
                      <Select
                        items={NAMES_ITEMS}
                        value={(settings.names_behavior as string | undefined) ?? "default"}
                        onValueChange={(next) =>
                          set("settings", ["names_behavior"], next === "default" ? undefined : next)
                        }
                      />
                    </Field>
                  )}
                  {wrap(
                    "postprocess",
                    <Field
                      label="Prompt post-processing"
                      about="Reshapes the messages for providers that need strict turns."
                    >
                      <Select
                        items={POSTPROCESS_ITEMS}
                        value={(settings.postprocess as string | undefined) ?? "none"}
                        onValueChange={(next) => set("settings", ["postprocess"], next === "none" ? undefined : next)}
                      />
                    </Field>
                  )}
                  {wrap(
                    "midChatSystem",
                    <Field
                      label="System messages mid-chat"
                      about="Whether the model takes system messages after the chat has started. No sends them as user messages."
                    >
                      <Select
                        items={triItems(reported("midChatSystem"))}
                        value={
                          values.overrides.midChatSystem === undefined
                            ? "auto"
                            : values.overrides.midChatSystem
                              ? "yes"
                              : "no"
                        }
                        onValueChange={(next: Tri) => set("overrides", ["midChatSystem"], flagOf(next))}
                      />
                    </Field>
                  )}
                </div>
                {wrap(
                  "use_sysprompt",
                  <Switch
                    checked={settings.use_sysprompt !== false}
                    onCheckedChange={(on) => set("settings", ["use_sysprompt"], on ? undefined : false)}
                    about="Sends the system prompt in the provider’s system parameter (Claude, Gemini). Off: as the first message."
                  >
                    System prompt as the system parameter
                  </Switch>
                )}
                {wrap(
                  "squash",
                  <Switch
                    checked={settings.squash === true}
                    onCheckedChange={(on) => set("settings", ["squash"], on ? true : undefined)}
                    about="Joins consecutive system messages into one."
                  >
                    Squash system messages
                  </Switch>
                )}
                {wrap(
                  "maxImages",
                  <Field
                    label="Images per request"
                    about="The most recent images a request carries; older ones are left out. Empty: 4."
                    error={shownProblem("overrides.maxImages")}
                  >
                    <Input
                      value={textAt("overrides.maxImages", "overrides", ["maxImages"])}
                      onValueChange={(text) => typeNumber("overrides", ["maxImages"], text)}
                      inputMode="numeric"
                      placeholder="4"
                    />
                  </Field>
                )}
              </AdvancedPart>

              <AdvancedPart title="Caching">
                <div className="grid max-w-3xl gap-4 @md:grid-cols-2">
                  {wrap(
                    "cacheRetention",
                    <Field
                      label="Prompt cache lifetime"
                      about="How long the provider keeps the cached prompt (cache retention)."
                    >
                      <Select
                        items={RETENTION_ITEMS}
                        value={(settings.cacheRetention as string | undefined) ?? "default"}
                        onValueChange={(next) =>
                          set("settings", ["cacheRetention"], next === "default" ? undefined : next)
                        }
                      />
                    </Field>
                  )}
                  {wrap(
                    "cacheBreakpoints",
                    <Field
                      label="Cache markers"
                      about="Where requests mark the parts the provider should keep for reuse. Default: the connection’s."
                    >
                      <Select
                        items={[{ value: "default", label: "Connection’s default" }, ...breakpointItems]}
                        value={(values.overrides.cacheBreakpoints as string | undefined) ?? "default"}
                        onValueChange={(next) =>
                          set("overrides", ["cacheBreakpoints"], next === "default" ? undefined : next)
                        }
                      />
                    </Field>
                  )}
                  {wrap(
                    "cacheTtlS",
                    <Field
                      label="Cache lifetime (seconds)"
                      about="How long a cached prompt lasts, for the cache estimate. Empty: the connection’s."
                      error={shownProblem("overrides.cacheTtlS")}
                    >
                      <Input
                        value={textAt("overrides.cacheTtlS", "overrides", ["cacheTtlS"])}
                        onValueChange={(text) => typeNumber("overrides", ["cacheTtlS"], text)}
                        inputMode="numeric"
                      />
                    </Field>
                  )}
                  {wrap(
                    "lookback",
                    <Field
                      label="Finds earlier cached parts"
                      about="Yes: the provider finds a cached part before the newest marker. No: only at a marker the last request also had."
                    >
                      <Select
                        items={triItems(undefined).map((item) =>
                          item.value === "auto"
                            ? { ...item, label: "Connection’s default", description: undefined }
                            : item
                        )}
                        value={cacheLayout.lookback === undefined ? "auto" : cacheLayout.lookback ? "yes" : "no"}
                        onValueChange={(next: Tri) => set("overrides", ["cacheLayout", "lookback"], flagOf(next))}
                      />
                    </Field>
                  )}
                  {wrap(
                    "maxMarkers",
                    <Field
                      label="Most cache markers"
                      about="The most cache markers one request carries. Empty: the connection’s."
                      error={shownProblem("overrides.cacheLayout.maxMarkers")}
                    >
                      <Input
                        value={textAt("overrides.cacheLayout.maxMarkers", "overrides", ["cacheLayout", "maxMarkers"])}
                        onValueChange={(text) => typeNumber("overrides", ["cacheLayout", "maxMarkers"], text)}
                        inputMode="numeric"
                      />
                    </Field>
                  )}
                  {wrap(
                    "minTokens",
                    <Field
                      label="Smallest cached size (tokens)"
                      about="Shorter starts of a request aren’t cached. Empty: the connection’s."
                      error={shownProblem("overrides.cacheLayout.minTokens")}
                    >
                      <Input
                        value={textAt("overrides.cacheLayout.minTokens", "overrides", ["cacheLayout", "minTokens"])}
                        onValueChange={(text) => typeNumber("overrides", ["cacheLayout", "minTokens"], text)}
                        inputMode="numeric"
                      />
                    </Field>
                  )}
                </div>
                {wrap(
                  "marker",
                  <Switch
                    checked={cacheLayout.marker === "prompt_cache_breakpoint"}
                    onCheckedChange={(on) =>
                      set("overrides", ["cacheLayout", "marker"], on ? "prompt_cache_breakpoint" : undefined)
                    }
                    about="Marks cached parts with prompt_cache_breakpoint, as Bedrock’s OpenAI-compatible APIs take them."
                  >
                    Bedrock cache breakpoints
                  </Switch>
                )}
                {wrap(
                  "summarySplit",
                  <Switch
                    checked={cacheLayout.summarySplit === true}
                    onCheckedChange={(on) => set("overrides", ["cacheLayout", "summarySplit"], on ? true : undefined)}
                    about="Puts a cache marker between the summaries and the recent history."
                  >
                    Marker after the summaries
                  </Switch>
                )}
              </AdvancedPart>

              {isRouter && (
                <AdvancedPart
                  title="Routing"
                  about={
                    many
                      ? "Which providers OpenRouter may send these models to: all of it is set together."
                      : "Which providers OpenRouter may send this model to."
                  }
                >
                  {wrap(
                    "routing",
                    <div className="flex min-w-0 flex-col gap-4">
                      <div className="grid max-w-3xl gap-4 @md:grid-cols-2">
                        {ROUTING_LISTS.map(([key, label, about]) => (
                          <Field key={key} label={label} about={`${about} Separate them with commas.`}>
                            <Input
                              value={values.drafts[`settings.routing.${key}`] ?? showList(routingRecord[key])}
                              onValueChange={(text) => {
                                const list = listOf(text)
                                update({
                                  ...values,
                                  settings: setAt(settings, ["routing", key], list.length ? list : undefined),
                                  drafts: { ...values.drafts, [`settings.routing.${key}`]: text }
                                })
                              }}
                              autoCapitalize="none"
                              spellCheck={false}
                            />
                          </Field>
                        ))}
                        <Field
                          label="Fall back to others"
                          about="Whether OpenRouter may use other providers when these fail."
                        >
                          <Select
                            items={triItems(undefined).map((item) =>
                              item.value === "auto"
                                ? { ...item, label: "OpenRouter’s default", description: undefined }
                                : item
                            )}
                            value={
                              routingRecord.allow_fallbacks === undefined
                                ? "auto"
                                : routingRecord.allow_fallbacks
                                  ? "yes"
                                  : "no"
                            }
                            onValueChange={(next: Tri) => set("settings", ["routing", "allow_fallbacks"], flagOf(next))}
                          />
                        </Field>
                      </div>
                      <RowsEditor
                        label="More routing options"
                        about="Other fields of OpenRouter’s provider routing, by name: a number, true or false, or text."
                        field="routing"
                        rows={routingRows}
                        name={{ label: "Routing option name", placeholder: "sort" }}
                        value={{ label: "Routing option value", placeholder: "price" }}
                        add="Add a routing option"
                        tag={keptTag(routingRecord)}
                        onRows={(rows) =>
                          setRows("settings.routing", rows, (draft) => {
                            const own = Object.fromEntries(
                              Object.entries(routingRecord).filter(([key]) => ROUTING_OWN.includes(key))
                            )
                            const next = { ...own, ...recordOf(rows, routingRecord) }
                            return {
                              ...draft,
                              settings: setAt(draft.settings, ["routing"], Object.keys(next).length ? next : undefined)
                            }
                          })
                        }
                      />
                    </div>
                  )}
                </AdvancedPart>
              )}

              {showBias && (
                <AdvancedPart
                  title="Word bias"
                  about="Makes tokens likelier or rarer, by token ID: from -100 (never) to 100 (always) (logit bias). Chat Completions only."
                >
                  {wrap(
                    "logit_bias",
                    <RowsEditor
                      label="Token biases"
                      about="A token ID and its bias, from -100 to 100."
                      field="logit_bias"
                      rows={biasRows}
                      name={{ label: "Token ID", placeholder: "Token ID" }}
                      value={{ label: "Bias", placeholder: "Bias", numeric: true }}
                      add="Add a token"
                      onRows={(rows) =>
                        setRows("settings.logit_bias", rows, (draft) => {
                          const valid = rows.filter((row) => row.name.trim() !== "" && !biasRowProblem(row))
                          const bias = Object.fromEntries(valid.map((row) => [row.name.trim(), Number(row.value)]))
                          return {
                            ...draft,
                            settings: setAt(draft.settings, ["logit_bias"], valid.length ? bias : undefined)
                          }
                        })
                      }
                    />
                  )}
                  {submitted && biasProblem && <p className="text-sm text-danger">Each bias takes a number.</p>}
                </AdvancedPart>
              )}

              <AdvancedPart title="Request parameters">
                {wrap(
                  "sampling",
                  <RowsEditor
                    label="Extra request parameters"
                    about='Sent in every request’s body as they are, for parameters with no control here. A value is a number, true or false, or text; quote text that reads as one ("1").'
                    field="sampling"
                    rows={extraRows}
                    name={{ label: "Parameter name", placeholder: "Name" }}
                    value={{ label: "Parameter value", placeholder: "Value" }}
                    add="Add a parameter"
                    tag={keptTag(values.overrides.sampling)}
                    onRows={(rows) =>
                      setRows("overrides.sampling", rows, (draft) => ({
                        ...draft,
                        overrides: setAt(draft.overrides, ["sampling"], recordOf(rows, values.overrides.sampling))
                      }))
                    }
                  />
                )}
                {wrap(
                  "thinkingLevels",
                  <RowsEditor
                    label="Thinking levels"
                    about="What each reasoning effort is sent as, where the provider names its levels differently. An empty value marks a level the model doesn’t take."
                    field="thinkingLevels"
                    rows={levelRows}
                    name={{ label: "Level", placeholder: THINKING_LEVELS.join(", ") }}
                    value={{ label: "Sent as", placeholder: "Not taken" }}
                    add="Add a level"
                    onRows={(rows) =>
                      setRows("overrides.thinkingLevels", rows, (draft) => ({
                        ...draft,
                        overrides: setAt(
                          draft.overrides,
                          ["thinkingLevels"],
                          recordOf(rows, undefined, (text) => (text.trim() === "" ? null : text.trim()))
                        )
                      }))
                    }
                  />
                )}
                {wrap(
                  "compat",
                  <RowsEditor
                    label="Compatibility flags"
                    about="Flags for how requests are written for this model, by name (supportsDeveloperRole, maxTokensField…): a number, true or false, or text."
                    field="compat"
                    rows={compatRows}
                    name={{ label: "Flag name", placeholder: "Name" }}
                    value={{ label: "Flag value", placeholder: "Value" }}
                    add="Add a flag"
                    tag={keptTag(values.overrides.compat)}
                    onRows={(rows) =>
                      setRows("overrides.compat", rows, (draft) => ({
                        ...draft,
                        overrides: setAt(draft.overrides, ["compat"], recordOf(rows, values.overrides.compat))
                      }))
                    }
                  />
                )}
              </AdvancedPart>

              <AdvancedPart title="Import">
                <StSettingsImporter
                  surface="model"
                  apply={async (preview) => {
                    if (!preview.model) return
                    const base = settings as ModelSettings
                    const merged = {
                      ...base,
                      ...preview.model,
                      samplers: { ...base.samplers, ...preview.model.samplers }
                    }
                    // What was typed for the imported settings gives way to them.
                    const keep = <A,>(record: Readonly<Record<string, A>>) =>
                      Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("settings.")))
                    update({ ...values, settings: merged, drafts: keep(values.drafts), rows: keep(values.rows) })
                  }}
                />
              </AdvancedPart>
            </Disclosure>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A part of the Advanced section, under its small heading. */
function AdvancedPart({ title, about, children }: { title: string; about?: string; children: ReactNode }) {
  return (
    <Fieldset legend={title} about={about} aboutLabel={title} className="gap-4">
      {children}
    </Fieldset>
  )
}

/** When each model's endpoint list was last asked for, so a failed fetch isn't retried on every render. */
const endpointsAsked = new Map<string, number>()

/** Asks for the model's per-provider prices once its routing pins one provider and none are stored or they're stale. */
export function useEndpointsFetch(model: Model, pinned: boolean) {
  const fetch = useAction()
  const run = fetch.run
  useEffect(() => {
    const now = Date.now()
    if (!pinned || !endpointsStale(model.upstream.endpoints, now)) return
    const last = endpointsAsked.get(model.id)
    if (last !== undefined && now - last < ENDPOINTS_RETRY_MS) return
    endpointsAsked.set(model.id, now)
    void run((client) => client("RefreshModelEndpoints", { modelId: model.id }), ["models"])
  }, [model.id, model.upstream.endpoints, pinned, run])
}

/** The note under Provider rules, and its hover, for a pinned provider's price. */
const priceNote = (source: PriceSource | null) =>
  source === null
    ? null
    : source.state === "pinned"
      ? {
          text: `Priced as ${source.name}${source.several ? ", its dearest variant" : ""}.`,
          hint: "Costs use this provider’s own price, not the model’s usual one, because the routing pins this provider."
        }
      : {
          text:
            source.reason === "failed"
              ? `${source.name}’s own price couldn’t be fetched, so the model’s usual price applies.`
              : `${source.name} has no price of its own listed, so the model’s usual price applies.`,
          hint: "The routing pins this provider, but OpenRouter gave no price for it. Costs use the model’s usual price, which may differ."
        }
