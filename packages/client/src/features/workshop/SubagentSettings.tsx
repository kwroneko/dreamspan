// Settings → Assistant tools, the subagents' sections (spec/SUBAGENTS.md §5.1, §5.3, §6.2, §6.3):
// each picked model's alias and note, as the assistant reads them when it picks a model for a
// subagent, with that model's own limits; and the limits for every subagent, each reply's
// subagents together, and how many run at once. Which models are picked is the subagent model
// chip's, beside the model chip (DESIGN §7.10 [D]); this page lists those and the two that track
// the chat. Never the assistant's to change: these are consent and spend.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState } from "react"
import {
  DEFAULT_LIMITS,
  DEFAULT_STORY_CAPS,
  type ResolvedLimits,
  rowsFor,
  SAME,
  SUMMARY,
  type SubagentCaps,
  type SubagentLimits,
  type SubagentModelRow,
  type SubagentSettings
} from "@dreamspan/shared/subagents.ts"
import { REASONING_EFFORTS, type ReasoningEffort } from "@dreamspan/shared/modelSettings.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert, Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"
import { useModelChoiceList } from "../chat/modelChoices.ts"
import { ReasoningEffortSelect } from "../connections/ReasoningEffort.tsx"
import { useDurableForm } from "../editor/durable.tsx"
import { pickLabel, SUBAGENT_SETTINGS_KEY, subagentSettingsAtom } from "./SubagentModelsChip.tsx"

const KEYS = ["settings", SUBAGENT_SETTINGS_KEY]

/** A number field's text: kept as typed until it parses; empty is "the default". */
type Draft<K extends string> = Readonly<Record<K, string>>

const parse = (text: string): number | undefined | null => {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

interface CapField {
  readonly key: keyof SubagentCaps
  readonly label: string
  readonly about: string
  readonly integer: boolean
}

const CAP_FIELDS: ReadonlyArray<CapField> = [
  {
    key: "requests",
    label: "Model requests",
    about: "The most requests one subagent makes. Its last is made without tools, for its report.",
    integer: true
  },
  {
    key: "tokens",
    label: "Tokens",
    about: "Tokens in and out, summed over one subagent's requests. Holds even where a model has no price.",
    integer: true
  },
  {
    key: "cost",
    label: "Cost ($)",
    about: "What one subagent's requests may cost, as the ledger prices them.",
    integer: false
  },
  {
    key: "minutes",
    label: "Time (minutes)",
    about: "How long one subagent may run, from when it starts.",
    integer: false
  }
]

interface RunField {
  readonly key: "perRun" | "runCostTimes" | "runConcurrent" | "accountConcurrent"
  readonly label: string
  readonly about: string
  readonly integer: boolean
}

const RUN_FIELDS: ReadonlyArray<RunField> = [
  {
    key: "perRun",
    label: "Subagents per reply",
    about: "The most subagents one reply may start. After that the assistant does the rest itself.",
    integer: true
  },
  {
    key: "runCostTimes",
    label: "One reply's subagents together (× cost)",
    about: "All of one reply's subagents together may cost this many times one subagent's cost limit.",
    integer: false
  },
  {
    key: "runConcurrent",
    label: "Running at once per reply",
    about: "More than this wait, queued, in the order they started.",
    integer: true
  },
  {
    key: "accountConcurrent",
    label: "Running at once in your account",
    about: "Across all your chats. More than this wait, queued, in the order they started.",
    integer: true
  }
]

/** The story helper's own four, as the form's keys: "story.requests". */
type StoryKey = `story.${CapField["key"]}`

const STORY_FIELDS: ReadonlyArray<{ readonly key: StoryKey; readonly cap: CapField["key"] } & Omit<CapField, "key">> =
  CAP_FIELDS.map((f) => ({
    ...f,
    key: `story.${f.key}` as StoryKey,
    cap: f.key,
    about:
      f.key === "minutes"
        ? "How long the story helper may run. The reply waits for it, so keep it short."
        : f.about.replace("one subagent", "the story helper")
  }))

type LimitKey = CapField["key"] | RunField["key"] | StoryKey

/** "30", or "" where it's the default. */
const shown = (value: number | undefined) => (value === undefined ? "" : String(value))

/** A draft's numbers: undefined where empty; the first field that isn't a number, if any. */
const numbersOf = <K extends string>(
  draft: Draft<K>,
  fields: ReadonlyArray<{ readonly key: K; readonly label: string; readonly integer: boolean }>
) => {
  const values: Partial<Record<K, number>> = {}
  for (const field of fields) {
    const value = parse(draft[field.key])
    if (value === null || (value !== undefined && field.integer && !Number.isInteger(value)))
      return { values, invalid: field.label }
    if (value !== undefined) values[field.key] = value
  }
  return { values, invalid: null }
}

function LimitsForm({ settings }: { settings: SubagentSettings }) {
  const action = useAction()
  const initial = Object.fromEntries([
    ...[...CAP_FIELDS, ...RUN_FIELDS].map((f) => [f.key, shown(settings.limits[f.key])]),
    ...STORY_FIELDS.map((f) => [f.key, shown(settings.limits.story?.[f.cap])])
  ]) as Draft<LimitKey>
  // Kept as typed (editor/durable.tsx): null until something is changed.
  const form = useDurableForm<{ draft: Draft<LimitKey> | null }>("subagent-limits", "Limits", { draft: null })
  const { draft } = form.values
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const values = draft ?? initial
  const edit = (key: LimitKey, text: string) => {
    setSaved(false)
    setInvalid(null)
    form.replace({ draft: { ...values, [key]: text } })
  }
  const save = async (limits: SubagentLimits | null) => {
    const ok = await form.commit(async () => {
      const result = await action.run((client) => client("ChangeSubagentSettings", { limits }), KEYS)
      return result.ok
    })
    if (ok) setSaved(true)
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const { values: numbers, invalid: bad } = numbersOf(values, [...CAP_FIELDS, ...RUN_FIELDS])
    const { values: story, invalid: badStory } = numbersOf(values, STORY_FIELDS)
    if (bad || badStory) {
      setInvalid(`${bad ?? `Story helper, ${badStory}`}: enter a number, or leave it empty for the default.`)
      return
    }
    const storyCaps = Object.fromEntries(
      STORY_FIELDS.flatMap((f) => (story[f.key] === undefined ? [] : [[f.cap, story[f.key]]]))
    )
    void save({ ...numbers, ...(Object.keys(storyCaps).length ? { story: storyCaps } : {}) } as SubagentLimits)
  }
  const field = (f: (CapField | RunField | (typeof STORY_FIELDS)[number]) & { readonly key: LimitKey }) => {
    const fallback =
      "cap" in f ? DEFAULT_STORY_CAPS[f.cap] : DEFAULT_LIMITS[f.key as Exclude<keyof ResolvedLimits, "story">]
    return (
      <Field key={f.key} label={f.label} about={f.about} description={`Default: ${fallback}`}>
        <Input
          inputMode={f.integer ? "numeric" : "decimal"}
          name={f.key}
          value={values[f.key]}
          placeholder={String(fallback)}
          onChange={(event) => edit(f.key, event.currentTarget.value)}
        />
      </Field>
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-subagent-limits="">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-text">Each subagent</legend>
        <p className="text-sm text-muted">
          At 80% of a limit a subagent is told to wrap up; at the limit it stops, and the assistant gets what it had
          written.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">{CAP_FIELDS.map(field)}</div>
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-text">Each reply and your account</legend>
        <div className="grid gap-3 sm:grid-cols-2">{RUN_FIELDS.map(field)}</div>
      </fieldset>
      <fieldset className="flex flex-col gap-3" data-subagent-story-limits="">
        <legend className="mb-2 text-sm font-medium text-text">The story helper</legend>
        <p className="text-sm text-muted">
          In a story whose tools allow it, a reply can ask a helper to look something up or check its draft. The reply
          waits for it, so its limits are lower. A model's own limits can only lower these.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">{STORY_FIELDS.map(field)}</div>
      </fieldset>
      {invalid && <Alert tone="danger">{invalid}</Alert>}
      <ErrorAlert error={action.error} title="Not saved" />
      {saved && draft === null && <Alert tone="success">Saved.</Alert>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="submit"
          variant="primary"
          hint="Saves these limits for every chat's subagents."
          pending={action.pending}
          disabled={draft === null}
        >
          Save
        </Button>
        {draft !== null && (
          <Button
            variant="ghost"
            hint="Discards the changes you haven't saved."
            onClick={() => {
              void form.discard()
              setInvalid(null)
            }}
          >
            Discard changes
          </Button>
        )}
        <Button
          variant="ghost"
          hint="Puts every limit back to its default."
          disabled={Object.keys(settings.limits).length === 0 && draft === null}
          onClick={() => void save(null)}
        >
          Use the defaults
        </Button>
      </div>
    </form>
  )
}

/** A row's draft: alias, note and its own limits as typed. */
interface RowDraft {
  readonly alias: string
  readonly note: string
  readonly effort: ReasoningEffort | null
  readonly caps: Draft<CapField["key"]>
}

const rowDraft = (row: SubagentModelRow): RowDraft => ({
  alias: row.alias,
  note: row.note,
  effort: row.effort ?? null,
  caps: Object.fromEntries(CAP_FIELDS.map((f) => [f.key, shown(row.caps?.[f.key])])) as Draft<CapField["key"]>
})

function ModelsForm({ settings }: { settings: SubagentSettings }) {
  const action = useAction()
  const { picks } = settings.models
  // The two that track the chat, then the account's other picks.
  const listed = [SAME, SUMMARY, ...picks.filter((p) => p !== SAME && p !== SUMMARY)]
  const { choices } = useModelChoiceList(
    true,
    listed.filter((p) => p.includes(" "))
  )
  const rows = rowsFor(settings.models, listed)
  // Kept as typed (editor/durable.tsx): only the rows changed.
  const form = useDurableForm<{ drafts: Readonly<Record<string, RowDraft>> }>("subagent-models", "Models", {
    drafts: {}
  })
  const { drafts } = form.values
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const draftOf = (pick: string) => drafts[pick] ?? rowDraft(rows.get(pick)!)
  const edit = (pick: string, change: Partial<RowDraft>) => {
    setSaved(false)
    setInvalid(null)
    form.replace({ drafts: { ...drafts, [pick]: { ...draftOf(pick), ...change } } })
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const changed: Record<string, SubagentModelRow> = {}
    for (const [pick, draft] of Object.entries(drafts)) {
      const alias = draft.alias.trim().toLowerCase()
      if (!/^[a-z][a-z0-9_-]{0,23}$/.test(alias)) {
        setInvalid(
          `“${draft.alias}”: a name is one lower-case word of letters, digits, - or _, starting with a letter.`
        )
        return
      }
      const { values, invalid: bad } = numbersOf(draft.caps, CAP_FIELDS)
      if (bad) {
        setInvalid(`${pickLabel(pick, choices)}, ${bad}: enter a number, or leave it empty.`)
        return
      }
      changed[pick] = {
        alias,
        note: draft.note.trim().slice(0, 300),
        ...(Object.keys(values).length ? { caps: values } : {}),
        ...(draft.effort ? { effort: draft.effort } : {})
      }
    }
    const ok = await form.commit(async () => {
      const result = await action.run((client) => client("ChangeSubagentSettings", { rows: changed }), KEYS)
      return result.ok
    })
    if (ok) setSaved(true)
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" data-subagent-models="">
      <ul className="flex flex-col divide-y divide-border">
        {listed.map((pick) => {
          const draft = draftOf(pick)
          const picked = picks.includes(pick)
          // Same and the summary model are whatever each chat uses: every level, used where it's taken.
          const tracks = pick === SAME || pick === SUMMARY
          const efforts = tracks ? REASONING_EFFORTS : choices.find((c) => c.value === pick)?.efforts
          return (
            <li key={pick} className="flex flex-col gap-3 py-3 first:pt-0" data-subagent-model-row={pick}>
              <div className="flex min-w-0 flex-col">
                <span className="font-medium text-text [overflow-wrap:anywhere]">{pickLabel(pick, choices)}</span>
                <span className="text-sm text-muted">
                  {picked ? "Picked: subagents in your chats may use it." : "Not picked."}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                <Field
                  label="Name"
                  about="The word the assistant writes to choose this model."
                  {...(pick === SAME ? { description: "Always “same”." } : {})}
                >
                  <Input
                    value={draft.alias}
                    disabled={pick === SAME}
                    maxLength={24}
                    onChange={(event) => edit(pick, { alias: event.currentTarget.value })}
                  />
                </Field>
                <Field label="What it's for" about="One line the assistant reads beside the name.">
                  <Input
                    fullWidth
                    value={draft.note}
                    readOnly={!form.ready}
                    maxLength={300}
                    onChange={(event) => edit(pick, { note: event.currentTarget.value })}
                  />
                </Field>
                {efforts !== undefined && efforts.length > 0 && (
                  <Field
                    label="Reasoning effort"
                    about="How much its subagents think before answering. A subagent type's own effort wins over this."
                    {...(tracks ? { description: "Used where the chat's model has that level." } : {})}
                  >
                    <div data-subagent-model-effort={pick}>
                      <ReasoningEffortSelect
                        value={draft.effort}
                        levels={efforts}
                        defaultLabel="The model's own"
                        defaultDescription="The effort set on the model, or its default."
                        onValueChange={(effort) => edit(pick, { effort: effort as ReasoningEffort | null })}
                      />
                    </div>
                  </Field>
                )}
              </div>
              <Disclosure
                title="Limits for this model"
                hint="Shows this model's own limits, which replace the general ones for it."
              >
                <p className="text-sm text-muted">Empty: the limits below for every subagent.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {CAP_FIELDS.map((f) => (
                    <Field key={f.key} label={f.label} about={f.about}>
                      <Input
                        inputMode={f.integer ? "numeric" : "decimal"}
                        value={draft.caps[f.key]}
                        onChange={(event) =>
                          edit(pick, { caps: { ...draft.caps, [f.key]: event.currentTarget.value } })
                        }
                      />
                    </Field>
                  ))}
                </div>
              </Disclosure>
            </li>
          )
        })}
      </ul>
      {invalid && <Alert tone="danger">{invalid}</Alert>}
      <ErrorAlert error={action.error} title="Not saved" />
      {saved && Object.keys(drafts).length === 0 && <Alert tone="success">Saved.</Alert>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="submit"
          variant="primary"
          hint="Saves these names, notes, efforts and limits."
          pending={action.pending}
          disabled={Object.keys(drafts).length === 0}
        >
          Save
        </Button>
        {Object.keys(drafts).length > 0 && (
          <Button
            variant="ghost"
            hint="Discards the changes you haven't saved."
            onClick={() => {
              void form.discard()
              setInvalid(null)
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
    </form>
  )
}

function useSettings() {
  const result = useAtomValue(subagentSettingsAtom)
  return AsyncResult.isSuccess(result) ? result.value : undefined
}

export function SubagentModelsSection() {
  const settings = useSettings()
  return (
    <Card>
      <CardHeader
        title="Subagent models"
        description="Pick them with the subagent chip beside the model chip in a workshop, or in a story whose tools allow the story helper."
        about="The assistant chooses one of the picked models for each subagent it starts, by its name, reading the line beside it. Picking a model lets subagents send what they read to its connection."
      />
      {settings ? <ModelsForm settings={settings} /> : <p className="text-sm text-muted">Loading…</p>}
    </Card>
  )
}

export function SubagentLimitsSection() {
  const settings = useSettings()
  return (
    <Card>
      <CardHeader
        title="Subagent limits"
        about="How much the assistant's subagents may do. A model's own limits, above, take the place of these for it."
      />
      {settings ? <LimitsForm settings={settings} /> : <p className="text-sm text-muted">Loading…</p>}
    </Card>
  )
}
