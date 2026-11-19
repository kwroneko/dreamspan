// Settings → Assistant tools, the subagents' section (spec/SUBAGENTS.md §5.1): each picked model's
// alias and note, as the assistant reads them when it picks a model for a subagent. Which models are picked is the subagent model
// chip's, beside the model chip (DESIGN §7.10 [D]); this page lists those and the two that track
// the chat. Never the assistant's to change: these are consent and spend.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState } from "react"
import { rowsFor, SAME, SUMMARY, type SubagentModelRow, type SubagentSettings } from "@dreamspan/shared/subagents.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert, Card, CardHeader } from "../../ui/Surface.tsx"
import { useModelChoiceList } from "../chat/modelChoices.ts"
import { pickLabel, SUBAGENT_SETTINGS_KEY, subagentSettingsAtom } from "./SubagentModelsChip.tsx"

const KEYS = ["settings", SUBAGENT_SETTINGS_KEY]

/** A row's draft: alias and note as typed. */
interface RowDraft {
  readonly alias: string
  readonly note: string
}

const rowDraft = (row: SubagentModelRow): RowDraft => ({ alias: row.alias, note: row.note })

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
      changed[pick] = { alias, note: draft.note.trim().slice(0, 300) }
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
          hint="Saves these names and notes."
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
