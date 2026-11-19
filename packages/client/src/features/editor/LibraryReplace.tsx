// Search and replace across the library (ARCHITECTURE §14.6 "Across the library"): the
// library's Search and replace button opens a panel under the library's actions with the
// editors' shared search fields (ui/SearchReplace.tsx), a tick per kind, and a preview of every
// entry and field the replace would change, each ticked; Replace changes what's left ticked, as
// one replace the panel can undo. The text searched is each entry as its editor shows it,
// unsaved changes included (PreviewLibraryReplace, server db/libraryReplace.ts). The URL holds
// whether the panel is open (`replace=open`) and what's found (`find`).
import { useAtomValue } from "@effect/atom-react"
import {
  type FieldExcerpt,
  LIBRARY_UNSAVED_REASON,
  type LibraryChoice,
  type LibraryEdit,
  type LibraryEntryHit,
  type LibraryPreview,
  type LibraryReplaceKind,
  type LibraryReplaceResult,
  type LibrarySearch
} from "@dreamspan/shared/libraryReplace.ts"
import { libraryReplaceKinds } from "@dreamspan/shared/libraryText.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState } from "react"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { InlinePanel } from "../../ui/InlinePanel.tsx"
import { SearchReplace, SearchReplaceButton } from "../../ui/SearchReplace.tsx"
import { Alert, Badge, Disclosure } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { formatMoment } from "../chat/forks.ts"
import { useSession } from "../../session.ts"
import { pendingLibraryRefs } from "./libraryPending.ts"
import { refreshOpenEditors } from "./openEditors.ts"

const PANEL_ID = "library-replace"
/** Entries listed before "Show more". */
const LISTED = 100
const kindNames = (kind: LibraryReplaceKind) => libraryReplaceKinds.get(kind) ?? { one: kind, many: kind }
const INVALIDATES = ["library", "library-edits"]
const editsAtom = AppClient.query("ListLibraryEdits", undefined, { reactivityKeys: INVALIDATES })

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** Whether the panel is open, from the URL. */
const usePanel = () => {
  const [open, setOpen] = usePlaceParam("replace", "", ["", "open"])
  return [open === "open", (next: boolean) => setOpen(next ? "open" : "", true)] as const
}

/** The library's Search and replace button, among its actions. */
export function LibraryReplaceButton() {
  const [open, setOpen] = usePanel()
  return <SearchReplaceButton open={open} controls={PANEL_ID} className="self-center" onClick={() => setOpen(!open)} />
}

/** A field's first match, with what replaces it. */
function Change({ excerpt }: { excerpt: FieldExcerpt }) {
  const found = excerpt.text.slice(excerpt.at, excerpt.at + excerpt.length)
  return (
    <span className="text-sm [overflow-wrap:anywhere]">
      {excerpt.before && "…"}
      {excerpt.text.slice(0, excerpt.at)}
      <del className="rounded-sm bg-danger/15 text-text">{found}</del>
      {excerpt.replacement !== "" && (
        <ins className="rounded-sm bg-success/15 text-text no-underline">{excerpt.replacement}</ins>
      )}
      {excerpt.text.slice(excerpt.at + excerpt.length)}
      {excerpt.after && "…"}
    </span>
  )
}

const fieldKey = (entry: LibraryEntryHit, field: string) => `${entry.refId}\u0000${field}`

function EntryRow({
  entry,
  left,
  setLeft
}: {
  entry: LibraryEntryHit
  /** The fields not ticked, by `fieldKey`. */
  left: ReadonlySet<string>
  setLeft: (next: ReadonlySet<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const unticked = entry.fields.filter((f) => left.has(fieldKey(entry, f.field))).length
  const blocked = entry.blocked !== null
  const toggleAll = (on: boolean) => {
    const next = new Set(left)
    for (const f of entry.fields) next[on ? "delete" : "add"](fieldKey(entry, f.field))
    setLeft(next)
  }
  return (
    <li
      data-library-hit={entry.refId}
      className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Checkbox
          checked={!blocked && unticked < entry.fields.length}
          indeterminate={!blocked && unticked > 0 && unticked < entry.fields.length}
          disabled={blocked}
          onCheckedChange={toggleAll}
          labelHidden
          hint={
            blocked
              ? (entry.blocked ?? undefined)
              : `Click to ${unticked === 0 ? "leave out" : "include"} every match in ${entry.label}.`
          }
        >
          {`Replace in ${entry.label}`}
        </Checkbox>
        <Tooltip label="Opens its editor.">
          <Link
            to="/library/$refId"
            params={{ refId: entry.refId }}
            data-layout-name
            className="min-w-0 truncate text-sm font-medium text-accent hover:underline"
          >
            {entry.label || "Untitled"}
          </Link>
        </Tooltip>
        <Badge>{kindNames(entry.kind).one}</Badge>
        <span className="text-xs text-muted tabular-nums">{plural(entry.count, "match", "matches")}</span>
        {entry.unsaved && (
          <Tooltip label="Replace skips this entry because it has unsaved changes. Open it to save or revert them.">
            <span
              tabIndex={0}
              className="rounded text-xs text-warning outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Unsaved changes, skipped
            </span>
          </Tooltip>
        )}
        <Button
          variant="ghost"
          className="ml-auto h-7! px-2! text-xs"
          aria-expanded={open}
          hint={open ? "Click to hide its fields." : "Click to see each field that matches, and tick them one by one."}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide fields" : plural(entry.fields.length, "field")}
        </Button>
      </div>
      {blocked && <p className="pl-6 text-xs text-warning">{entry.blocked}</p>}
      {!open && entry.fields[0] && (
        <p className="line-clamp-2 pl-6 text-muted">
          <Change excerpt={entry.fields[0].excerpt} />
        </p>
      )}
      {open && (
        <ul aria-label={`Fields of ${entry.label}`} className="flex flex-col gap-1.5 pl-6">
          {entry.fields.map((field) => {
            const key = fieldKey(entry, field.field)
            return (
              <li key={field.field} className="flex min-w-0 items-start gap-2">
                <Checkbox
                  checked={!blocked && !left.has(key)}
                  disabled={blocked}
                  onCheckedChange={(on) => {
                    const next = new Set(left)
                    next[on ? "delete" : "add"](key)
                    setLeft(next)
                  }}
                  labelHidden
                  hint={`Click to ${left.has(key) ? "include" : "leave out"} ${field.label}.`}
                >
                  {`Replace in ${field.label}`}
                </Checkbox>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs text-muted">
                    {field.label} · {plural(field.count, "match", "matches")}
                  </span>
                  <Change excerpt={field.excerpt} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

function RecentReplaces({ onUndone }: { onUndone: (message: string) => void }) {
  const result = useAtomValue(editsAtom)
  const action = useAction()
  if (!AsyncResult.isSuccess(result) || result.value.length === 0) return null
  const undo = async (edit: LibraryEdit) => {
    const done = await action.run((client) => client("UndoLibraryEdit", { editId: edit.id }), INVALIDATES)
    if (!done.ok) return
    void refreshOpenEditors()
    const kept = done.value.kept
    onUndone(
      `Undid it in ${plural(done.value.undone, "entry", "entries")}.${kept.length > 0 ? ` ${plural(kept.length, "entry", "entries")} changed since kept the replace: ${kept.map((k) => k.label || "an entry").join(", ")}.` : ""}`
    )
  }
  return (
    <Disclosure title="Recent replaces" hint="Click to see the replaces done across the library, and undo one.">
      <ul aria-label="Recent replaces" className="flex flex-col gap-2">
        {result.value.map((edit) => (
          <li key={edit.id} data-library-edit={edit.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{edit.title}</span>
            <span className="text-xs text-muted tabular-nums">
              {formatMoment(edit.createdAt)} · {plural(edit.entries, "entry", "entries")}
              {edit.undone > 0 &&
                ` · ${edit.undone === edit.entries ? "undone" : `${edit.undone.toLocaleString()} undone`}`}
            </span>
            <Button
              className="h-7! px-2! text-xs"
              disabled={edit.undone === edit.entries}
              pending={action.pending}
              hint="Takes this replace back in every entry not changed since; an entry changed since keeps it."
              onClick={() => void undo(edit)}
            >
              Undo
            </Button>
          </li>
        ))}
      </ul>
    </Disclosure>
  )
}

/** The panel the button opens, under the library's actions. */
export function LibraryReplacePanel() {
  const userId = useSession().user.id
  const [open, setOpen] = usePanel()
  const [find, setFind] = usePlaceParam("find", "")
  const [replace, setReplace] = useState("")
  const [wholeWord, setWholeWord] = useState(false)
  const [preserveCase, setPreserveCase] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matchCase, setMatchCase] = useState(false)
  const [kinds, setKinds] = useState<ReadonlyArray<LibraryReplaceKind>>(() =>
    libraryReplaceKinds.list().map((k) => k.id)
  )
  const [found, setFound] = useState<{ readonly asked: string; readonly preview: LibraryPreview } | null>(null)
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set())
  const [shown, setShown] = useState(LISTED)
  const [outcome, setOutcome] = useState<
    { readonly result: LibraryReplaceResult } | { readonly message: string } | null
  >(null)
  const finding = useAction()
  const replacing = useAction()
  if (!open) return null

  const available = libraryReplaceKinds.list().map((k) => k.id)
  const search: LibrarySearch = {
    find,
    replace,
    matchCase,
    wholeWord,
    regex,
    preserveCase,
    kinds: available.filter((k) => kinds.includes(k))
  }
  const asked = JSON.stringify(search)
  // A preview of another question isn't shown: its matches and replacements are for that one.
  const preview = found?.asked === asked ? found.preview : null
  const choices: Array<LibraryChoice> = (preview?.entries ?? []).flatMap((entry) => {
    if (entry.blocked !== null) return []
    const fields = entry.fields.filter((f) => !left.has(fieldKey(entry, f.field))).map((f) => f.field)
    return fields.length === 0 ? [] : [{ refId: entry.refId, stamp: entry.stamp, fields }]
  })
  // Entries a replace can't change are sent too, so its result says which it skipped and why.
  const blockedChoices: Array<LibraryChoice> = (preview?.entries ?? []).flatMap((entry) =>
    entry.blocked === null ? [] : [{ refId: entry.refId, stamp: entry.stamp, fields: entry.fields.map((f) => f.field) }]
  )
  const ticked = (preview?.entries ?? []).reduce(
    (n, entry) =>
      entry.blocked !== null
        ? n
        : n + entry.fields.filter((f) => !left.has(fieldKey(entry, f.field))).reduce((m, f) => m + f.count, 0),
    0
  )

  const runFind = async () => {
    if (find === "" || search.kinds.length === 0) return
    const result = await finding.run((client) => client("PreviewLibraryReplace", { search }))
    if (result.ok) {
      const pending = await pendingLibraryRefs(userId)
      setFound({
        asked,
        preview: {
          ...result.value,
          entries: result.value.entries.map((entry) =>
            pending.has(entry.refId) ? { ...entry, unsaved: true, blocked: LIBRARY_UNSAVED_REASON } : entry
          )
        }
      })
      setLeft(new Set())
      setShown(LISTED)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setOutcome(null)
    void runFind()
  }
  const runReplace = async () => {
    if (choices.length === 0) return
    const pending = await pendingLibraryRefs(userId)
    const result = await replacing.run(
      (client) =>
        client("ApplyLibraryReplace", {
          search,
          choices: [...choices, ...blockedChoices].map((choice) => ({
            ...choice,
            ...(pending.has(choice.refId) ? { unsaved: true } : {})
          }))
        }),
      INVALIDATES
    )
    if (!result.ok) return
    setOutcome({ result: result.value })
    void refreshOpenEditors()
    await runFind()
  }
  const undoLast = async (editId: string) => {
    const result = await replacing.run((client) => client("UndoLibraryEdit", { editId }), INVALIDATES)
    if (!result.ok) return
    void refreshOpenEditors()
    const kept = result.value.kept
    setOutcome({
      message: `Undid it in ${plural(result.value.undone, "entry", "entries")}.${kept.length > 0 ? ` ${plural(kept.length, "entry", "entries")} changed since kept the replace.` : ""}`
    })
    await runFind()
  }
  const counts = new Map(preview?.counts.map((c) => [c.kind, c]) ?? [])
  const error = finding.error ?? replacing.error
  const idle = find === ""

  return (
    <InlinePanel
      id={PANEL_ID}
      title="Search and replace across the library"
      onClose={() => setOpen(false)}
      className="max-w-5xl"
    >
      <p className="text-sm text-muted">
        Finds text in your library. Entries with unsaved changes are skipped and listed afterwards. Archived entries and
        a chat's own notes are left out.
      </p>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-2">
        <SearchReplace
          find={find}
          setFind={(value) => setFind(value, true)}
          replace={replace}
          setReplace={setReplace}
          wholeWord={wholeWord}
          setWholeWord={setWholeWord}
          preserveCase={preserveCase}
          setPreserveCase={setPreserveCase}
          regex={regex}
          setRegex={setRegex}
          caseSensitive={matchCase}
          setCaseSensitive={setMatchCase}
          idPrefix={PANEL_ID}
          alwaysShowOptions
          findActions={
            <Button
              type="submit"
              pending={finding.pending}
              disabled={idle || search.kinds.length === 0}
              hint={
                idle
                  ? "Enter the text to find first."
                  : search.kinds.length === 0
                    ? "Tick a kind of entry to look through first."
                    : "Finds it in every entry of the kinds ticked, and lists what would change."
              }
            >
              Find
            </Button>
          }
          replaceActions={
            <Button
              variant="primary"
              pending={replacing.pending}
              disabled={preview === null || choices.length === 0}
              hint={
                preview === null
                  ? "Find first: Replace changes what the list shows ticked."
                  : choices.length === 0
                    ? "Nothing is ticked."
                    : "Replaces the ticked matches, writing a revision of each entry changed. You can undo it here."
              }
              onClick={() => void runReplace()}
            >
              {preview === null || ticked === 0 ? "Replace" : `Replace ${ticked.toLocaleString()}`}
            </Button>
          }
          scopeControl={
            <fieldset className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
              <legend className="sr-only">Look in</legend>
              {available.map((kind) => {
                const count = counts.get(kind)
                return (
                  <Checkbox
                    key={kind}
                    checked={kinds.includes(kind)}
                    onCheckedChange={(on) => setKinds(on ? [...kinds, kind] : kinds.filter((k) => k !== kind))}
                    hint={`Click to ${kinds.includes(kind) ? "leave out" : "look through"} ${kindNames(kind).many.toLowerCase()}.`}
                    hintInline={false}
                  >
                    <span data-kind-count={kind}>
                      {kindNames(kind).many}
                      {preview && count && (
                        <span className="text-muted tabular-nums">
                          {" "}
                          · {count.matches.toLocaleString()} in {count.entries.toLocaleString()}
                        </span>
                      )}
                    </span>
                  </Checkbox>
                )
              })}
            </fieldset>
          }
        />
      </form>
      {error && <Alert tone="danger">{error.message}</Alert>}
      {outcome !== null && "message" in outcome && <Alert tone="success">{outcome.message}</Alert>}
      {outcome !== null && "result" in outcome && (
        <Alert
          tone={outcome.result.entries > 0 ? "success" : "warning"}
          title={
            outcome.result.entries > 0
              ? `Replaced ${plural(outcome.result.matches, "match", "matches")} in ${plural(outcome.result.entries, "entry", "entries")}.`
              : "Nothing was replaced."
          }
          actions={
            outcome.result.editId !== null && (
              <Button
                hint="Takes this replace back in every entry not changed since."
                pending={replacing.pending}
                onClick={() => void undoLast(outcome.result.editId!)}
              >
                Undo
              </Button>
            )
          }
        >
          {outcome.result.approvedScripts.length > 0 && (
            <div>
              <p>Scripts kept approved after your replace:</p>
              <ul aria-label="Scripts kept approved" className="list-disc pl-5">
                {outcome.result.approvedScripts.map((script, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    <Tooltip label="Opens its editor.">
                      <Link
                        to="/library/$refId"
                        params={{ refId: script.refId }}
                        className="text-accent hover:underline"
                      >
                        {script.label}
                      </Link>
                    </Tooltip>
                    : {script.name || "Unnamed script"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {outcome.result.skipped.length > 0 && (
            <>
              <p>{`Skipped ${plural(outcome.result.skipped.length, "entry", "entries")}:`}</p>
              <ul aria-label="Skipped entries" className="list-disc pl-5">
                {outcome.result.skipped.map((s) => (
                  <li key={s.refId} data-library-skipped={s.refId}>
                    {s.label !== "" ? (
                      <Tooltip label="Opens its editor.">
                        <Link to="/library/$refId" params={{ refId: s.refId }} className="text-accent hover:underline">
                          {s.label}
                        </Link>
                      </Tooltip>
                    ) : (
                      "An entry"
                    )}
                    : {s.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}
      {preview !== null && (
        <section aria-label="What would change" className="flex min-w-0 flex-col gap-1">
          <p className="text-sm text-muted" aria-live="polite">
            {preview.entries.length === 0
              ? `No match in ${plural(preview.searched, "entry", "entries")}.`
              : `${plural(
                  preview.entries.reduce((n, e) => n + e.count, 0),
                  "match",
                  "matches"
                )} in ${plural(preview.entries.length, "entry", "entries")} of ${preview.searched.toLocaleString()}.`}
          </p>
          {preview.entries.length > 0 && (
            <ul aria-label="Entries found" className="flex min-w-0 flex-col">
              {preview.entries.slice(0, shown).map((entry) => (
                <EntryRow key={entry.refId} entry={entry} left={left} setLeft={setLeft} />
              ))}
            </ul>
          )}
          {preview.entries.length > shown && (
            <Button
              variant="ghost"
              className="self-start"
              hint="Lists more of the entries found. Replace changes every ticked one, listed or not."
              onClick={() => setShown(shown + LISTED)}
            >
              Show more
            </Button>
          )}
        </section>
      )}
      <RecentReplaces onUndone={(message) => setOutcome({ message })} />
    </InlinePanel>
  )
}
