import { libraryListAtom } from "../library/queries.ts"
// A chat's notes (DESIGN §4.1): its own, made here, then each cast card's (the cards the user
// plays included: a persona note is a card's note), as blocks (`NoteList`): each with its switch,
// turned on or off from the latest message on, on this branch (§3.4). What's typed is used as it's
// typed, a revision is cut by Save or by a reply that uses it (§6.2); a chat's own note is tied
// to its branch, and a card's note is the card's, in every chat.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { SharedNote } from "@rp/shared/editorApi.ts"
import type { SummaryFill } from "@rp/shared/inspectorApi.ts"
import type { Placement } from "@rp/shared/docs/note.ts"
import { AsyncResult } from "effect/reactivity"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { AsyncView, ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { useCaller } from "../editor/caller.ts"
import { NoteBlock, NoteList, type NoteListEntry, NoteListControls, useNoteBlocks } from "../editor/NoteList.tsx"
import type { WorkspaceViewProps } from "../editor/workspaceViews.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Alert } from "../../ui/Surface.tsx"
import { Button } from "../../ui/Button.tsx"
import { type NoteCard, NoteSectionHeader, SharedNotePicker } from "../editor/notes.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { useCast } from "./cast.ts"
import { chatNoteActions } from "./presentation.tsx"
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
  return lines.length ? <p className="px-2 pb-1 pl-12 text-xs text-muted">{lines.join(" ")}</p> : null
}

const titleOf = (note: ChatNote) => (note.doc["title"] as string | undefined) || note.ref.label

const cardRefs = libraryListAtom("card")

/** Where a note is added: the chat's own, or a card's (by its library entry). */
type Group = { readonly card: null } | { readonly card: EntityId; readonly name: string }

/**
 * A chat's notes at the latest message of the branch shown, and what each list of them needs:
 * the Notes tab's and the large editor's (owner, 2026-11-02), so both show the same note alike.
 */
function useChatNotes(session: ChatSession, leafSlotId: SlotId | null) {
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
  const listed = useAtomValue(atom)
  const deleted = useDeletedToast()
  const cast = useCast()
  const [error, setError] = useState<AppError | null>(null)
  // A relink changes what a note is: its editor starts again from the saved note.
  const [generations, setGenerations] = useState<ReadonlyMap<string, number>>(new Map())
  const summaryFill = view.history?.presetContext?.summary
  const summarizing = view.lcm?.enabled === true
  const position = { chatId, forkId: view.forkId, slotId: leafSlotId }
  const toggle = async (note: ChatNote, active: boolean) => {
    const outcome = await session.changeCast({ _tag: "Note", entityId: note.ref.entityId, active })
    setError(outcome.ok ? null : outcome.error)
    refresh()
  }
  const onDeleted = (item: BinItem) => {
    deleted(item)
    refresh()
  }
  const relinked = (refId: string) => {
    setGenerations(new Map(generations).set(refId, (generations.get(refId) ?? 0) + 1))
    refresh()
  }
  /** Every cast card, with notes or not, then any other card a note belongs to. */
  const cardsOf = (notes: ReadonlyArray<ChatNote>): ReadonlyArray<NoteCard> =>
    (
      [
        ...new Set([
          ...(cast.cast?.participants ?? []),
          ...(cast.cast?.playedByMe ?? []),
          ...notes.flatMap((n) => (n.card === null ? [] : [n.card]))
        ])
      ] as Array<EntityId>
    ).map((entity) => ({ entity, name: cast.cards.get(entity)?.name ?? "A card" }))
  const entries = (list: ReadonlyArray<ChatNote>, own: boolean): ReadonlyArray<NoteListEntry> =>
    list.map((note) => ({
      ref: note.ref,
      doc: note.doc,
      sharedBinned: note.linked?.binned === true,
      generation: generations.get(note.ref.id) ?? 0,
      // Its explanation is a tooltip, never inline under it: the header has no room for that.
      control: (
        <Tooltip
          label={
            note.active ? "On: sent with the chat. Switch it off to stop." : "Off: not sent. Switch it on to send it."
          }
        >
          <span className="inline-flex">
            <Switch labelHidden checked={note.active} onCheckedChange={(active) => void toggle(note, active)}>
              <span className="sr-only">{titleOf(note)}: on in this chat</span>
            </Switch>
          </span>
        </Tooltip>
      ),
      detail:
        note.doc["kind"] === "imported_summary" && (summaryFill || summarizing) ? (
          <SummaryMacroLine note={note} summary={summaryFill} summarizing={summarizing} />
        ) : null,
      extra: <SlotOutlet slot={chatNoteActions} props={{ note, session, onChanged: refresh }} />,
      // A chat's own note is edited on its branch; a card's note is the card's, deleted from the card.
      ...(own ? { chatNote: position, onDeleted } : {})
    }))
  return { view, atom, listed, refresh, error, setError, position, cardsOf, entries, relinked }
}

/**
 * The side panel's Notes tab: the chat's notes at the latest message of the branch shown,
 * grouped by owner, to turn on and off, add (new or a shared note), edit and delete.
 * `focusCard` scrolls to a card's group.
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
  const { view, atom, listed, refresh, error, setError, position, cardsOf, entries, relinked } = useChatNotes(
    session,
    leafSlotId
  )
  const refs = useAtomValue(cardRefs)
  const call = useCaller()
  const [picking, setPicking] = useState<Group | null>(null)
  // The note just added: it scrolls into view and flashes once it shows (owner, 2026-11-02).
  const [added, setAdded] = useState<string | null>(null)
  const revealed = useCallback(() => setAdded(null), [])
  const sections = useRef(new Map<string, HTMLElement>())
  const count = AsyncResult.isSuccess(listed) ? listed.value.length : 0
  const { blocks, settings } = useNoteBlocks(count)
  useEffect(() => {
    if (focusCard !== null) sections.current.get(focusCard)?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [focusCard])

  const cardRef = (card: EntityId) =>
    AsyncResult.isSuccess(refs)
      ? refs.value.find((ref) => ref.entityId === card && ref.refKind === "upstream")?.id
      : undefined
  // A note made here is for here: it's on from the latest message (DESIGN §4.1), and open.
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
      ? await call(
          (client) => client("CreateCardNote", { cardRefId: refId, title: "Note", chatNote: position, ...link }),
          ["library"]
        )
      : await call(
          (client) => client("CreateChatNote", { chatId, forkId: view.forkId, title: "Note", ...link }),
          ["library"]
        )
    if (!made.ok) return setError(made.error)
    const on = await session.changeCast({ _tag: "Note", entityId: made.value.entityId, active: true })
    setError(on.ok ? null : on.error)
    blocks.setOpen(made.value.id, true)
    if (!shared) settings.setOpen(made.value.id, true)
    setAdded(made.value.id)
    refresh()
  }
  return (
    <div className="flex flex-col gap-3">
      <AsyncView atom={atom} loading="Loading the notes…">
        {(notes) => {
          // Every cast card has a group, with notes or not, then any other card a note belongs to.
          const named = cardsOf(notes)
          const own = notes.filter((n) => n.card === null)
          return (
            <>
              {/* At the right at every width, with the page-level controls (owner, 2026-11-02). */}
              <NoteListControls ids={notes.map((n) => n.ref.id)} blocks={blocks} />
              {/* The chat's and each card's notes side by side as the panel widens (26rem each at least). */}
              <div className="grid gap-5 @4xl:grid-cols-[repeat(auto-fill,minmax(26rem,1fr))] @4xl:gap-x-8">
                <section aria-label="This chat's notes" className="flex min-w-0 flex-col gap-1.5">
                  <NoteSectionHeader
                    title="This chat"
                    addHint="Adds a new note to this chat."
                    onNew={() => void add({ card: null })}
                    onPick={() => setPicking({ card: null })}
                  />
                  {own.length === 0 ? (
                    <p className="text-sm text-muted">
                      No notes yet. A note here is text the model is sent with this chat.
                    </p>
                  ) : (
                    <NoteList
                      label="Notes"
                      entries={entries(own, true)}
                      cards={named}
                      call={call}
                      blocks={blocks}
                      settings={settings}
                      onRelinked={(entry) => relinked(entry.ref.id)}
                      added={added}
                      onRevealed={revealed}
                    />
                  )}
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
                      className="flex min-w-0 scroll-mt-2 flex-col gap-1.5"
                    >
                      <NoteSectionHeader
                        title={name}
                        addHint={`Adds a new note to ${name}.`}
                        onNew={() => void add(group)}
                        onPick={() => setPicking(group)}
                      />
                      {theirs.length === 0 ? (
                        <p className="text-sm text-muted">No notes yet.</p>
                      ) : (
                        <NoteList
                          label="Notes"
                          entries={entries(theirs, false)}
                          cards={named}
                          call={call}
                          blocks={blocks}
                          settings={settings}
                          onRelinked={(entry) => relinked(entry.ref.id)}
                          added={added}
                          onRevealed={revealed}
                        />
                      )}
                    </section>
                  )
                })}
              </div>
            </>
          )
        }}
      </AsyncView>
      <ErrorAlert error={error} />
      <SharedNotePicker
        chatNote={position}
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

/**
 * A note in the large editor over the chat (owner, 2026-11-02): the Notes tab's block, always
 * open, filling the column, on the same store, so both show the same text, marker and Save. It
 * stays while the side panel changes tab or character; the chat's notes are read as the tab reads them.
 */
export function ChatNoteLarge({ refId, onClose, session, view }: WorkspaceViewProps) {
  if (!session || !view) return null
  return <ChatNoteLargeIn refId={refId} onClose={onClose} session={session} leafSlotId={view.leafSlotId} />
}

function ChatNoteLargeIn({
  refId,
  onClose,
  session,
  leafSlotId
}: {
  refId: RefId
  onClose: (() => void) | undefined
  session: ChatSession
  leafSlotId: SlotId | null
}) {
  const { atom, error, cardsOf, entries, relinked } = useChatNotes(session, leafSlotId)
  const call = useCaller()
  const { settings } = useNoteBlocks(1)
  const close = () => onClose?.()
  return (
    <div className="flex flex-col gap-3">
      <AsyncView atom={atom} loading="Loading the note…">
        {(notes) => {
          const note = notes.find((n) => n.ref.id === refId)
          if (!note)
            return (
              <Alert tone="warning" actions={<Button onClick={close}>Back to the chat</Button>}>
                <p>This note isn't in this chat any more.</p>
              </Alert>
            )
          const entry = entries([note], note.card === null)[0]!
          const removed = entry.onDeleted
          return (
            <ul aria-label="Note" className="flex flex-col">
              <NoteBlock
                key={`${refId}:${entry.chatNote?.forkId ?? ""}:${entry.chatNote?.slotId ?? ""}:${entry.generation ?? 0}`}
                entry={{
                  ...entry,
                  // Deleted here, it goes back to the chat.
                  ...(removed
                    ? {
                        onDeleted: (item: BinItem) => {
                          removed(item)
                          close()
                        }
                      }
                    : {})
                }}
                cards={cardsOf(notes)}
                call={call}
                open
                onOpenChange={() => {}}
                settingsOpen={settings.isOpen(refId)}
                onSettingsOpenChange={(open) => settings.setOpen(refId, open)}
                onRelinked={() => relinked(refId)}
                large={{ onClose: close }}
              />
            </ul>
          )
        }}
      </AsyncView>
      <ErrorAlert error={error} />
    </div>
  )
}
