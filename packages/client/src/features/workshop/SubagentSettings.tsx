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
  type ResolvedLimits,
  rowsFor,
  SAME,
  SUMMARY,
  type SubagentCaps,
  type SubagentLimits,
  type SubagentModelRow,
  type SubagentSettings
} from "@dreamspan/shared/subagents.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert, Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"
import { useModelChoiceList } from "../chat/modelChoices.ts"
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

type LimitKey = CapField["key"] | RunField["key"]

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
  const initial = Object.fromEntries(
    [...CAP_FIELDS, ...RUN_FIELDS].map((f) => [f.key, shown(settings.limits[f.key])])
  ) as Draft<LimitKey>
  const [draft, setDraft] = useState<Draft<LimitKey> | null>(null)
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const values = draft ?? initial
  const edit = (key: LimitKey, text: string) => {
    setSaved(false)
    setInvalid(null)
    setDraft({ ...values, [key]: text })
  }
  const save = async (limits: SubagentLimits | null) => {
    const result = await action.run((client) => client("ChangeSubagentSettings", { limits }), KEYS)
    if (result.ok) {
      setDraft(null)
      setSaved(true)
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const { values: numbers, invalid: bad } = numbersOf(values, [...CAP_FIELDS, ...RUN_FIELDS])
    if (bad) {
      setInvalid(`${bad}: enter a number, or leave it empty for the default.`)
      return
    }
    void save(numbers as SubagentLimits)
  }
  const field = (f: CapField | RunField) => (
    <Field key={f.key} label={f.label} about={f.about} description={`Default: ${DEFAULT_LIMITS[f.key]}`}>
      <Input
        inputMode={f.integer ? "numeric" : "decimal"}
        name={f.key}
        value={values[f.key]}
        placeholder={String(DEFAULT_LIMITS[f.key as keyof ResolvedLimits])}
        onChange={(event) => edit(f.key, event.currentTarget.value)}
      />
    </Field>
  )
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
              setDraft(null)
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
  readonly caps: Draft<CapField["key"]>
}

const rowDraft = (row: SubagentModelRow): RowDraft => ({
  alias: row.alias,
  note: row.note,
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
  const [drafts, setDrafts] = useState<Readonly<Record<string, RowDraft>>>({})
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)
  const draftOf = (pick: string) => drafts[pick] ?? rowDraft(rows.get(pick)!)
  const edit = (pick: string, change: Partial<RowDraft>) => {
    setSaved(false)
    setInvalid(null)
    setDrafts({ ...drafts, [pick]: { ...draftOf(pick), ...change } })
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
        ...(Object.keys(values).length ? { caps: values } : {})
      }
    }
    const result = await action.run((client) => client("ChangeSubagentSettings", { rows: changed }), KEYS)
    if (result.ok) {
      setDrafts({})
      setSaved(true)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" data-subagent-models="">
      <ul className="flex flex-col divide-y divide-border">
        {listed.map((pick) => {
          const draft = draftOf(pick)
          const picked = picks.includes(pick)
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
                    maxLength={300}
                    onChange={(event) => edit(pick, { note: event.currentTarget.value })}
                  />
                </Field>
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
          hint="Saves these names, notes and limits."
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
              setDrafts({})
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
        description="Pick them with the subagent chip beside the model chip in a workshop."
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
