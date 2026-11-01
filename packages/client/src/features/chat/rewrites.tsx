// What regex scripts did to a message when it was written (Version.rewrite): a note in its
// header, the scripts that changed it or were skipped under it, and "Show the original text",
// which reads the text from before them (RawVersionText) and can restore it (RestoreRawText).
import type { PathEntry } from "@rp/shared/chat.ts"
import type { RawText, ScriptRef } from "@rp/shared/regexScripts.ts"
import { sectionsDisplay } from "@rp/shared/replySections.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { messageActions, viewOf, type MessageActionProps } from "./messageActions.tsx"
import { messageDirections, messageHeaderDetails } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"

const SCOPES = { global: "global", preset: "preset", character: "character" } as const

/** "Strip thinking (preset)". */
export const scriptLabel = (script: ScriptRef) => `${script.name || "Unnamed script"} (${SCOPES[script.scope]})`

function RewriteBadge({ entry }: { entry: PathEntry; session: ChatSession; generating: boolean }) {
  const rewrite = entry.version.rewrite
  if (!rewrite || rewrite.applied.length === 0) return null
  return <Badge>scripts changed this</Badge>
}

function RewriteNotes({ entry }: { entry: PathEntry; session: ChatSession }) {
  const rewrite = entry.version.rewrite
  if (!rewrite) return null
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted [overflow-wrap:anywhere]">
      {rewrite.applied.length > 0 && (
        // A script that changed the reply and its thinking is named once.
        <p role="note">Changed by regex: {[...new Set(rewrite.applied.map(scriptLabel))].join(", ")}.</p>
      )}
      {rewrite.failed.map((failure, i) => (
        <p key={i} role="note" className="text-warning">
          The script {scriptLabel(failure.script)} was skipped: {failure.reason}
        </p>
      ))}
    </div>
  )
}

function OriginalText({ session, entry, report, closeDialog }: MessageActionProps) {
  const [raw, setRaw] = useState<RawText | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const versionId = entry.version.id
  useEffect(() => {
    let active = true
    void session
      .call((client) => client("RawVersionText", { versionId }))
      .then((result) => {
        if (!active) return
        if (result.ok) setRaw(result.value)
        else setError(result.error)
      })
    return () => {
      active = false
    }
  }, [session, versionId])
  const restore = async () => {
    setPending(true)
    const result = await session.restoreRawText(entry)
    setPending(false)
    if (result.ok) closeDialog()
    else setError(result.error)
    report(result)
  }
  const block =
    "max-h-80 overflow-auto rounded-md border border-border bg-canvas p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && closeDialog()}
      title="The original text"
      description="As it was before regex scripts changed it. It's never sent to a model; restoring it adds it as a new version of the message, which scripts don't change."
    >
      <ErrorAlert error={error} />
      {raw === null && error === null && <p className="text-sm text-muted">Loading…</p>}
      {raw !== null && (
        <div className="flex flex-col gap-3">
          {raw.content !== null && (
            <section aria-label="Original message text" className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Message</h3>
              <pre className={block}>{raw.content}</pre>
            </section>
          )}
          {raw.reasoning !== null && (
            <section aria-label="Original reasoning" className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Reasoning</h3>
              <pre className={block}>{raw.reasoning}</pre>
            </section>
          )}
          {raw.sections !== null && (
            <section aria-label="Original thinking in the reply" className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Thinking in the reply</h3>
              <pre className={block}>{sectionsDisplay(raw.sections)}</pre>
            </section>
          )}
          {raw.content === null && raw.reasoning === null && raw.sections === null && (
            <p className="text-sm text-muted">The scripts didn't change this version's text.</p>
          )}
        </div>
      )}
      <DialogActions>
        <Button onClick={closeDialog}>Close</Button>
        <Button
          variant="primary"
          pending={pending}
          disabled={raw === null || (raw.content === null && raw.reasoning === null && raw.sections === null)}
          onClick={() => void restore()}
        >
          Restore it
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export const registerRewrites = () => [
  messageHeaderDetails.register({ id: "message.rewrite-badge", order: 20, component: RewriteBadge }),
  messageDirections.register({ id: "message.rewrite-notes", order: 20, component: RewriteNotes }),
  messageActions.register({
    id: "message.original-text",
    order: 91,
    group: "context",
    available: ({ entry, generating }) =>
      !generating &&
      (entry.version.rewrite?.raw === true ||
        entry.version.rewrite?.rawReasoning === true ||
        entry.version.rewrite?.rawSections === true),
    describe: viewOf(({ openDialog }) => ({
      label: "Show the original text",
      icon: "original",
      hint: "The text as the model wrote it, before scripts changed it, with a way to restore it as a new version.",
      onSelect: () => openDialog("message.original-text")
    })),
    dialog: OriginalText
  })
]
