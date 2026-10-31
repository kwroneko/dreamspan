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
import { castCharacters, chatDisplayName } from "./chatTitle.ts"
import type { ChatSession, ChatView } from "./session.ts"

type Format = "txt" | "jsonl"
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

/** The file's text: who said what, as the chat shows it. */
export const exportText = (view: ChatView, entries: ReadonlyArray<PathEntry>, format: Format) => {
  const cards = view.cast?.cards ?? []
  const mine = new Set<string>(view.cast?.playedByMe ?? [])
  const persona = cards.find((c) => mine.has(c.entityId))?.name ?? "You"
  const speakerOf = (entry: PathEntry) => {
    const id = entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
    const card = cards.find((c) => c.entityId === id)
    const user = id !== null && id !== undefined ? mine.has(id) : entry.version.writer === "human"
    return { name: card?.name ?? (user ? persona : "Model"), user }
  }
  if (format === "txt")
    return entries
      .map((entry) => `${speakerOf(entry).name}: ${entry.version.content}`)
      .join("\n\n")
      .concat("\n")
  const header = {
    user_name: persona,
    character_name: castCharacters(view)[0]?.name ?? chatDisplayName(view),
    create_date: new Date(view.chat?.createdAt ?? Date.now()).toISOString(),
    chat_metadata: {}
  }
  const lines = entries.map((entry) => {
    const { name, user } = speakerOf(entry)
    return {
      name,
      is_user: user,
      is_system: false,
      send_date: new Date(entry.version.createdAt).toISOString(),
      mes: entry.version.content,
      extra: {}
    }
  })
  return [header, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n"
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
          { value: "jsonl", label: "SillyTavern (.jsonl)" },
          { value: "txt", label: "Plain text (.txt)" }
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
