// Search and replace across an editor's text fields, as plain text or a regular expression
// (DESIGN §6.2, §5.3). Replacing edits each field through its draft, like typing would.
import { type FormEvent, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { type Searchable, searchable } from "./fields.ts"
import { runSearch, type SearchResponse } from "./search.ts"
import type { EditorStore } from "./store.ts"

/** Matches listed at most; Replace all still replaces every one. */
const MAX_MATCHES = 500
const AROUND = 40

interface Found {
  readonly fields: ReadonlyArray<Searchable>
  readonly response: SearchResponse
}

/** Puts a field's new text back, as a draft of the field or of the list it's in. */
const write = (store: EditorStore, field: Searchable, text: string) => {
  if (field.inList) {
    const list = store.value(field.inList.path)
    if (Array.isArray(list)) store.setValue(field.inList.path, list.with(field.inList.index, text))
  } else store.setText(field.path, text)
}

export function SearchDialog({ store, onClose }: { store: EditorStore; onClose: () => void }) {
  const [find, setFind] = useState("")
  const [replace, setReplace] = useState("")
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [found, setFound] = useState<Found | null>(null)
  const [pending, setPending] = useState(false)

  const search = async (replacement: string | null) => {
    const fields = searchable(store.snapshot!.ref.kind, store.working().doc)
    setPending(true)
    const response = await runSearch({
      texts: fields.map((field) => field.text),
      find,
      regex,
      caseSensitive,
      replace: replacement,
      max: MAX_MATCHES
    })
    setPending(false)
    return { fields, response }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (find !== "") setFound(await search(null))
  }

  /** Replaces in the fields `only` names, or in every field. */
  const replaceIn = async (only: number | null) => {
    const result = await search(replace)
    if (result.response.ok && result.response.replaced) {
      const replaced = result.response.replaced
      result.fields.forEach((field, index) => {
        if ((only === null || only === index) && replaced[index] !== field.text) write(store, field, replaced[index]!)
      })
    }
    setFound(result.response.ok ? await search(null) : result)
  }

  const response = found?.response
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Search and replace">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <Field label="Find">
          <Input
            value={find}
            onChange={(event) => setFind(event.currentTarget.value)}
            className={regex ? "font-mono" : ""}
          />
        </Field>
        <Field label="Replace with">
          <Input value={replace} onChange={(event) => setReplace(event.currentTarget.value)} />
        </Field>
        <div className="flex flex-wrap gap-4">
          <Checkbox checked={regex} onCheckedChange={setRegex}>
            Regular expression
          </Checkbox>
          <Checkbox checked={caseSensitive} onCheckedChange={setCaseSensitive}>
            Match case
          </Checkbox>
        </div>
        <DialogActions>
          <Button
            disabled={find === "" || !response?.ok || response.matches.length === 0}
            pending={pending}
            onClick={() => void replaceIn(null)}
          >
            Replace all
          </Button>
          <Button type="submit" variant="primary" pending={pending} disabled={find === ""}>
            Find
          </Button>
        </DialogActions>
      </form>
      {response && !response.ok && (
        <Alert tone="danger" title="The search didn't run">
          <p>{response.error}</p>
        </Alert>
      )}
      {response?.ok && found && (
        <div className="flex flex-col gap-2">
          <p role="status" className="text-sm text-muted">
            {response.matches.length === 0
              ? "No matches."
              : `${response.truncated ? "At least " : ""}${response.matches.length} ${response.matches.length === 1 ? "match" : "matches"}.`}
          </p>
          <ol aria-label="Matches" className="flex flex-col divide-y divide-border">
            {response.matches.map((match, index) => {
              const field = found.fields[match.index]!
              const text = field.text
              return (
                <li key={index} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col text-sm">
                    <span className="font-medium [overflow-wrap:anywhere]">{field.label}</span>
                    <span className="text-muted [overflow-wrap:anywhere]">
                      {match.at > AROUND && "…"}
                      {text.slice(Math.max(0, match.at - AROUND), match.at)}
                      <mark className="bg-warning/30 text-text">{text.slice(match.at, match.at + match.length)}</mark>
                      {text.slice(match.at + match.length, match.at + match.length + AROUND)}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    aria-label={`Replace in ${field.label}`}
                    onClick={() => void replaceIn(match.index)}
                  >
                    Replace in this field
                  </Button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Dialog>
  )
}
