// Export with unsaved changes asks first (owner, 2026-11-02). An export is always saved
// revisions: the entry's, and for a card its exportable notes' (each a ref of its own, a linked
// one's text its shared note's). When any of them has fields not in its last revision, this
// lists them by name and offers "Save and export" (saves each, then exports), "Export the last
// revision" (without them), or Cancel. With nothing unsaved it downloads at once, as before.
// The changes are the ones an open editor has (its typing flushed first), or the server's
// drafts when none is open.
import { useNavigate } from "@tanstack/react-router"
import { readReplaceTarget } from "@rp/shared/docs/note.ts"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { useEffect, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useCaller } from "../editor/caller.ts"
import { downloadExport } from "../library/files.ts"
import { endExport, type ExportRequest } from "./exportRequests.ts"
import { exportDrafts, type UnsavedExport } from "./exportDrafts.ts"

export default function ExportCheck({ request }: { request: ExportRequest }) {
  const userId = useSession().user.id
  const call = useCaller()
  const navigate = useNavigate()
  const [fields, setFields] = useState<ReadonlyArray<string>>([])
  const [notice, setNotice] = useState(false)
  const [asking, setAsking] = useState<ReadonlyArray<UnsavedExport> | null>(null)
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
      const checked = await exportDrafts(request.refId, userId, call)
      if (!checked.ok) {
        showToast({ title: `Couldn’t check ${request.label} for unsaved changes`, description: checked.error.message })
        return done()
      }
      const opened = await call((api) => api("OpenEditor", { refId: request.refId }))
      if (!opened.ok) {
        showToast({ title: "Couldn’t check the export", description: opened.error.message })
        return done()
      }
      let replaced: Array<string> = []
      if (opened.value.ref.kind === "card") {
        const notes = await call((api) => api("ListCardNotes", { cardRefId: request.refId }))
        if (!notes.ok) {
          showToast({ title: "Couldn’t check the notes", description: notes.error.message })
          return done()
        }
        replaced = [
          ...new Set(
            notes.value.flatMap((n) =>
              [n.doc.replaces, n.sent?.replaces].flatMap((raw) => {
                const target = readReplaceTarget(raw)
                return target?.kind === "card_field" &&
                  (target.card === undefined || target.card === opened.value.ref.entityId)
                  ? [
                      {
                        description: "Description",
                        personality: "Personality",
                        scenario: "Scenario",
                        mes_example: "Example messages",
                        system_prompt: "System prompt",
                        post_history_instructions: "Post-history instructions"
                      }[target.field]
                    ]
                  : []
              })
            )
          )
        ]
      }
      setFields(replaced)
      const all = checked.value
      if (all.length === 0 && replaced.length > 0) {
        setAsking([])
        setNotice(true)
        return
      }
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
    if (fields.length > 0) {
      setPending(null)
      setNotice(true)
      return
    }
    await download()
    done()
  }
  const exportLast = async () => {
    if (fields.length > 0) {
      setNotice(true)
      return
    }
    setPending("last")
    await download()
    done()
  }
  if (notice)
    return (
      <Dialog
        open
        onOpenChange={(open) => !open && done()}
        title="Export the original card"
        description={`${request.label}’s ${fields.join(", ")} is replaced here by notes. SillyTavern will get the original text, which still has every passage you moved, and none of your later note edits. The notes go in the file for this app.`}
      >
        <AboutHint heading="Exporting replacement notes">
          SillyTavern has no note conditions or field replacements. Import this file into this app to restore the notes
          and their positions.
        </AboutHint>
        <DialogActions>
          <Button
            hint="Opens this card’s notes to review the moved passages."
            onClick={() => {
              done()
              void navigate({
                to: "/library/$refId",
                params: { refId: request.refId },
                search: { [`cardTab:page:${request.refId}`]: "card.notes" }
              })
            }}
          >
            Open the notes
          </Button>
          <Button
            variant="primary"
            pending={pending === "last"}
            hint="Exports the original card text and this app’s notes."
            onClick={() => {
              setPending("last")
              void download().then(done)
            }}
          >
            Export
          </Button>
        </DialogActions>
      </Dialog>
    )
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
