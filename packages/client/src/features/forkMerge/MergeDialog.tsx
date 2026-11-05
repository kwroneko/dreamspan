// Merging a parent's (or a newer file's) changes into a fork (DESIGN §4, owner 2026-11-01: "like
// git branches ... You explicitly merge"). Pick the parent revision, then per prompt, entry and
// field which incoming changes to take; every conflict needs an explicit choice. The result is
// computed with the same registered merge policy the server uses, and shown as the changes it
// makes before merging. Unsaved fields refuse the merge: save or revert them first.
import { defaultLibraryMergePolicy, libraryMergePolicies, type MergeSelection } from "@rp/shared/forkMerge.ts"
import type { ForkMergePreview, MergeStatus } from "@rp/shared/forkMerge.ts"
import { hasSchema, validateDoc } from "@rp/shared/editing.ts"
import type { PresetPrompt } from "@rp/shared/docs/preset.ts"
import type { Doc, EntityKind, RefId, RevisionId } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field } from "../../ui/Field.tsx"
import { ReadableDiff, readableLines } from "../../ui/ReadableDiff.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Disclosure } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { type Caller, useCaller } from "../editor/caller.ts"
import { FieldComparison } from "../editor/CardRevisionBrowser.tsx"
import { type Choice, chosen, type Conflict, ConflictPicker } from "../editor/conflicts.tsx"
import { ValueDiff } from "../editor/diff.tsx"
import { changedFields, fieldLabel } from "../editor/fields.ts"
import { openEditorStore, refreshOpenEditors } from "../editor/openEditors.ts"
import { promptLabel } from "../editor/promptLabel.ts"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { EditorStore, useEditorState } from "../editor/store.ts"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { kindWord, linkedByHand, revisionsLine, sourceOf } from "./status.ts"

type Preview = typeof ForkMergePreview.Type
type Status = typeof MergeStatus.Type
type Unit = Preview["units"][number]
type Path = ReadonlyArray<string | number>

const keyOf = (path: Path) => JSON.stringify(path)
const under = (path: Path, parent: Path) => parent.length <= path.length && parent.every((p, i) => p === path[i])
const isText = (value: unknown) => value === undefined || typeof value === "string"
const policy = () => libraryMergePolicies.get("library.merge") ?? defaultLibraryMergePolicy

/** The user's picks, kept as one private draft so a reload or a crash doesn't lose typed text. */
interface Picks {
  readonly excluded: ReadonlyArray<string>
  readonly choices: Readonly<Record<string, Choice>>
}
const NO_PICKS = JSON.stringify({ excluded: [], choices: {} } satisfies Picks)
const readPicks = (text: string): Picks => {
  try {
    const parsed = JSON.parse(text) as Partial<Picks>
    return { excluded: parsed.excluded ?? [], choices: parsed.choices ?? {} }
  } catch {
    return { excluded: [], choices: {} }
  }
}

/** What an element of a keyed list is called, for an order's lines: a preset's prompts by name. */
const elementNames = (kind: EntityKind, docs: ReadonlyArray<Doc>, path: Path) => {
  const names = new Map<string, string>()
  for (const doc of docs) {
    if (kind === "preset" && path[0] === "order") {
      for (const p of (doc.prompts as ReadonlyArray<PresetPrompt> | undefined) ?? [])
        names.set(String(p.identifier), p.marker ? p.name : promptLabel(p.name, p.content).text)
      continue
    }
    let at: unknown = doc
    for (const p of path.slice(0, -1)) at = (at as Record<string | number, unknown> | undefined)?.[p]
    if (!Array.isArray(at)) continue
    for (const element of at as ReadonlyArray<Record<string, unknown>>) {
      const id = element.identifier ?? element.uid ?? element.id
      const name = [element.name, element.comment, element.label].find((v) => typeof v === "string" && v !== "")
      if (id !== undefined) names.set(String(id), (name as string | undefined) ?? String(id))
    }
  }
  return (value: unknown) =>
    Array.isArray(value) ? value.map((id, i) => `${i + 1}. ${names.get(String(id)) ?? String(id)}`) : readableLines(value)
}

const isOrder = (path: Path) => path.at(-1) === "$order"

/** A row's label: "Prompt “Main Prompt”", "Order of prompts", "Description". */
const unitLabel = (kind: EntityKind, preview: Preview, path: Path) => {
  if (isOrder(path)) {
    const list = path.slice(0, -1)
    if (kind === "preset" && list.length === 1 && list[0] === "order") return "Prompt order"
    return `Order of ${fieldLabel(kind, preview.theirs, list).toLowerCase()}`
  }
  const removed = preview.theirs
  return fieldLabel(kind, preview.merged, path, removed === preview.merged ? undefined : preview.base)
}

/** What the source did to it: a word for its badge. */
const changeWord = (unit: Unit) =>
  isOrder(unit.path)
    ? "moved"
    : unit.base === undefined
      ? "added"
      : unit.theirs === undefined
        ? "removed"
        : "changed"

function UnitChange({ unit, kind, preview, source }: { unit: Unit; kind: EntityKind; preview: Preview; source: string }) {
  if (isOrder(unit.path))
    return (
      <ReadableDiff
        before={unit.base}
        after={unit.theirs}
        lines={elementNames(kind, [preview.base, preview.theirs], unit.path)}
      />
    )
  if (isText(unit.base) && isText(unit.theirs))
    return <ValueDiff before={unit.base} after={unit.theirs} beforeLabel="Before" afterLabel={source} rich />
  const object = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v)
  if ((unit.base === undefined || object(unit.base)) && (unit.theirs === undefined || object(unit.theirs))) {
    const changes = changedFields(unit.base ?? {}, unit.theirs ?? {}, unit.path)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {changes.map((change) => (
          <FieldComparison
            key={keyOf(change.path)}
            label={fieldLabel(kind, preview.theirs, change.path, preview.base)}
            change={change}
            doc={preview.theirs}
            beforeLabel="Before"
            afterLabel={source}
          />
        ))}
      </div>
    )
  }
  return <ReadableDiff before={unit.base} after={unit.theirs} />
}

function UnitRow({
  unit,
  kind,
  preview,
  conflicts,
  included,
  onInclude,
  picks,
  onPick,
  sourceName,
  sourceWord
}: {
  unit: Unit
  kind: EntityKind
  preview: Preview
  conflicts: ReadonlyArray<Conflict>
  included: boolean
  onInclude: (included: boolean) => void
  picks: Picks
  onPick: (key: string, choice: Choice) => void
  /** "Parent's version", "File's version". */
  sourceName: string
  /** "parent", "file". */
  sourceWord: string
}) {
  const label = unitLabel(kind, preview, unit.path)
  return (
    <li
      aria-label={label}
      className={`flex min-w-0 flex-col gap-2 rounded-md border p-3 ${conflicts.length > 0 && included ? "border-warning/60" : "border-border"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{label}</span>
          <Badge>{changeWord(unit)}</Badge>
          {conflicts.length > 0 ? (
            <Badge tone="warning">{conflicts.length === 1 ? "conflict" : `${conflicts.length} conflicts`}</Badge>
          ) : (
            unit.oursChanged && <Badge>also changed here</Badge>
          )}
        </div>
        <Switch
          checked={included}
          onCheckedChange={onInclude}
          hint={included ? `Click to leave this change out` : `Click to take this change from the ${sourceWord}`}
        >
          Take
        </Switch>
      </div>
      <Disclosure title={`The ${sourceWord}'s change`} hint={`Shows what the ${sourceWord} changed here.`} lazy>
        <UnitChange unit={unit} kind={kind} preview={preview} source={sourceName} />
      </Disclosure>
      {included && conflicts.length > 0 && (
        <ul aria-label={`Conflicts in ${label}`} className="flex flex-col gap-2">
          {conflicts.map((conflict) => (
            <ConflictPicker
              key={conflict.key}
              conflict={conflict}
              choice={picks.choices[conflict.key] ?? null}
              onChoice={(choice) => onPick(conflict.key, choice)}
              mineLabel="Current version"
              theirsLabel={sourceName}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The review of one comparison (the fork's head, its base and one source revision), with the
 * picks in a private draft keyed by those three: a new comparison starts from the previous picks.
 */
function MergeReview({
  preview,
  store,
  label,
  sourceWord,
  carried,
  fromFile,
  onAgain,
  onClose,
  header
}: {
  preview: Preview
  store: EditorStore
  label: string
  sourceWord: "parent" | "file"
  /** Picks from an earlier comparison of the same fork, carried into this one. */
  carried: string
  fromFile: boolean
  onAgain: (picks: string) => void
  onClose: () => void
  header: React.ReactNode
}) {
  const call = useCaller()
  const kind = preview.ref.kind
  const durable = useUserDraft(
    `merge:${preview.ref.id}:${preview.baseRevisionId ?? "none"}:${preview.oursRevisionId}:${preview.theirsRevisionId}`,
    "Merge choices",
    carried
  )
  const picks = readPicks(durable.text)
  const setPicks = (next: Picks) => durable.setText(JSON.stringify(next))
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const sourceName = sourceWord === "parent" ? "Parent's version" : "File's version"

  const conflicts = useMemo(
    () =>
      preview.conflicts.map((c) => {
        const order = isOrder(c.path)
        const lines = order ? elementNames(kind, [preview.ours, preview.theirs], c.path) : null
        return {
          path: c.path,
          conflict: {
            key: keyOf(c.path),
            label: order ? unitLabel(kind, preview, c.path) : fieldLabel(kind, preview.merged, c.path, preview.base),
            mine: c.ours,
            theirs: c.theirs,
            base: c.base,
            ...(lines ? { show: (value: unknown) => lines(value).join("\n"), editable: false } : {})
          } satisfies Conflict
        }
      }),
    [preview, kind]
  )
  // What the source changed; changes made only here stay as they are and need no row.
  const incoming = preview.units.filter((unit) => unit.theirsChanged)
  const localOnly = preview.units.length - incoming.length
  const conflictsOf = (unit: Unit) => conflicts.filter((c) => under(c.path, unit.path)).map((c) => c.conflict)
  const rows = [...incoming].sort((a, b) => Number(conflictsOf(b).length > 0) - Number(conflictsOf(a).length > 0))
  const loose = conflicts.filter((c) => !incoming.some((unit) => under(c.path, unit.path)))

  const excludedPaths = incoming.filter((unit) => picks.excluded.includes(keyOf(unit.path))).map((unit) => unit.path)
  const includedConflicts = conflicts.filter((c) => !excludedPaths.some((e) => under(c.path, e)))
  const unresolved = includedConflicts.filter((c) => picks.choices[c.conflict.key] === undefined).length
  const badEdit = includedConflicts.find((c) => {
    const choice = picks.choices[c.conflict.key]
    return choice?.side === "edit" && chosen(c.conflict, choice) === undefined
  })

  const selection: MergeSelection = {
    excluded: excludedPaths,
    resolutions: includedConflicts.flatMap((c) => {
      const choice = picks.choices[c.conflict.key]
      if (!choice) return []
      const value = chosen(c.conflict, choice)
      return [value === undefined && choice.side !== "edit" ? { path: c.path } : { path: c.path, value }]
    })
  }
  // The result as the server will compute it, with the same policy; null until every conflict is picked.
  const outcome = useMemo((): { doc: Doc } | { problem: string } | null => {
    if (unresolved > 0) return null
    if (badEdit) return { problem: `${badEdit.conflict.label}: the edited value isn't valid JSON.` }
    try {
      const doc = policy().resolve(preview.base, preview.ours, preview.theirs, selection, kind)
      if (!hasSchema(kind)) return { doc }
      const check = validateDoc(kind, doc)
      if (check.ok) return { doc }
      const where = check.paths.map((path) => fieldLabel(kind, doc, path.slice(0, 2))).filter((l) => l !== "")
      return { problem: `The result isn't valid: ${[...new Set(where)].join(", ") || check.problems.join(" ")}.` }
    } catch (cause) {
      return { problem: cause instanceof Error ? cause.message : "These choices don't fit together." }
    }
    // `selection` is derived from `picks`, which `durable.text` holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, kind, durable.text, unresolved, badEdit])
  const changes = outcome && "doc" in outcome ? changedFields(preview.ours, outcome.doc) : null

  const include = (unit: Unit, on: boolean) => {
    const key = keyOf(unit.path)
    setPicks({ ...picks, excluded: on ? picks.excluded.filter((k) => k !== key) : [...picks.excluded, key] })
  }

  const merge = async () => {
    setError(null)
    setPending(true)
    let failure: AppError | null = null
    await durable.commit(durable.text, async () => {
      const result = await call(
        (client) =>
          client("CommitForkMerge", {
            refId: preview.ref.id,
            theirsRevisionId: preview.theirsRevisionId,
            baseRevisionId: preview.baseRevisionId,
            expectedRowVersion: preview.ref.rowVersion,
            selection,
            message: fromFile ? "Merged a new version from a file" : "Merged changes from the parent"
          }),
        ["library"]
      )
      if (!result.ok) failure = result.error
      return result.ok
    })
    setPending(false)
    if (failure) return setError(failure)
    await store.refresh()
    await refreshOpenEditors()
    showToast({ title: `Merged into ${label}` })
    onClose()
  }
  const stale = error !== null && ["StaleWrite", "EditRefused"].includes(error.tag)
  const blocked =
    unresolved > 0
      ? `Choose a version for each conflict first (${unresolved} left).`
      : outcome && "problem" in outcome
        ? outcome.problem
        : null

  return (
    <>
      {header}
      <UserDraftStatus draft={durable} />
      {preview.baseRevisionId === null && (
        <p className="text-sm text-muted">
          There's no shared starting revision, so every difference shows as a change on both sides.
        </p>
      )}
      {fromFile && kind === "card" && (
        <p className="text-sm text-muted">
          The card's own notes keep their text. Its lorebook is part of the card and is merged here.
        </p>
      )}
      <section aria-labelledby="merge-changes" className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="merge-changes" className="font-medium">
            {rows.length === 0
              ? `Nothing new from the ${sourceWord}`
              : `${rows.length} ${rows.length === 1 ? "change" : "changes"} from the ${sourceWord}`}
          </h3>
          <div className="flex gap-2">
            <Button
              className="h-8 px-2"
              disabled={rows.length === 0 || picks.excluded.length === 0}
              focusableWhenDisabled
              hint={`Takes every change from the ${sourceWord}.`}
              onClick={() => setPicks({ ...picks, excluded: [] })}
            >
              Take all
            </Button>
            <Button
              className="h-8 px-2"
              disabled={rows.length === 0 || excludedPaths.length === rows.length}
              focusableWhenDisabled
              hint={`Leaves out every change from the ${sourceWord}.`}
              onClick={() => setPicks({ ...picks, excluded: rows.map((unit) => keyOf(unit.path)) })}
            >
              Leave all out
            </Button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">This {kindWord(kind)} already has everything this revision changed.</p>
        ) : (
          <ul aria-label="Changes to merge" className="flex min-w-0 flex-col gap-2">
            {rows.map((unit) => (
              <UnitRow
                key={keyOf(unit.path)}
                unit={unit}
                kind={kind}
                preview={preview}
                conflicts={conflictsOf(unit)}
                included={!picks.excluded.includes(keyOf(unit.path))}
                onInclude={(on) => include(unit, on)}
                picks={picks}
                onPick={(key, choice) => setPicks({ ...picks, choices: { ...picks.choices, [key]: choice } })}
                sourceName={sourceName}
                sourceWord={sourceWord}
              />
            ))}
          </ul>
        )}
        {loose.length > 0 && (
          <ul aria-label="Other conflicts" className="flex flex-col gap-2">
            {loose.map(({ conflict }) => (
              <ConflictPicker
                key={conflict.key}
                conflict={conflict}
                choice={picks.choices[conflict.key] ?? null}
                onChoice={(choice) => setPicks({ ...picks, choices: { ...picks.choices, [conflict.key]: choice } })}
                mineLabel="Current version"
                theirsLabel={sourceName}
              />
            ))}
          </ul>
        )}
        {localOnly > 0 && (
          <p className="text-sm text-muted">
            {localOnly === 1 ? "1 change made only here stays" : `${localOnly} changes made only here stay`} as it is.
          </p>
        )}
        {excludedPaths.length > 0 && (
          <p className="text-sm text-muted">
            Changes left out aren't offered again for this revision. A later {sourceWord} revision that changes them
            again is.
          </p>
        )}
      </section>
      {changes && (
        <section aria-labelledby="merge-result" className="flex min-w-0 flex-col gap-2">
          <h3 id="merge-result" className="font-medium">
            What merging changes in {label}
          </h3>
          {changes.length === 0 ? (
            <p className="text-sm text-muted">Nothing: the content stays as it is.</p>
          ) : (
            <div aria-label="Merge result" className="flex min-w-0 flex-col gap-2">
              {changes.map((change) => (
                <FieldComparison
                  key={keyOf(change.path)}
                  label={fieldLabel(kind, outcome && "doc" in outcome ? outcome.doc : preview.ours, change.path, preview.ours)}
                  change={change}
                  doc={outcome && "doc" in outcome ? outcome.doc : preview.ours}
                  beforeLabel="Now"
                  afterLabel="After merging"
                />
              ))}
            </div>
          )}
        </section>
      )}
      {blocked && (
        <p role="status" className="text-sm text-muted">
          {blocked}
        </p>
      )}
      <ErrorAlert
        error={error}
        title="Couldn't merge"
        actions={
          stale ? (
            <Button hint="Compares again with the latest saved revisions." onClick={() => onAgain(durable.text)}>
              Compare again
            </Button>
          ) : undefined
        }
      />
      <DialogActions>
        <Button hint="Closes this review without merging." onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          pending={pending}
          disabled={blocked !== null}
          focusableWhenDisabled
          hint={blocked ?? `Makes a revision of ${label} with the changes taken.`}
          onClick={() => void merge()}
        >
          Merge
        </Button>
      </DialogActions>
    </>
  )
}

const revisionLabel = (revision: Status["versions"][number], index: number) =>
  `${index === 0 ? "Latest · " : ""}${new Date(revision.createdAt).toLocaleString()}${revision.message ? ` · ${revision.message}` : ""}`

/** The fork's editor store: the one open on the page, or one of its own. */
function useStore(refId: RefId, given: EditorStore | undefined) {
  const call = useCaller()
  const user = useSession().user.id
  const found = given ?? (openEditorStore(refId) as EditorStore | undefined)
  const [own, setOwn] = useState<EditorStore | null>(null)
  useEffect(() => {
    if (found) return
    let live = true
    const store = new EditorStore(refId, user, call)
    void store.load().then(() => live && setOwn(store))
    return () => {
      live = false
    }
  }, [found, refId, user, call])
  return found ?? own
}

export function MergeDialog({
  refId,
  store: given,
  theirsRevisionId,
  fromFile,
  onClose
}: {
  refId: RefId
  store?: EditorStore
  /** A revision chosen already (a file just staged); otherwise the newest. */
  theirsRevisionId?: RevisionId
  /** The file being merged, when it's one. */
  fromFile?: string
  onClose: () => void
}) {
  const store = useStore(refId, given)
  const props = { refId, initial: theirsRevisionId, fromFile, onClose }
  return store ? <LoadedMerge store={store} {...props} /> : <MergeFrame title="Merge" {...props} />
}

function MergeFrame({
  title,
  fromFile,
  onClose,
  children
}: {
  title: string
  fromFile: string | undefined
  onClose: () => void
  children?: React.ReactNode
}) {
  return (
    <Dialog
      wide
      placement="top"
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={
        fromFile
          ? `Pick which of ${fromFile}'s changes to take. Your own edits stay where the file didn't change them.`
          : "Pick which changes to take. This one's own edits stay where the other side didn't change them."
      }
    >
      {children ?? <p className="text-sm text-muted">Opening…</p>}
    </Dialog>
  )
}

function LoadedMerge({
  store,
  refId,
  initial,
  fromFile,
  onClose
}: {
  store: EditorStore
  refId: RefId
  initial: RevisionId | undefined
  fromFile: string | undefined
  onClose: () => void
}) {
  const state = useEditorState(store)
  const ref = state.snapshot?.ref
  return (
    <MergeFrame title={ref ? `Merge into ${ref.label}` : "Merge"} fromFile={fromFile} onClose={onClose}>
      {state.loadError ? (
        <ErrorAlert error={state.loadError} />
      ) : ref ? (
        <MergeBody store={store} refId={refId} initial={initial} fromFile={fromFile} onClose={onClose} />
      ) : undefined}
    </MergeFrame>
  )
}

function MergeBody({
  store,
  refId,
  initial,
  fromFile,
  onClose
}: {
  store: EditorStore
  refId: RefId
  initial: RevisionId | undefined
  fromFile: string | undefined
  onClose: () => void
}) {
  const call = useCaller()
  const state = useEditorState(store)
  const ref = state.snapshot!.ref
  const dirty = state.dirty
  const [status, setStatus] = useState<Status | null>(null)
  const [parent, setParent] = useState<{ refId: RefId; label: string; subtitle: string } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [chosenId, setChosenId] = useState<RevisionId | null>(initial ?? null)
  const [nonce, setNonce] = useState(0)
  const [carried, setCarried] = useState(NO_PICKS)
  // Each answer names the comparison it answers; a later choice makes an earlier answer stale.
  const [answer, setAnswer] = useState<{ for: string; preview?: Preview; error?: AppError } | null>(null)

  useEffect(() => {
    let live = true
    void readStatus(call, refId).then((result) => {
      if (!live) return
      if (!result.ok) return setError(result.error)
      setStatus(result.status)
      setParent(result.parent)
    })
    return () => {
      live = false
    }
  }, [call, refId, nonce, ref.headRevisionId])

  const selected = chosenId ?? status?.versions[0]?.id ?? null
  const want = `${selected}:${nonce}:${ref.headRevisionId}`
  useEffect(() => {
    if (status === null || selected === null || dirty > 0 || linkedByHand(status)) return
    let live = true
    void call((client) => client("PreviewForkMerge", { refId, theirsRevisionId: selected })).then((result) => {
      if (!live) return
      setAnswer(result.ok ? { for: want, preview: result.value } : { for: want, error: result.error })
    })
    return () => {
      live = false
    }
  }, [call, refId, status, selected, dirty, want])
  const current = answer?.for === want ? answer : null
  const preview = current?.preview ?? null

  if (status === null)
    return error ? <ErrorAlert error={error} /> : <p className="text-sm text-muted">Reading what's new…</p>
  const sourceWord = fromFile ? "file" : sourceOf(status)
  const versions = status.versions
  if (linkedByHand(status))
    return (
      <>
        <p className="text-sm">
          This {kindWord(ref.kind)} was marked as a fork by hand, so there's no shared starting revision to compare
          its changes with.
        </p>
        <DialogActions>
          <Button hint="Closes this review." onClick={onClose}>
            Close
          </Button>
        </DialogActions>
      </>
    )
  const header = (
    <div className="flex min-w-0 flex-col gap-2">
      {parent && (
        <p className="text-sm">
          From{" "}
          <Link
            to="/library/$refId"
            params={{ refId: parent.refId }}
            className="text-accent underline-offset-4 hover:underline [overflow-wrap:anywhere]"
            title="Opens the parent's editor"
          >
            {parent.label}
            {parent.subtitle ? ` · ${parent.subtitle}` : ""}
          </Link>
          , {revisionsLine(versions.length)} since the fork or last merge.
        </p>
      )}
      {!fromFile && versions.length > 1 && (
        <Field
          label={sourceWord === "parent" ? "Parent revision" : "Imported version"}
          about="The revision whose changes are offered. An older one leaves the later ones to merge another time."
        >
          <Select
            items={versions.map((revision, index) => ({ value: revision.id, label: revisionLabel(revision, index) }))}
            value={selected}
            onValueChange={(id) => setChosenId(id)}
          />
        </Field>
      )}
      {!fromFile && versions.length === 1 && (
        <p className="text-sm text-muted">{revisionLabel(versions[0]!, 0)}</p>
      )}
    </div>
  )
  if (versions.length === 0 && !preview)
    return (
      <>
        <p className="text-sm">Nothing new to merge: this already has every {sourceWord} revision.</p>
        <DialogActions>
          <Button hint="Closes this review." onClick={onClose}>
            Close
          </Button>
        </DialogActions>
      </>
    )
  if (dirty > 0)
    return (
      <>
        {header}
        <Alert tone="warning" title={`${dirty === 1 ? "A field has" : `${dirty} fields have`} unsaved changes`}>
          <p>
            Save them as a revision or revert them first, so the merge compares saved revisions only.
          </p>
          <div className="mt-2">
            <SaveRevision store={store} />
          </div>
        </Alert>
      </>
    )
  return preview ? (
    <MergeReview
      key={`${preview.baseRevisionId}:${preview.oursRevisionId}:${preview.theirsRevisionId}`}
      preview={preview}
      store={store}
      label={ref.label}
      sourceWord={sourceWord}
      carried={carried}
      fromFile={fromFile !== undefined}
      header={header}
      onAgain={(picks) => {
        setCarried(picks)
        setNonce((n) => n + 1)
      }}
      onClose={onClose}
    />
  ) : (
    <>
      {header}
      {(current?.error ?? error) ? (
        <ErrorAlert
          error={current?.error ?? error}
          actions={
            <Button hint="Compares again with the latest saved revisions." onClick={() => setNonce((n) => n + 1)}>
              Retry
            </Button>
          }
        />
      ) : (
        <p className="text-sm text-muted">Comparing…</p>
      )}
    </>
  )
}

/** The status, and the parent's name and link from the family (the status names only its id). */
const readStatus = async (
  call: Caller,
  refId: RefId
): Promise<
  | { ok: true; status: Status; parent: { refId: RefId; label: string; subtitle: string } | null }
  | { ok: false; error: AppError }
> => {
  const status = await call((client) => client("ForkMergeStatus", { refId }))
  if (!status.ok) return status
  const parentId = status.value.parentRefId
  if (parentId === null) return { ok: true, status: status.value, parent: null }
  const family = await call((client) => client("LibraryGenealogy", { refId }))
  const member = family.ok ? family.value.members.find((m) => m.refId === parentId) : undefined
  return {
    ok: true,
    status: status.value,
    parent: member ? { refId: parentId, label: member.label, subtitle: member.subtitle } : null
  }
}
