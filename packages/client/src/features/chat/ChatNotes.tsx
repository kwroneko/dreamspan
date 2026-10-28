// A chat's notes (DESIGN §4.1): its own, made here, then each cast card's (the cards the user
// plays included: a persona note is a card's note), each collapsed to a row with its switch,
// turned on or off at the leaf shown, so from there on, on this branch (§3.4). Every note
// edits through its drafts and saves as a revision, like any library entry (ARCHITECTURE
// §14); a card's note is the card's, in every chat.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { ChatNotePosition, SharedNote } from "@rp/shared/editorApi.ts"
import type { SummaryFill } from "@rp/shared/inspectorApi.ts"
import type { Placement } from "@rp/shared/docs/note.ts"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { AsyncView, ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { useCaller } from "../editor/caller.ts"
import { AddNoteMenu, type NoteCard, NoteEditor, NoteRow, SharedNotePicker } from "../editor/notes.tsx"
import { useCast } from "./cast.ts"
import type { ChatSession } from "./session.ts"

/**
 * How a summary note, the preset's `{{summary}}` and the chat's summaries meet (DESIGN §8):
 * `{{summary}}` sends the note's text, and the summaries go as their own blocks beside it.
 */
function SummaryMacroLine({
  note,
  summary,
  summarizing
}: {
  note: ChatNote
  summary: SummaryFill | undefined
  summarizing: boolean
}) {
  const placement = (note.doc["placement"] as Placement).mode
  const macro = (summary?.prompts.length ?? 0) > 0
  const lines = [
    macro
      ? note.active
        ? "Your preset includes this through {{summary}}."
        : "Your preset has {{summary}}; it sends nothing while this is off."
      : summary && note.active && placement === "none"
        ? "Not placed, and your preset has no {{summary}}: nothing sends it."
        : null,
    summarizing && note.active && (macro || placement !== "none") ? "Also sent beside the summaries." : null
  ].filter((line) => line !== null)
  return lines.length ? <p className="pl-12 text-sm text-muted">{lines.join(" ")}</p> : null
}

const titleOf = (note: ChatNote) => (note.doc["title"] as string | undefined) || note.ref.label

const cardRefs = AppClient.query("ListLibrary", { kind: "card" }, { reactivityKeys: ["library"] })

/** Where a note is added: the chat's own, or a card's (by its library entry). */
type Group = { readonly card: null } | { readonly card: EntityId; readonly name: string }

function ChatNoteRow({
  note,
  cards,
  card,
  open,
  position,
  onOpenChange,
  onToggle,
  onDeleted,
  onRelinked,
  summary,
  summarizing
}: {
  note: ChatNote
  cards: ReadonlyArray<NoteCard>
  /** What `{{summary}}` fills in for the next reply, for a summary note's line about it. */
  summary: SummaryFill | undefined
  /** Whether the chat summarizes: a summary note that's on is then sent beside the summaries. */
  summarizing: boolean
  /** The card's name, for a card's note. */
  card: string | null
  open: boolean
  position: ChatNotePosition
  onOpenChange: (open: boolean) => void
  onToggle: (active: boolean) => void
  onDeleted: (item: BinItem) => void
  onRelinked: () => void
}) {
  const call = useCaller()
  const title = titleOf(note)
  // A relink changes what the note is: its editor starts again from the saved note.
  const [generation, setGeneration] = useState(0)
  return (
    <NoteRow
      doc={note.doc}
      label={note.ref.label}
      cards={cards}
      open={open}
      onOpenChange={onOpenChange}
      shared={note.linked}
      authorNote={note.authorNote}
      detail={
        note.doc["kind"] === "imported_summary" && (summary || summarizing) ? (
          <SummaryMacroLine note={note} summary={summary} summarizing={summarizing} />
        ) : null
      }
      control={
        <Switch checked={note.active} onCheckedChange={onToggle}>
          <span className="sr-only">{title}: on in this chat</span>
        </Switch>
      }
    >
      <NoteEditor
        key={`${card === null ? (position.slotId ?? "start") : note.ref.id}:${generation}`}
        noteRef={note.ref}
        call={call}
        cards={cards}
        onRelinked={() => {
          setGeneration(generation + 1)
          onRelinked()
        }}
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
              // A card's note is the card's: it's deleted from the card, not from a chat.
              notice: (
                <Alert title={`${card}'s note`}>
                  <p>It belongs to the card: saving it changes it in the library, in every chat with {card}.</p>
                </Alert>
              )
            })}
      />
    </NoteRow>
  )
}

/**
 * The side panel's Notes tab: the chat's notes at the leaf shown, grouped by owner, to turn on
 * and off, add (new or a shared note), edit and delete. `focusCard` scrolls to a card's group.
 */
export function NotesTab({
  session,
  leafSlotId,
  focusCard = null
}: {
  session: ChatSession
  leafSlotId: SlotId | null
  focusCard?: EntityId | null
}) {
  const chatId = session.id
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  // Library changes (a save, a delete, an undo from the bin) read the list again.
  const atom = useMemo(
    () =>
      AppClient.query(
        "ListChatNotes",
        { chatId, forkId: view.forkId, slotId: leafSlotId },
        { reactivityKeys: ["library", `chat-notes:${chatId}`] }
      ),
    [chatId, view.forkId, leafSlotId]
  )
  const refresh = useAtomRefresh(atom)
  const refs = useAtomValue(cardRefs)
  const call = useCaller()
  const deleted = useDeletedToast()
  const cast = useCast()
  const [open, setOpen] = useState<string | null>(null)
  const [picking, setPicking] = useState<Group | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const summaryFill = view.history?.presetContext?.summary
  const summarizing = view.lcm?.enabled === true
  const sections = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    if (focusCard !== null) sections.current.get(focusCard)?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [focusCard])

  const toggle = async (note: ChatNote, active: boolean) => {
    const outcome = await session.changeCast({ _tag: "Note", entityId: note.ref.entityId, active })
    setError(outcome.ok ? null : outcome.error)
    refresh()
  }
  const cardRef = (card: EntityId) =>
    AsyncResult.isSuccess(refs)
      ? refs.value.find((ref) => ref.entityId === card && ref.refKind === "upstream")?.id
      : undefined
  // A note made here is for here: it's on from the leaf shown (DESIGN §4.1).
  const add = async (group: Group, shared?: SharedNote) => {
    const link = shared ? { link: shared.ref.entityId } : {}
    const refId = group.card === null ? null : cardRef(group.card)
    if (group.card !== null && refId === undefined)
      return setError({
        tag: "NotFound",
        message: `${group.name}'s card isn't in the library.`,
        problems: [],
        reason: null
      })
    const made = refId
      ? await call((client) => client("CreateCardNote", { cardRefId: refId, title: "Note", ...link }), ["library"])
      : await call((client) => client("CreateChatNote", { chatId, title: "Note", ...link }), ["library"])
    if (!made.ok) return setError(made.error)
    const on = await session.changeCast({ _tag: "Note", entityId: made.value.entityId, active: true })
    setError(on.ok ? null : on.error)
    setOpen(made.value.id)
    refresh()
  }
  const onDeleted = (item: BinItem) => {
    deleted(item)
    setOpen(null)
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Notes are sent with the chat where each says. Switching one on or off applies from the latest message on, on
        this branch.
      </p>
      <AsyncView atom={atom} loading="Loading the notes…">
        {(notes) => {
          // Every cast card has a group, with notes or not, then any other card a note belongs to.
          const owners = [
            ...new Set([...cast.cards.keys(), ...notes.flatMap((n) => (n.card === null ? [] : [n.card]))])
          ] as Array<EntityId>
          const named: ReadonlyArray<NoteCard> = owners.map((entity) => ({
            entity,
            name: cast.cards.get(entity)?.name ?? "A card"
          }))
          const rows = (list: ReadonlyArray<ChatNote>, card: string | null) => (
            <ul aria-label="Notes" className="flex flex-col">
              {list.map((note) => (
                <ChatNoteRow
                  key={note.ref.id}
                  note={note}
                  cards={named}
                  card={card}
                  open={open === note.ref.id}
                  position={{ chatId, slotId: leafSlotId }}
                  onOpenChange={(next) => setOpen(next ? note.ref.id : null)}
                  onToggle={(active) => void toggle(note, active)}
                  onDeleted={onDeleted}
                  onRelinked={refresh}
                  summary={summaryFill}
                  summarizing={summarizing}
                />
              ))}
            </ul>
          )
          const own = notes.filter((n) => n.card === null)
          return (
            <div className="flex flex-col gap-5">
              <section aria-label="This chat's notes" className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">This chat</h3>
                {own.length === 0 ? (
                  <p className="text-sm text-muted">No notes yet. A note here is like ST's author's note.</p>
                ) : (
                  rows(own, null)
                )}
                <div className="pt-1">
                  <AddNoteMenu onNew={() => void add({ card: null })} onPick={() => setPicking({ card: null })} />
                </div>
              </section>
              {named.map(({ entity, name }) => {
                const theirs = notes.filter((n) => n.card === entity)
                const group: Group = { card: entity as EntityId, name }
                return (
                  <section
                    key={entity}
                    ref={(element) => {
                      if (element) sections.current.set(entity, element)
                      else sections.current.delete(entity)
                    }}
                    aria-label={`${name}'s notes`}
                    className="flex scroll-mt-2 flex-col gap-1"
                  >
                    <h3 className="text-sm font-semibold">{name}</h3>
                    {theirs.length === 0 ? <p className="text-sm text-muted">No notes yet.</p> : rows(theirs, name)}
                    <div className="pt-1">
                      <AddNoteMenu onNew={() => void add(group)} onPick={() => setPicking(group)} />
                    </div>
                  </section>
                )
              })}
            </div>
          )
        }}
      </AsyncView>
      <ErrorAlert error={error} />
      <SharedNotePicker
        open={picking !== null}
        onOpenChange={(next) => !next && setPicking(null)}
        call={call}
        onPick={(note) => {
          const group = picking
          setPicking(null)
          if (group) void add(group, note)
        }}
      />
    </div>
  )
}
