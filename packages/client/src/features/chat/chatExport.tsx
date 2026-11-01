// ⋯ Export (registered as `chat.export`): the branch shown as a file, read a page at a time
// from its first message to its last. Plain text reads like ST's .txt export ("Name: text");
// SillyTavern's .jsonl has its header line and one line per message, the version shown only,
// which ST and this app's importer both open.
import type { PathEntry } from "@rp/shared/chat.ts"
import { useState } from "react"
import type { AppError } from "../../errors.ts"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { chatDisplayName } from "./chatTitle.ts"
import { type ExportFormat, exportText } from "./chatExportText.ts"
import type { ChatSession, ChatView } from "./session.ts"

type Format = ExportFormat
const PAGE = 500

/** Every message of the fork shown, first to last. */
async function readAll(session: ChatSession, view: ChatView, onProgress: (n: number) => void) {
  const all: Array<PathEntry> = []
  if (view.leafSlotId === null) return { ok: true as const, value: all }
  let range: { _tag: "Bottom" } | { _tag: "Older"; from: PathEntry["slotId"] } = { _tag: "Bottom" }
  for (;;) {
    const page = await session.call((client) =>
      client("ReadPath", { chatId: session.id, forkId: view.forkId, leafSlotId: view.leafSlotId, range, limit: PAGE })
    )
    if (!page.ok) return page
    all.unshift(...page.value.entries)
    onProgress(all.length)
    if (page.value.older === null) return { ok: true as const, value: all }
    range = { _tag: "Older", from: page.value.older }
  }
}

const download = (text: string, name: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExportChatDialog({ context, onClose }: ChatCommandDialogProps) {
  const { session, view } = context
  const [format, setFormat] = useState<Format>("jsonl")
  const [read, setRead] = useState<number | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const run = async () => {
    setError(null)
    setRead(0)
    const result = await readAll(session, view, setRead)
    setRead(null)
    if (!result.ok) return setError(result.error)
    const base =
      chatDisplayName(view)
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim() || "chat"
    download(
      exportText(view, result.value, format),
      `${base}.${format}`,
      format === "txt" ? "text/plain" : "application/jsonl"
    )
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && read === null && onClose()}
      title="Export this chat"
      description="The branch shown, from its first message to its last, with the version each message shows."
    >
      <Segmented
        label="Format"
        value={format}
        onValueChange={setFormat}
        options={[
          {
            value: "jsonl",
            label: "SillyTavern (.jsonl)",
            description: "A chat file that SillyTavern, and this app's import, can open."
          },
          { value: "txt", label: "Plain text (.txt)", description: "Easy to read: each message as “Name: text”." }
        ]}
      />
      <ErrorAlert error={error} />
      {read !== null && (
        <p role="status" className="text-sm text-muted">
          Read {read.toLocaleString()} messages…
        </p>
      )}
      <DialogActions>
        <Button onClick={onClose} disabled={read !== null}>
          Cancel
        </Button>
        <Button variant="primary" pending={read !== null} onClick={() => void run()}>
          Export
        </Button>
      </DialogActions>
    </Dialog>
  )
}
