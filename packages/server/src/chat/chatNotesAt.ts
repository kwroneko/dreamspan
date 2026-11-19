// The notes the context assembler reads at a position: the chat's own and its characters'.
// One read for the Notes panel (`ListChatNotes`) and for the workshop tools that name a note there.
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { ChatNote } from "@dreamspan/shared/chatSetupApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { RevisionId } from "@dreamspan/shared/library.ts"
import { foldState, noteSwitches } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import type { Reader } from "../db/Database.ts"

export const chatNotesAt = (
  reader: Reader["Service"],
  id: UserId,
  at: { readonly chatId: ChatId; readonly slotId: SlotId | null; readonly forkId?: ForkId | null | undefined }
) =>
  Effect.gen(function* () {
    const { chatId, slotId, forkId } = at
    const events = yield* reader.StateEventsAt({
      userId: id,
      chatId,
      slotId,
      forkId: forkId ?? null,
      displayEnd: true
    })
    const state = foldState(events)
    // Every card of the cast, the ones the user plays included: a persona note is a card's note.
    const cards = [...state.participants, ...state.playedByMe.filter((e) => !state.participants.includes(e))]
    const switches = noteSwitches(events)
    const entries = yield* reader.ChatNoteEntries({
      userId: id,
      chatId,
      forkId: forkId ?? null,
      slotId,
      cards: cards as Array<EntityId>
    })
    const notes = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const revisionId = state.noteRevisions[entry.ref.entityId] as RevisionId | undefined
        const pinned =
          entry.card !== null && revisionId
            ? yield* reader.GetRevisionDoc({ userId: id, refId: entry.ref.id, revisionId })
            : null
        const resolved = pinned
          ? {
              ref: { ...entry.ref, headRevisionId: revisionId! },
              // A linked slot keeps showing its shared note's text.
              doc: entry.linked ? { ...pinned, content: entry.doc["content"] } : pinned
            }
          : entry
        const onByDefault = entry.card !== null && resolved.doc["on_by_default"] === true
        return new ChatNote({
          ...entry,
          ...resolved,
          onByDefault,
          active: switches.get(entry.ref.entityId) ?? onByDefault
        })
      })
    )
    const grouped = noteSwitches(
      events,
      notes.map((note) => ({ entity: note.ref.entityId, doc: note.doc }))
    )
    return notes.map((note) => new ChatNote({ ...note, active: grouped.get(note.ref.entityId) ?? note.active }))
  })
