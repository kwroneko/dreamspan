// Export with unsaved changes asks first (owner, 2026-11-02). An export is always a saved
// revision; when the entry has fields not in one, this lists them by name and offers "Save and
// export" (cuts a revision, then exports it), "Export the last revision" (without them), or
// Cancel. With nothing unsaved it downloads at once, as before. The changes are the ones the
// open editor has (its typing flushed first), or the server's drafts when none is open.
import { useEffect, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useCaller } from "../editor/caller.ts"
import { openEditorStore } from "../editor/openEditors.ts"
import { EditorStore } from "../editor/store.ts"
import { downloadExport } from "../library/files.ts"
import { endExport, type ExportRequest } from "./exportRequests.ts"
import { unsavedFieldNames } from "./unsaved.ts"

export default function ExportCheck({ request }: { request: ExportRequest }) {
  const userId = useSession().user.id
  const call = useCaller()
  const [asking, setAsking] = useState<{ readonly store: EditorStore; readonly names: ReadonlyArray<string> } | null>(
    null
  )
  const [pending, setPending] = useState<"save" | "last" | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const started = useRef(false)
  const done = () => endExport(request.id)
  const download = async () => {
    const failed = await downloadExport(request.refId, request.format, request.label)
    if (failed) showToast({ title: `Couldn’t export ${request.label}`, description: failed })
  }

  useEffect(() => {
    // Once per request, also where React runs effects twice.
    if (started.current) return
    started.current = true
    void (async () => {
      const open = openEditorStore(request.refId)
      const store = open instanceof EditorStore ? open : new EditorStore(request.refId, userId, call)
      if (store.snapshot === null) {
        const loaded = await store.load()
        if (!loaded.ok) {
          // Not openable here (no drafts of this user's, say): the export itself says what's wrong.
          await download()
          return done()
        }
      }
      await store.flush()
      const kind = store.snapshot?.ref.kind ?? "card"
      const names = unsavedFieldNames(kind, store.working().doc, store.head, store.dirtyFields())
      if (names.length === 0) {
        await download()
        return done()
      }
      setAsking({ store, names })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request: the host keys it by id
  }, [])

  if (asking === null) return null
  const { store, names } = asking
  const saveAndExport = async () => {
    setPending("save")
    setError(null)
    const saved = await store.commit(null)
    if (!saved.ok) {
      setPending(null)
      setError(saved.error)
      return
    }
    await download()
    done()
  }
  const exportLast = async () => {
    setPending("last")
    await download()
    done()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && pending === null && done()}
      title={`${request.label} has unsaved changes`}
      description={`An export is a saved revision. Revision ${store.revisionNumber} doesn't have ${
        names.length === 1 ? "this change" : `these ${names.length} changes`
      }:`}
    >
      <ul
        aria-label="Unsaved changes"
        className="flex max-h-60 list-disc flex-col gap-0.5 overflow-y-auto pl-5 text-sm"
      >
        {names.map((name) => (
          <li key={name} className="[overflow-wrap:anywhere]">
            {name}
          </li>
        ))}
      </ul>
      <ErrorAlert error={error} title="Not saved, so not exported" />
      <DialogActions>
        <Button
          variant="ghost"
          disabled={pending !== null}
          hint="Closes this; nothing is saved or exported."
          onClick={done}
        >
          Cancel
        </Button>
        <Button
          disabled={pending === "save"}
          pending={pending === "last"}
          hint={`Exports revision ${store.revisionNumber} as ${request.formatLabel}, without these changes. They stay unsaved here.`}
          onClick={() => void exportLast()}
        >
          Export the last revision
        </Button>
        <Button
          variant="primary"
          disabled={pending === "last"}
          pending={pending === "save"}
          hint={`Saves these changes as revision ${store.revisionNumber + 1}, then exports it as ${request.formatLabel}.`}
          onClick={() => void saveAndExport()}
        >
          Save and export
        </Button>
      </DialogActions>
    </Dialog>
  )
}
