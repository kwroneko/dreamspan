// Search and replace across an editor's text fields, as plain text or a regular expression
// (DESIGN §6.2, §5.3). Replacing edits each field through its draft, like typing would.
import { type FormEvent, type ReactNode, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { editorTextFields, type Searchable, searchable } from "./fields.ts"
import type { SearchMatch } from "./searchNavigation.ts"
import { runSearch, type SearchResponse } from "./search.ts"
import { type EditorStore, useWorkingDoc } from "./store.ts"

/**
 * An option with its explanation on hover and focus: under the label it would make the
 * preset's sticky search bar too tall.
 */
function SearchOption({
  checked,
  onCheckedChange,
  hint,
  children
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  hint: string
  children: ReactNode
}) {
  return (
    <Tooltip label={hint}>
      <span className="inline-flex">
        <Checkbox checked={checked} onCheckedChange={onCheckedChange}>
          {children}
        </Checkbox>
      </span>
    </Tooltip>
  )
}

/** Matches listed at most; Replace all still replaces every one. */
const MAX_MATCHES = 500
const AROUND = 40

interface Found {
  readonly fields: ReadonlyArray<Searchable>
  readonly response: SearchResponse
  /** What was asked: the matches show only while the question and the text are still these. */
  readonly asked: string
}

/** Whether two reads of the editor's text fields hold the same text at the same places. */
const sameFields = (a: ReadonlyArray<Searchable>, b: ReadonlyArray<Searchable>) =>
  a.length === b.length &&
  a.every(
    (field, index) => field.text === b[index]!.text && JSON.stringify(field.path) === JSON.stringify(b[index]!.path)
  )

/** Puts a field's new text back, as a draft of the field or of the list it's in. */
const write = (store: EditorStore, field: Searchable, text: string) => {
  if (field.inList) {
    const list = store.value(field.inList.path)
    if (Array.isArray(list)) store.setValue(field.inList.path, list.with(field.inList.index, text))
  } else store.setText(field.path, text)
}

export function SearchDialog({
  store,
  onClose,
  onReveal,
  inline = false
}: {
  store: EditorStore
  onClose?: () => void
  onReveal: (match: SearchMatch) => void
  inline?: boolean
}) {
  const navigating = useRef(false)
  const [find, setFind] = useState("")
  const [replace, setReplace] = useState("")
  const [wholeWord, setWholeWord] = useState(false)
  const [preserveCase, setPreserveCase] = useState(false)
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  // On a phone the options fold away, so the sticky bar leaves room for the document.
  const [options, setOptions] = useState(false)
  const chosen = [wholeWord, preserveCase, regex, caseSensitive].filter(Boolean).length
  const [found, setFound] = useState<Found | null>(null)
  const [pending, setPending] = useState(false)

  const working = useWorkingDoc(store)
  // Registration changes invalidate previews, just as document changes do.
  const contributions = useSyncExternalStore(editorTextFields.subscribe, editorTextFields.snapshot)
  const current = searchable(store.snapshot!.ref.kind, working, contributions.entries)
  const asked = JSON.stringify([find, replace, wholeWord, preserveCase, regex, caseSensitive])

  const search = async (replacement: string | null) => {
    const fields = searchable(store.snapshot!.ref.kind, store.working().doc)
    setPending(true)
    const response = await runSearch({
      texts: fields.map((field) => field.text),
      find,
      regex,
      caseSensitive,
      wholeWord,
      preserveCase,
      replace: replacement,
      max: MAX_MATCHES
    })
    setPending(false)
    return { fields, response, asked }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (find !== "") setFound(await search(replace))
  }

  /** Replaces in the fields `only` names, or in every field. */
  const replaceIn = async (only: number | null) => {
    const result = await search(replace)
    const now = searchable(store.snapshot!.ref.kind, store.working().doc)
    if (!sameFields(result.fields, now)) {
      setFound({
        asked,
        fields: now,
        response: {
          ok: false,
          error: "Text changed while the search was running. Find again to preview the current text."
        }
      })
      return
    }
    if (result.response.ok && result.response.replaced) {
      const replaced = result.response.replaced
      result.fields.forEach((field, index) => {
        if ((only === null || only === index) && replaced[index] !== field.text) write(store, field, replaced[index]!)
      })
    }
    setFound(result.response.ok ? await search(replace) : result)
  }

  // A list from before the question or the text changed isn't shown: its matches and previews
  // are for text that's gone. (The error that asks to find again is shown, with its own say.)
  const shown = found !== null && found.asked === asked && sameFields(found.fields, current) ? found : null
  const response = shown?.response
  const actions = (children: ReactNode) =>
    inline ? (
      <div className="col-span-2 flex items-center justify-end gap-2 sm:col-span-1">{children}</div>
    ) : (
      <DialogActions>{children}</DialogActions>
    )
  const wrap = (children: ReactNode) =>
    inline ? (
      <section aria-label="Search and replace" className="flex flex-col gap-2">
        {children}
      </section>
    ) : (
      <Dialog
        open
        onOpenChange={(open) => !open && onClose?.()}
        title="Search and replace"
        finalFocus={() => !navigating.current}
      >
        {children}
      </Dialog>
    )
  return wrap(
    <>
      <form
        onSubmit={(event) => void submit(event)}
        className={inline ? "grid grid-cols-2 gap-2" : "grid gap-2 sm:grid-cols-2"}
      >
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
        <div
          id={inline ? "search-options" : undefined}
          className={`${inline ? `col-span-2 sm:col-span-1 ${options ? "flex" : "hidden"} sm:flex` : "flex"} flex-wrap gap-4`}
        >
          <SearchOption
            checked={wholeWord}
            onCheckedChange={setWholeWord}
            hint="Only where it isn't part of a longer word."
          >
            Whole word
          </SearchOption>
          <SearchOption
            checked={preserveCase}
            onCheckedChange={setPreserveCase}
            hint="The replacement takes each match's case: all capitals, all lower case, or a capital first."
          >
            Preserve case
          </SearchOption>
          <SearchOption
            checked={regex}
            onCheckedChange={setRegex}
            hint="Find is a JavaScript regular expression; Replace with can use $1 or $<name> for its groups."
          >
            Regular expression
          </SearchOption>
          <Checkbox checked={caseSensitive} onCheckedChange={setCaseSensitive}>
            Match case
          </Checkbox>
        </div>
        {actions(
          <>
            {inline && (
              <Button
                variant="ghost"
                className="mr-auto sm:hidden"
                aria-expanded={options}
                aria-controls="search-options"
                onClick={() => setOptions(!options)}
              >
                Options{chosen > 0 ? ` (${chosen})` : ""}
              </Button>
            )}
            <Button
              disabled={find === "" || !response?.ok || response.matches.length === 0}
              pending={pending}
              hint="Replaces every match in every field, as unsaved changes."
              onClick={() => void replaceIn(null)}
            >
              Replace all
            </Button>
            <Button type="submit" variant="primary" pending={pending} disabled={find === ""}>
              Find
            </Button>
          </>
        )}
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
          <ol
            aria-label="Matches"
            className={`flex ${inline ? "max-h-28 sm:max-h-48" : "max-h-48"} flex-col divide-y divide-border overflow-y-auto`}
          >
            {response.matches.map((match, index) => {
              const field = found.fields[match.index]!
              const text = field.text
              const reveal = () => {
                navigating.current = true
                onClose?.()
                const target = { path: field.path, at: match.at, length: match.length }
                // Let a modal's focus trap unmount before focusing the destination.
                if (inline) onReveal(target)
                else requestAnimationFrame(() => onReveal(target))
              }
              return (
                <li key={index} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col text-sm">
                    <button
                      type="button"
                      onClick={reveal}
                      className="text-left font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-focus [overflow-wrap:anywhere]"
                    >
                      {field.label}
                    </button>
                    <span className="text-muted [overflow-wrap:anywhere]">
                      {match.at > AROUND && "…"}
                      {text.slice(Math.max(0, match.at - AROUND), match.at)}
                      <mark className="bg-warning/30 text-text">{text.slice(match.at, match.at + match.length)}</mark>
                      {text.slice(match.at + match.length, match.at + match.length + AROUND)}
                    </span>
                    <span className="text-success [overflow-wrap:anywhere]">→ {match.replacement}</span>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <Button variant="ghost" onClick={reveal} aria-label={`Go to ${field.label}`}>
                      Go to
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Replace in ${field.label}`}
                      hint="Replaces every match in this field, as an unsaved change."
                      onClick={() => void replaceIn(match.index)}
                    >
                      Replace in this field
                    </Button>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </>
  )
}
