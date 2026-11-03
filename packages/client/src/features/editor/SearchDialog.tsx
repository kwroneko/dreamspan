// Search and replace across an editor's text fields, as plain text or a regular expression
// (DESIGN §6.2, §5.3). Replacing edits each field through its draft, like typing would.
import { type FormEvent, type ReactNode, useRef, useState, useSyncExternalStore } from "react"
import { SearchReplace } from "../../ui/SearchReplace.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { InlinePanel } from "../../ui/InlinePanel.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { editorTextFields, type Searchable, searchable } from "./fields.ts"
import type { SearchMatch } from "./searchNavigation.ts"
import { inScope, rememberedScope, rememberScope, type SearchScopes } from "./searchScopes.ts"
import { Segmented } from "../../ui/Segmented.tsx"
import { runSearch, type SearchResponse } from "./search.ts"
import { type EditorStore, useWorkingDoc } from "./store.ts"

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
  const [found, setFound] = useState<Found | null>(null)
  const [pending, setPending] = useState(false)
  const [scope, setScope] = useState(() => (scopes ? rememberedScope(scopes) : ""))
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
        <SearchReplace
          find={find}
          setFind={setFind}
          replace={replace}
          setReplace={setReplace}
          wholeWord={wholeWord}
          setWholeWord={setWholeWord}
          preserveCase={preserveCase}
          setPreserveCase={setPreserveCase}
          regex={regex}
          setRegex={setRegex}
          caseSensitive={caseSensitive}
          setCaseSensitive={setCaseSensitive}
          inline={inline}
          idPrefix={idPrefix}
          scopeChanged={!!scopes && scope !== scopes.initial}
          findActions={
            <Button
              type="submit"
              variant="primary"
              pending={pending}
              disabled={find === ""}
              hint="Lists every match with its replacement, before anything is changed."
            >
              Find
            </Button>
          }
          replaceActions={
            <Button
              disabled={find === "" || !response?.ok || response.matches.length === 0}
              pending={pending}
              hint="Replaces every match in every field it looks in."
              onClick={() => void replaceIn(null)}
            >
              Replace all
            </Button>
          }
          scopeControl={
            scopes ? (
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
            ) : null
          }
        />
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
