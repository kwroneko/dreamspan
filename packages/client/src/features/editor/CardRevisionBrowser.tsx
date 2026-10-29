import { cardNames } from "@rp/shared/cardNames.ts"
import { Effect } from "effect"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { checkCardNames } from "./checkCardNames.ts"
// Compare immutable revisions with their first parent or the live working document.
import type { Doc, Revision } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Badge } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { ValueDiff } from "./diff.tsx"
import { changedFields, fieldLabel } from "./fields.ts"
import { type EditorStore, useEditorState, useWorkingDoc } from "./store.ts"

function RevisionComparison({ store, call, revision }: { store: EditorStore; call: Caller; revision: Revision }) {
  const [mode, setMode] = useState<"parent" | "current">("parent")
  const [docs, setDocs] = useState<{ doc: Doc; parent: Doc } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  // Subscribe to every draft so an external restore/recovery updates an open comparison.
  const state = useEditorState(store)
  useEffect(() => {
    let live = true
    void Promise.all([
      store.revisionDoc(revision.id),
      revision.parents[0] ? store.revisionDoc(revision.parents[0]) : Promise.resolve({})
    ]).then(
      ([doc, parent]) => {
        if (live) setDocs({ doc, parent })
      },
      (error: AppError) => {
        if (live) setError(error)
      }
    )
    return () => {
      live = false
    }
  }, [store, revision])
  const names = cardNames(docs?.doc ?? {})
  const nameCheck = useCardNameCheck(names.displayName, names.version, state.snapshot!.ref)
  const clash = state.snapshot!.ref.kind === "card" ? nameCheck : null
  const restore = async () => {
    if (!docs || clash) return
    const result = await call(
      (client) =>
        Effect.gen(function* () {
          if (state.snapshot!.ref.kind === "card")
            yield* checkCardNames(client, names.displayName, names.version, state.snapshot!.ref)
          return yield* client("RestoreRevision", {
            refId: store.refId,
            revisionId: revision.id,
            expectedRowVersion: state.snapshot!.ref.rowVersion
          })
        }),
      ["library"]
    )
    if (result.ok) await store.refresh()
    else setError(result.error)
  }
  const current = useWorkingDoc(store)
  const changes =
    docs === null ? null : mode === "parent" ? changedFields(docs.parent, docs.doc) : changedFields(docs.doc, current)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RadioGroup
        aria-label="Compare revision against"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "parent", label: "Parent revision" },
          { value: "current", label: "Current draft / head" }
        ]}
      />
      <p className="text-xs text-muted">
        {mode === "parent"
          ? revision.parents.length === 0
            ? "First revision, compared with an empty document."
            : "Before: first parent. After: selected revision."
          : "Before: selected revision. After: current draft, or the saved head when unchanged."}
      </p>
      <ErrorAlert error={error} />
      {changes === null ? (
        <p className="text-sm text-muted">Loading comparison…</p>
      ) : changes.length === 0 ? (
        <p className="text-sm text-muted">No fields differ.</p>
      ) : (
        <div aria-label="Revision changes" className="flex min-w-0 flex-col gap-2">
          {changes.map((change) => {
            const label = fieldLabel(state.snapshot!.ref.kind, mode === "parent" ? docs!.doc : current, change.path)
            return (
              <details key={JSON.stringify(change.path)} className="min-w-0 rounded-md border border-border p-2">
                <summary className="cursor-pointer text-sm font-medium [overflow-wrap:anywhere]">{label}</summary>
                <div className="mt-2">
                  <ValueDiff before={change.before} after={change.after} rich />
                </div>
              </details>
            )
          })}
        </div>
      )}
      {revision.id !== state.snapshot!.ref.headRevisionId && (
        <div>
          <Button disabled={!docs || clash !== null} onClick={() => void restore()}>
            Restore
          </Button>
          {docs && clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function CardRevisionBrowser({ store, call }: { store: EditorStore; call: Caller }) {
  const [revisions, setRevisions] = useState<ReadonlyArray<Revision>>([])
  const [selected, setSelected] = useState<Revision | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const head = useEditorState(store).snapshot!.ref.headRevisionId
  useEffect(() => {
    let live = true
    void call((client) => client("ListRevisions", { refId: store.refId, limit: 50 })).then((result) => {
      if (!live) return
      if (result.ok) setRevisions(result.value)
      else setError(result.error)
    })
    return () => {
      live = false
    }
  }, [store, call, head])
  const more = async () => {
    setPending(true)
    const result = await call((client) =>
      client("ListRevisions", { refId: store.refId, limit: 50, before: revisions.at(-1)!.id })
    )
    setPending(false)
    if (result.ok) setRevisions([...revisions, ...result.value])
    else setError(result.error)
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ErrorAlert error={error} />
      <ol aria-label="Revisions" className="flex flex-col divide-y divide-border">
        {revisions.map((revision) => (
          <li key={revision.id} className="flex min-w-0 flex-col gap-1 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" aria-pressed={selected?.id === revision.id} onClick={() => setSelected(revision)}>
                {new Date(revision.createdAt).toLocaleString()}
              </Button>
              <Badge>{revision.origin}</Badge>
              {revision.id === head && <Badge tone="accent">saved version</Badge>}
            </div>
            {revision.message && (
              <span className="text-sm text-muted [overflow-wrap:anywhere]">{revision.message}</span>
            )}
          </li>
        ))}
      </ol>
      {(revisions.at(-1)?.parents.length ?? 0) > 0 && (
        <Button pending={pending} onClick={() => void more()}>
          Earlier revisions
        </Button>
      )}
      {selected !== null && <RevisionComparison key={selected.id} store={store} call={call} revision={selected} />}
    </div>
  )
}
