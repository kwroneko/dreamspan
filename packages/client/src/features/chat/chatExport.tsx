// ⋯ Export (registered as `chat.export`): the branch shown, or every branch, as a file the
// server writes while it reads the chat (ARCHITECTURE.md §13b). SillyTavern's .jsonl carries
// every version of each message, which one is shown, hidden messages and reasoning; plain
// text reads like ST's .txt export ("Name: text").
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { useEffect, useRef, useState } from "react"
import { Alert } from "../../ui/Surface.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { downloadChatExport } from "../library/files.ts"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { type ExportFormat, exportFormats } from "./chatExportText.ts"

type Scope = "branch" | "all"

/** What the file can't hold, so nobody expects it back from a re-import. */
const leftOut = (format: ExportFormat) =>
  format === "txt"
    ? "Only the shown text; no pictures (the chat’s own picture included), reasoning, notes, summaries, deleted messages, or privacy and thread boundaries."
    : "Not in the file: pictures (the chat’s own picture included), notes, summaries, edit history, deleted messages or branches, version marks, who wrote each version, status, and privacy or thread boundaries. Separate contexts and away periods become one transcript; changes during export may appear."

export function ExportChatDialog({ context, onClose }: ChatCommandDialogProps) {
  const { session, view } = context
  const formats = exportFormats(view)
  const [format, setFormat] = useState<ExportFormat>(formats[0] ?? "txt")
  const [scope, setScope] = useState<Scope>("branch")
  const [received, setReceived] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const running = received !== null
  useEffect(() => () => abort.current?.abort(), [])

  const run = async () => {
    setError(null)
    setReceived(0)
    const controller = new AbortController()
    abort.current = controller
    const result = await downloadChatExport(
      { chatId: session.id, forkId: view.forkId, scope, format },
      setReceived,
      controller.signal
    )
    abort.current = null
    setReceived(null)
    if (result === "aborted") return
    if (result !== null) return setError(result)
    onClose()
  }
  const cancel = () => {
    if (abort.current) abort.current.abort()
    else onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !running && onClose()}
      title="Export this chat"
      description="Every message from the first to the last, as a file to keep or open in SillyTavern."
    >
      <Segmented
        label="Format"
        value={format}
        onValueChange={setFormat}
        options={formats.map((value) => ({
          value,
          ...(value === "jsonl"
            ? {
                label: "SillyTavern (.jsonl)",
                description: "Every version of each message, which one is shown, hidden messages and reasoning."
              }
            : { label: "Plain text (.txt)", description: "Easy to read: each message as “Name: text”." })
        }))}
      />
      <Segmented
        label="Branches"
        value={scope}
        onValueChange={setScope}
        options={[
          { value: "branch", label: "This branch", description: "The branch shown, as one file." },
          {
            value: "all",
            label: "Every branch",
            description: "A .zip with a file for each branch, linked the way SillyTavern links branches."
          }
        ]}
      />
      <p className="text-sm text-muted">{leftOut(format)}</p>
      {error !== null && <Alert tone="danger">{error}</Alert>}
      {running && (
        <p role="status" className="text-sm text-muted">
          Exported {formatByteSize(received)}…
        </p>
      )}
      <DialogActions>
        <Button
          hint={
            running ? "Stops the export. Discard any unfinished download." : "Closes this dialog without exporting."
          }
          onClick={cancel}
        >
          {running ? "Stop" : "Cancel"}
        </Button>
        <Button
          hint="Downloads the file with the options above."
          variant="primary"
          disabled={!formats.includes(format)}
          pending={running}
          onClick={() => void run()}
        >
          Export
        </Button>
      </DialogActions>
    </Dialog>
  )
}
