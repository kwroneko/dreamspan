// A chat's notes (DESIGN §4.1): its own, made here, and its characters', each turned on or
// off at the leaf shown, so from there on, on this branch (§3.4). Every note edits through
// its drafts and saves as a revision, like any library entry (ARCHITECTURE §14); a card's
// note is the card's, in every chat.
import { useAtomRefresh } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { Placement } from "@rp/shared/docs/note.ts"
import { useMemo, useState } from "react"
import { AsyncView, ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Alert, Badge } from "../../ui/Surface.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { useCaller } from "../editor/caller.ts"
import { NoteEditor } from "../editor/notes.tsx"
import { useCast } from "./cast.ts"
import type { ChatSession } from "./session.ts"

const placed = (placement: Placement) => {
  switch (placement.mode) {
    case "depth":
      return `In the chat at depth ${placement.depth}, as ${placement.role}`
    case "tail":
      return `At the end of the chat, as ${placement.role}`
    case "section":
      return (
        (placement.section === "before_main_prompt"
          ? "Before the main prompt"
          : placement.section === "after_main_prompt"
            ? "After the main prompt"
            : "Not sent: nothing places notes there yet") + (placement.role ? `, as ${placement.role}` : "")
      )
    case "none":
      return "Not placed: only a macro reads it"
  }
}

const whereOf = (note: ChatNote) => {
  const placement = note.doc["placement"] as Placement
  const interval = note.doc["interval"] as number | undefined
  const every =
    interval === undefined || interval === 1
      ? ""
      : interval === 0
        ? ", never sent"
        : `, every ${interval} of your messages`
  return `${placed(placement)}${every}`
}

const titleOf = (note: ChatNote) => (note.doc["title"] as string | undefined) || note.ref.label

function NoteRow({
  note,
  card,
  editing,
  onToggle,
  onEdit,
  onDeleted,
  position
}: {
  note: ChatNote
  /** The card's name, for a card's note. */
  card: string | null
  editing: boolean
  onToggle: (active: boolean) => void
  onEdit: () => void
  onDeleted: (item: BinItem) => void
  position: ChatNotePosition
}) {
  const call = useCaller()
  const title = titleOf(note)
  const kind = note.doc["kind"]
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Switch checked={note.active} onCheckedChange={onToggle} description={whereOf(note)}>
            {title}
          </Switch>
        </div>
        {kind === "author_note" && <Badge>author's note</Badge>}
        {kind === "imported_summary" && <Badge>summary</Badge>}
        {note.first && <Badge>Character's Note</Badge>}
        <Button variant="ghost" aria-label={`${editing ? "Close" : "Edit"} ${title}`} onClick={onEdit}>
          {editing ? "Close" : "Edit"}
        </Button>
      </div>
      {editing && (
        <NoteEditor
          key={card === null ? (position.slotId ?? "start") : note.ref.id}
          noteRef={note.ref}
          call={call}
          {...(card === null
            ? {
                onDeleted,
                chatNote: position,
                notice: (
                  <Alert title="From here on, on this branch">
                    <p>Saving applies from the displayed message on, on this branch.</p>
                  </Alert>
                )
              }
            : {
                notice: (
                  <Alert title={`${card}'s note`}>
                    <p>It belongs to the card: saving it changes it in the library, in every chat with {card}.</p>
                  </Alert>
                )
              })}
        />
      )}
    </li>
  )
}

/** The chat's notes at the leaf shown, to turn on and off, make, edit and delete. */
export function NotesDialog({
  session,
  leafSlotId,
  onOpenChange
}: {
  session: ChatSession
  leafSlotId: SlotId | null
  onOpenChange: (open: boolean) => void
}) {
  const chatId = session.id
  // Library changes (a save, a delete, an undo from the bin) read the list again.
  const atom = useMemo(
    () =>
      AppClient.query(
        "ListChatNotes",
        { chatId, slotId: leafSlotId },
        { reactivityKeys: ["library", `chat-notes:${chatId}`] }
      ),
    [chatId, leafSlotId]
  )
  const refresh = useAtomRefresh(atom)
  const call = useCaller()
  const deleted = useDeletedToast()
  const { cards } = useCast()
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  const toggle = async (note: ChatNote, active: boolean) => {
    const outcome = await session.changeCast({ _tag: "Note", entityId: note.ref.entityId, active })
    setError(outcome.ok ? null : outcome.error)
    refresh()
  }
  // A note made here is for here: it's on from the leaf shown.
  const create = async () => {
    const made = await call((client) => client("CreateChatNote", { chatId, title: "Note" }))
    if (!made.ok) return setError(made.error)
    const on = await session.changeCast({ _tag: "Note", entityId: made.value.entityId, active: true })
    setError(on.ok ? null : on.error)
    setEditing(made.value.id)
    refresh()
  }
  const onDeleted = (item: BinItem) => {
    deleted(item)
    setEditing(null)
  }
  const rows = (notes: ReadonlyArray<ChatNote>) => (
    <ul aria-label="Notes" className="flex flex-col divide-y divide-border">
      {notes.map((note) => (
        <NoteRow
          key={note.ref.id}
          note={note}
          position={{ chatId, slotId: leafSlotId }}
          card={note.card === null ? null : (cards.get(note.card)?.name ?? "The card")}
          editing={editing === note.ref.id}
          onToggle={(active) => void toggle(note, active)}
          onEdit={() => setEditing(editing === note.ref.id ? null : note.ref.id)}
          onDeleted={onDeleted}
        />
      ))}
    </ul>
  )
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Notes"
      description="Turning a note on or off applies from the latest message on, on this branch."
    >
      <AsyncView atom={atom} loading="Loading the notes…">
        {(notes) => {
          const own = notes.filter((n) => n.card === null)
          const theirs = [...new Set(notes.flatMap((n) => (n.card === null ? [] : [n.card])))]
          return (
            <div className="flex flex-col gap-4">
              <section aria-label="This chat's notes" className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">This chat's notes</h3>
                {own.length === 0 ? (
                  <p className="text-sm text-muted">None yet. A note here is like ST's author's note.</p>
                ) : (
                  rows(own)
                )}
                <div>
                  <Button onClick={() => void create()}>New note</Button>
                </div>
              </section>
              {theirs.map((card) => {
                const name = cards.get(card)?.name ?? "A card"
                return (
                  <section key={card} aria-label={`${name}'s notes`} className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">{name}'s notes</h3>
                    {rows(notes.filter((n) => n.card === card))}
                  </section>
                )
              })}
            </div>
          )
        }}
      </AsyncView>
      <ErrorAlert error={error} />
      <DialogActions>
        <Button onClick={() => onOpenChange(false)}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}
