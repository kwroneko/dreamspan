import { useEffect, useState, useSyncExternalStore } from "react"
import type { MessageImages } from "@rp/shared/chat.ts"
import type { DraftState } from "@rp/shared/drafts.ts"
import type { VersionAmendment } from "@rp/shared/chatApi.ts"
import { CodeEditor, type CodeEditorProps } from "../../ui/CodeEditor.tsx"
import { RevisionComparison } from "../../ui/RevisionDiff.tsx"
import { defineSlot } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { MenuItem } from "../../ui/Menu.tsx"
import type { MessageDraft } from "./messageDraft.ts"
import type { SummaryDraft } from "./summaryDraft.ts"
import { messageActions, type MessageActionProps } from "./messageActions.tsx"

export const messageEditorTools = defineSlot<{
  draft: MessageDraft
  base: string
  /** The images the version saved starts from: the edited source's, or the shown version's for one the user writes. */
  images: MessageImages
}>("message.editor.tools")
export const summaryEditorTools = defineSlot<{ draft: SummaryDraft; base: string }>("summary.editor.tools")

export const messageTextEditor = defineSlot<CodeEditorProps>("message.text-editor")
export const summaryTextEditor = defineSlot<CodeEditorProps>("summary.text-editor")

function CurrentChanges({ draft, base }: { draft: MessageDraft | SummaryDraft; base: string }) {
  const text = useSyncExternalStore(draft.subscribe, () => draft.snapshot().text)
  return <RevisionComparison label="Compare with saved text" before={base} after={text} />
}

function DraftHistory({ draft }: { draft: MessageDraft | SummaryDraft }) {
  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<ReadonlyArray<DraftState> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Button
        onClick={async () => {
          setOpen(true)
          setStates(null)
          setError(null)
          const result = await draft.history()
          if (result.ok) setStates(result.value)
          else setError(result.error.message)
        }}
      >
        Earlier draft text
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Earlier draft text"
        description="Restore any earlier text and images of this edit. Restoring keeps the current draft in this history."
      >
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {states === null ? (
          <p>{error ? "History unavailable." : "Loading…"}</p>
        ) : states.length < 2 ? (
          <p>No earlier text yet.</p>
        ) : (
          <ol className="flex flex-col gap-3 overflow-auto">
            {states.slice(1).map((state) => (
              <li key={state.seq} className="rounded-md border border-border p-3">
                <p className="text-sm text-muted">
                  {new Date(state.at).toLocaleString()} · {state.length} characters
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {state.kind === "initial" ? "Initial text" : `Changed “${state.removed}” to “${state.inserted}”`}
                </p>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    const restored = await draft.restoreState(state.seq)
                    setBusy(false)
                    if (restored) setOpen(false)
                    else
                      setError(
                        "Couldn't restore this text. Keep any pending text on the server and reopen History to try again."
                      )
                  }}
                >
                  Restore draft text
                </Button>
              </li>
            ))}
          </ol>
        )}
        <Button onClick={() => setOpen(false)}>Close history</Button>
      </Dialog>
    </>
  )
}

function Amendments({ session, entry, closeDialog, report }: MessageActionProps) {
  const [states, setStates] = useState<ReadonlyArray<VersionAmendment> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [base] = useState(() => ({ version: entry.version, forkId: session.snapshot().forkId }))
  useEffect(() => {
    let live = true
    void session
      .call((client) => client("VersionAmendments", { versionId: base.version.id }))
      .then((result) => {
        if (!live) return
        if (result.ok) setStates(result.value)
        else setError(result.error.message)
      })
    return () => {
      live = false
    }
  }, [session, base])
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && closeDialog()}
      title="Saved amendment history"
      description="Earlier saved text and images of this human-written version. Restoring changes only this fork and keeps the current version in history."
    >
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {states === null ? (
        <p>{error ? "History unavailable." : "Loading…"}</p>
      ) : states.length === 0 ? (
        <p>No saved amendments yet.</p>
      ) : (
        <ol className="flex flex-col gap-3 overflow-auto">
          {states.map((state) => (
            <li key={state.id} className="rounded-md border border-border p-3">
              <p className="text-sm text-muted">
                {new Date(state.at).toLocaleString()}
                {state.images !== undefined && ` · ${state.images.length} image${state.images.length === 1 ? "" : "s"}`}
              </p>
              <RevisionComparison label="Compare with saved text" before={state.content} after={base.version.content} />
              <Button
                disabled={busy}
                onClick={async () => {
                  const forkId = base.forkId
                  if (forkId === null) return
                  setBusy(true)
                  const result = await session.call((client) =>
                    client("RestoreVersionAmendment", {
                      versionId: base.version.id,
                      amendmentId: state.id,
                      forkId,
                      expectedRowVersion: base.version.rowVersion
                    })
                  )
                  setBusy(false)
                  report(result)
                  if (result.ok) closeDialog()
                  else setError(result.error.message)
                }}
              >
                Restore saved text
              </Button>
            </li>
          ))}
        </ol>
      )}
      <Button onClick={closeDialog}>Close history</Button>
    </Dialog>
  )
}

export const registerEditorHistory = () => [
  messageTextEditor.register({ id: "message.code-editor", order: 10, component: CodeEditor }),
  summaryTextEditor.register({ id: "summary.code-editor", order: 10, component: CodeEditor }),
  messageEditorTools.register({ id: "message.current-changes", order: 20, component: CurrentChanges }),
  summaryEditorTools.register({ id: "summary.current-changes", order: 20, component: CurrentChanges }),
  messageEditorTools.register({ id: "message.draft-history", order: 10, component: DraftHistory }),
  summaryEditorTools.register({ id: "summary.draft-history", order: 10, component: DraftHistory }),
  messageActions.register({
    id: "message.amendments",
    order: 15,
    available: ({ entry, generating }) => !generating && entry.version.writer === "human",
    menu: ({ openDialog }) => (
      <MenuItem icon="edit" onClick={() => openDialog("message.amendments")}>
        Saved amendment history
      </MenuItem>
    ),
    dialog: Amendments
  })
]
