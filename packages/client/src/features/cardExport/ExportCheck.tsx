// Export with unsaved changes asks first (owner, 2026-11-02). An export is always saved
// revisions: the entry's, and for a card its exportable notes' (each a ref of its own, a linked
// one's text its shared note's). When any of them has fields not in its last revision, this
// lists them by name and offers "Save and export" (saves each, then exports), "Export the last
// revision" (without them), or Cancel. With nothing unsaved it downloads at once, as before.
// The changes are the ones an open editor has (its typing flushed first), or the server's
// drafts when none is open.
import { HELD_FIELD } from "@rp/shared/editing.ts"
import type { NoteEntry } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { type Caller, useCaller } from "../editor/caller.ts"
import { openEditorStore } from "../editor/openEditors.ts"
import { EditorStore } from "../editor/store.ts"
import { downloadExport } from "../library/files.ts"
import { endExport, type ExportRequest } from "./exportRequests.ts"
import { unsavedFieldNames } from "./unsaved.ts"

/** One ref the export takes, with its unsaved fields by name. */
interface Unsaved {
  readonly store: EditorStore
  readonly names: ReadonlyArray<string>
}

/** The editor open on `refId`, else one opened on the server's drafts; null if it can't open. */
const storeFor = async (refId: RefId, userId: string, call: Caller) => {
  const open = openEditorStore(refId)
  const store = open instanceof EditorStore ? open : new EditorStore(refId, userId, call)
  if (store.snapshot === null && !(await store.load()).ok) return null
  await store.flush()
  return store
}

const unsavedOf = (store: EditorStore, prefix = ""): Unsaved => ({
  store,
  names: unsavedFieldNames(store.snapshot?.ref.kind ?? "card", store.working().doc, store.head, [
    ...store.dirtyFields(),
    ...(store.held() === null ? [] : [HELD_FIELD])
  ]).map((name) => `${prefix}${name}`)
})

/** A card's exportable notes as the export takes them: each slot, or the shared note it shows. */
const noteStores = async (cardRefId: RefId, userId: string, call: Caller) => {
  const listed = await call((client) => client("ListCardNotes", { cardRefId }))
  if (!listed.ok) return []
  const notes = listed.value.filter(({ doc }) => doc.exportable === true)
  const linked = notes.some(({ doc }) => typeof doc.link === "string")
  const shared = linked ? await call((client) => client("ListLibrary", { kind: "note" })) : null
  const sharedRef = new Map(shared?.ok ? shared.value.map((ref) => [ref.entityId as string, ref.id]) : [])
  const refOf = ({ ref, doc }: NoteEntry) => (typeof doc.link === "string" ? sharedRef.get(doc.link) : ref.id)
  const found = await Promise.all(
    notes.map(async (note) => {
      const refId = refOf(note)
      const store = refId ? await storeFor(refId, userId, call) : null
      const title = typeof note.doc.title === "string" && note.doc.title !== "" ? note.doc.title : note.ref.label
      return store ? [unsavedOf(store, `Note “${title}”: `)] : []
    })
  )
  return found.flat()
}

export default function ExportCheck({ request }: { request: ExportRequest }) {
  const userId = useSession().user.id
  const call = useCaller()
  const [asking, setAsking] = useState<ReadonlyArray<Unsaved> | null>(null)
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
      const store = await storeFor(request.refId, userId, call)
      if (store === null) {
        // Not openable here: the export itself says what's wrong.
        await download()
        return done()
      }
      const all = [
        unsavedOf(store),
        ...(store.snapshot?.ref.kind === "card" ? await noteStores(request.refId, userId, call) : [])
      ].filter((entry) => entry.names.length > 0)
      if (all.length === 0) {
        await download()
        return done()
      }
      setAsking(all)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request: the host keys it by id
  }, [])

  if (asking === null) return null
  const names = asking.flatMap((entry) => entry.names)
  const saveAndExport = async () => {
    setPending("save")
    setError(null)
    // The card first, then its notes: each a revision of its own, as their own Saves make.
    for (const { store } of asking) {
      const saved = await store.commit(null)
      if (!saved.ok) {
        setPending(null)
        setError(saved.error)
        return
      }
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
      description={`An export is the last saved revision${asking.length > 1 ? "s" : ""}, without ${
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
          hint={`Exports as ${request.formatLabel} what was last saved, without these changes. They stay unsaved here.`}
          onClick={() => void exportLast()}
        >
          Export the last revision
        </Button>
        <Button
          variant="primary"
          disabled={pending === "last"}
          pending={pending === "save"}
          hint={`Saves these changes as new revisions${asking.length > 1 ? " (the card's and each note's)" : ""}, then exports them as ${request.formatLabel}.`}
          onClick={() => void saveAndExport()}
        >
          Save and export
        </Button>
      </DialogActions>
    </Dialog>
  )
}
