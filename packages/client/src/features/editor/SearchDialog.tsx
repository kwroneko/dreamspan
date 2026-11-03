// Search and replace across an editor's text fields, as plain text or a regular expression
// (DESIGN §6.2, §5.3). Replacing edits each field through its draft, like typing would.
import { type FormEvent, type ReactNode, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { InlinePanel } from "../../ui/InlinePanel.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { editorTextFields, type Searchable, searchable } from "./fields.ts"
import type { SearchMatch } from "./searchNavigation.ts"
import { inScope, rememberedScope, rememberScope, type SearchScopes } from "./searchScopes.ts"
import { Segmented } from "../../ui/Segmented.tsx"
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
  inline = false,
  scopes,
  idPrefix = "search"
}: {
  store: EditorStore
  onClose?: () => void
  onReveal: (match: SearchMatch) => void
  inline?: boolean
  /** What it can look through ("Look in"): every text field without. */
  scopes?: SearchScopes | undefined
  /** Ids in the page: two inline searches (the panel's and the large editor's) can both show. */
  idPrefix?: string
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
  const chosenOptions = [wholeWord, preserveCase, regex, caseSensitive].filter(Boolean).length
  const [found, setFound] = useState<Found | null>(null)
  const [pending, setPending] = useState(false)
  const [scope, setScope] = useState(() => (scopes ? rememberedScope(scopes) : ""))
  const chosen = chosenOptions + (scopes && scope !== scopes.initial ? 1 : 0)
  const fieldsOf = (doc: Parameters<typeof searchable>[1], entries?: Parameters<typeof searchable>[2]) =>
    inScope(searchable(store.snapshot!.ref.kind, doc, entries), scopes, scope)

  const working = useWorkingDoc(store)
  // Registration changes invalidate previews, just as document changes do.
  const contributions = useSyncExternalStore(editorTextFields.subscribe, editorTextFields.snapshot)
  const current = fieldsOf(working, contributions.entries)
  const asked = JSON.stringify([find, replace, wholeWord, preserveCase, regex, caseSensitive, scope])

  const search = async (replacement: string | null) => {
    const fields = fieldsOf(store.working().doc)
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
    const now = fieldsOf(store.working().doc)
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
  const wrap = (children: ReactNode) =>
    inline ? (
      <InlinePanel
        id={idPrefix}
        title="Search and replace"
        titleHidden
        onClose={() => onClose?.()}
        className="@container max-w-5xl"
      >
        {children}
      </InlinePanel>
    ) : (
      <Dialog
        open
        onOpenChange={(open) => !open && onClose?.()}
        title="Search and replace"
        finalFocus={() => !navigating.current}
      >
        <div className="@container flex flex-col gap-2">{children}</div>
      </Dialog>
    )
  // Each action beside the field it acts on; the two pairs side by side when there's room.
  return wrap(
    <>
      <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-2">
        <div className="grid min-w-0 gap-2 @2xl:grid-cols-2">
          <div className="flex min-w-0 items-end gap-2">
            <Field label="Find" labelHidden={inline} className="flex-1">
              <Input
                {...(inline ? { placeholder: "Find" } : {})}
                value={find}
                onChange={(event) => setFind(event.currentTarget.value)}
                className={regex ? "font-mono" : ""}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              pending={pending}
              disabled={find === ""}
              hint="Lists every match with its replacement, before anything is changed."
            >
              Find
            </Button>
          </div>
          <div className="flex min-w-0 items-end gap-2">
            <Field label="Replace with" labelHidden={inline} className="flex-1">
              <Input
                {...(inline ? { placeholder: "Replace with" } : {})}
                value={replace}
                onChange={(event) => setReplace(event.currentTarget.value)}
              />
            </Field>
            <Button
              disabled={find === "" || !response?.ok || response.matches.length === 0}
              pending={pending}
              hint="Replaces every match in every field it looks in."
              onClick={() => void replaceIn(null)}
            >
              Replace all
            </Button>
            {/* On a phone the options fold behind this, beside the fields, keeping the bar short. */}
            {inline && (
              <Button
                variant="ghost"
                className="px-2! sm:hidden"
                aria-expanded={options}
                aria-controls={`${idPrefix}-options`}
                hint="Shows where to look and how to match."
                onClick={() => setOptions(!options)}
              >
                Options{chosen > 0 ? ` (${chosen})` : ""}
              </Button>
            )}
          </div>
        </div>
        <div
          className={`${inline && !options ? "hidden sm:flex" : "flex"} min-w-0 flex-wrap items-center gap-x-4 gap-y-2`}
        >
          <div
            id={`${idPrefix}-options`}
            className={`${inline ? `${options ? "flex" : "hidden"} sm:flex` : "flex"} min-w-0 flex-wrap items-center gap-x-4 gap-y-2`}
          >
            {scopes && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-sm text-muted">Look in</span>
                <Segmented
                  label="Look in"
                  wrap
                  value={scope}
                  onValueChange={(next) => {
                    setScope(next)
                    rememberScope(scopes, next)
                  }}
                  options={scopes.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                    description: option.hint
                  }))}
                />
              </div>
            )}
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
            <SearchOption
              checked={caseSensitive}
              onCheckedChange={setCaseSensitive}
              hint="Capitals and lower case count as different letters."
            >
              Match case
            </SearchOption>
          </div>
        </div>
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
                // The inline panel stays open, for the next match.
                if (!inline) onClose?.()
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
                    <Button
                      variant="ghost"
                      onClick={reveal}
                      aria-label={`Go to ${field.label}`}
                      hint="Shows the field with the match selected."
                    >
                      Go to
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Replace in ${field.label}`}
                      hint="Replaces every match in this field only."
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
