import { cardNames } from "@rp/shared/cardNames.ts"
import { useCardNameCheck } from "./cardNameCheck.ts"
// A ref's revisions, newest first (DESIGN §4: revisions sit behind a History button). Each
// compares with the saved version, and restores as a new revision, so nothing is lost.
import type { Doc, Revision } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Badge } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { ValueDiff } from "./diff.tsx"
import { changedFields, fieldLabel } from "./fields.ts"
import { type EditorStore, useEditorState } from "./store.ts"

const ORIGINS: Record<Revision["origin"], string> = {
  import: "imported",
  user: "edited",
  agent: "by the agent",
  changeset: "changeset",
  merge: "merged"
}

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

function RevisionRow({
  store,
  call,
  revision,
  current
}: {
  store: EditorStore
  call: Caller
  revision: Revision
  current: boolean
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const snapshot = useEditorState(store).snapshot!
  const names = cardNames(doc ?? snapshot.doc)
  const nameCheck = useCardNameCheck(names.displayName, names.version, snapshot.ref)
  const clash =
    snapshot.ref.kind === "card"
      ? doc === null
        ? "Compare this revision to check its card names before restoring."
        : nameCheck
      : null

  const compare = async () => {
    setOpen(!open)
    if (doc !== null) return
    const result = await call((client) => client("GetRevision", { refId: store.refId, revisionId: revision.id }))
    if (result.ok) setDoc(result.value)
    else setError(result.error)
  }

  const restore = async () => {
    if (clash) return
    setPending(true)
    const result = await call(
      (client) =>
        client("RestoreRevision", {
          refId: store.refId,
          revisionId: revision.id,
          expectedRowVersion: snapshot.ref.rowVersion
        }),
      ["library"]
    )
    setPending(false)
    if (result.ok) await store.refresh()
    else setError(result.error)
  }

  const changes = doc === null ? [] : changedFields(doc, snapshot.doc)
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {when(revision.createdAt)}
            <Badge>{ORIGINS[revision.origin]}</Badge>
            {current && <Badge tone="accent">saved version</Badge>}
          </span>
          {revision.message && <span className="text-sm text-muted [overflow-wrap:anywhere]">{revision.message}</span>}
        </div>
        {!current && (
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" aria-expanded={open} onClick={() => void compare()}>
              Compare
            </Button>
            <Button pending={pending} disabled={clash !== null} onClick={() => void restore()}>
              Restore
            </Button>
          </div>
        )}
      </div>
      {!current && clash && (
        <p role="status" className="text-sm text-muted">
          {clash}
        </p>
      )}
      <ErrorAlert error={error} />
      {open && doc !== null && (
        <div className="flex flex-col gap-2">
          {changes.length === 0 ? (
            <p className="text-sm text-muted">The same as the saved version.</p>
          ) : (
            changes.map((change) => {
              const label = fieldLabel(snapshot.ref.kind, snapshot.doc, change.path)
              return (
                <div key={label} className="flex flex-col gap-1">
                  <span className="text-sm [overflow-wrap:anywhere]">
                    {label}, from this revision to the saved version
                  </span>
                  <ValueDiff before={change.before} after={change.after} />
                </div>
              )
            })
          )}
        </div>
      )}
    </li>
  )
}

export function RevisionsDialog({ store, call, onClose }: { store: EditorStore; call: Caller; onClose: () => void }) {
  const [revisions, setRevisions] = useState<ReadonlyArray<Revision> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const head = useEditorState(store).snapshot!.ref.headRevisionId

  useEffect(() => {
    void call((client) => client("ListRevisions", { refId: store.refId, limit: 100 })).then((result) =>
      result.ok ? setRevisions(result.value) : setError(result.error)
    )
  }, [call, store, head])

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="History"
      description="Restoring makes a new revision with that content: the revisions after it stay."
    >
      <ErrorAlert error={error} />
      {revisions === null && error === null && <p className="text-sm text-muted">Loading…</p>}
      {revisions !== null && (
        <ol aria-label="Revisions" className="flex flex-col divide-y divide-border">
          {revisions.map((revision) => (
            <RevisionRow
              key={revision.id}
              store={store}
              call={call}
              revision={revision}
              current={revision.id === head}
            />
          ))}
        </ol>
      )}
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
