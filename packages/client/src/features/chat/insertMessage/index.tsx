// Inserting messages anywhere in the history (spec/MESSAGE-INSERT.md §4; owner decision DESIGN
// §3.1, 2026-10-30): the message actions Insert message below, Insert message above (on the
// first message shown) and Duplicate, and the insertion editor, which fills the message stream's
// slot after its anchor. Every part is a registration, so a plugin can replace or disable it.
import type { PathEntry } from "@rp/shared/chat.ts"
import { lazy, Suspense, useSyncExternalStore } from "react"
import { MenuItem } from "../../../ui/Menu.tsx"
import { messageActions, type MessageActionContext } from "../messageActions.tsx"
import { editorKey } from "../messageDraft.ts"
import { messageStream } from "../presentation.tsx"
import type { ChatSession } from "../session.ts"
import { registerInsertEstimates } from "./estimates.ts"
import { insertedToast } from "./toast.ts"
import { insertTarget, openEditors, useOpenEditor } from "./openEditors.ts"
import { registerInsertSpeakerDefault } from "./speakerDefault.ts"

// The editor loads with the first one opened, like the chat view itself.
const InsertEditor = lazy(() => import("./InsertEditor.tsx").then((module) => ({ default: module.InsertEditor })))

/** Opens the editor below `anchor` (null: above the first message), with its draft's text if it has one. */
const openInsertEditor = (session: ChatSession, anchor: PathEntry | null) => {
  const target = insertTarget(session, anchor?.slotId ?? null)
  if (target === null) return
  session.openEditor(target, "")
  openEditors(session).show(target)
}

/** Whether the message is the first the fork shows: the only one with Insert message above. */
const isFirst = ({ session, entry }: MessageActionContext) => {
  const view = session.snapshot()
  return view.older === null && view.entries[0]?.slotId === entry.slotId
}

/** Why a version can't be duplicated, or null when it can. */
export const duplicateRefusal = ({ entry, generating }: MessageActionContext) =>
  generating || entry.version.status === "generating"
    ? "It's still being written. Duplicate it once it's finished."
    : entry.version.status === "failed"
      ? "A failed version has nothing to duplicate."
      : null

function Duplicate(context: MessageActionContext) {
  const { session, entry, report } = context
  const refusal = duplicateRefusal(context)
  return (
    <MenuItem
      icon="duplicate"
      disabled={refusal !== null}
      onClick={async () => {
        const forkId = session.snapshot().forkId
        const outcome = await session.insertMessage(entry, { _tag: "Duplicate", versionId: entry.version.id })
        report(outcome)
        if (outcome.ok) insertedToast(session, outcome.value.entry.slotId, "Message duplicated", forkId)
      }}
    >
      Duplicate
      {refusal !== null && <span className="block text-xs text-muted">{refusal}</span>}
    </MenuItem>
  )
}

/** The editor in the stream, after its anchor (or before the first message), when it's open. */
function StreamEditor({ entry, session, place }: { entry: PathEntry; session: ChatSession; place: "above" | "below" }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const anchor = place === "below" ? entry : null
  const target = insertTarget(session, anchor?.slotId ?? null)
  // Opened with its action (openInsertEditor), or read with the chat's drafts.
  const editor = useOpenEditor(session, target)
  if (place === "above" && (view.older !== null || view.entries[0]?.slotId !== entry.slotId)) return null
  if (target === null || editor === null) return null
  return (
    <Suspense fallback={<p className="mx-3 my-2 text-sm text-muted">Opening the editor…</p>}>
      <InsertEditor key={editorKey(target)} session={session} anchor={anchor} target={target} editor={editor} />
    </Suspense>
  )
}

/** Under an inserted message the model is still writing: what the next reply sees (spec §5). */
function GeneratingNote({ entry, place }: { entry: PathEntry; place: "above" | "below" }) {
  if (place !== "below" || entry.inserted !== true || entry.version.status !== "generating") return null
  return (
    <p role="note" className="mx-3 mt-1 text-xs text-muted">
      The next reply won't include this message until it's finished.
    </p>
  )
}

export const register = () => [
  messageActions.register({
    id: "message.insert-above",
    order: 27,
    available: isFirst,
    menu: ({ session }) => (
      <MenuItem icon="insert" onClick={() => openInsertEditor(session, null)}>
        Insert message above
      </MenuItem>
    )
  }),
  messageActions.register({
    id: "message.insert-below",
    order: 28,
    run: ({ session, entry }) => openInsertEditor(session, entry),
    menu: ({ session, entry }) => (
      <MenuItem icon="insert" onClick={() => openInsertEditor(session, entry)}>
        Insert message below
      </MenuItem>
    )
  }),
  messageActions.register({ id: "message.duplicate", order: 29, menu: Duplicate }),
  messageStream.register({
    id: "insert.editor",
    order: 10,
    component: ({ entry, session, place }) => <StreamEditor entry={entry} session={session} place={place} />
  }),
  messageStream.register({ id: "insert.generating-note", order: 20, component: GeneratingNote }),
  ...registerInsertEstimates(),
  ...registerInsertSpeakerDefault()
]
