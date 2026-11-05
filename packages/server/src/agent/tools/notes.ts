// The note tools (spec/AGENTIC.md §4.5): what notes the chat has at the position, and switching
// one on or off from the next message on. Switching is a change the user allows (DESIGN §4.1a
// [D]): only a note marked agent-editable, until per-chat permissions exist. Writing and
// editing notes wait for the note-overrides work, which owns how notes replace text.
import { Type } from "@earendil-works/pi-ai"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RevisionId } from "@rp/shared/library.ts"
import { foldState, noteSwitches } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { RolloutTool, ToolContext } from "../tools.ts"
import { safely } from "./history.ts"

interface NoteView {
  readonly entity: EntityId
  readonly title: string
  readonly owner: string
  readonly active: boolean
  readonly editable: boolean
  readonly content: string
}

/** The notes the assembler reads at the position, as the chat's notes list shows them. */
const notesAt = (context: ToolContext) =>
  Effect.gen(function* () {
    const { userId, chatId, forkId, leafSlotId: slotId, reader } = context
    const events = yield* reader.StateEventsAt({ userId, chatId, slotId, forkId })
    const state = foldState(events)
    const cards = [...state.participants, ...state.playedByMe.filter((e) => !state.participants.includes(e))]
    const switches = noteSwitches(events)
    const entries = yield* reader.ChatNoteEntries({
      userId,
      chatId,
      forkId,
      slotId,
      cards: cards as Array<EntityId>
    })
    const names = cards.length
      ? new Map(
          (yield* reader.CastCards({ userId, entityIds: cards as Array<EntityId> })).map((c) => [
            c.entityId as string,
            c.modelName ?? c.name
          ])
        )
      : new Map<string, string>()
    return yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const revisionId = state.noteRevisions[entry.ref.entityId] as RevisionId | undefined
        const doc =
          entry.card !== null && revisionId
            ? yield* reader.GetRevisionDoc({ userId, refId: entry.ref.id, revisionId })
            : entry.doc
        const onByDefault = entry.card !== null && doc["on_by_default"] === true
        return {
          entity: entry.ref.entityId,
          title: String(doc["title"] ?? entry.ref.label),
          owner: entry.card === null ? "the chat" : (names.get(entry.card) ?? "a character"),
          active: switches.get(entry.ref.entityId) ?? onByDefault,
          editable: doc["agent_editable"] === true,
          content: String(entry.linked ? entry.doc["content"] : (doc["content"] ?? ""))
        } satisfies NoteView
      })
    )
  })

export const listNotes: RolloutTool<Record<string, never>> = {
  id: "list_notes",
  label: "Looked at the notes",
  explanation: "List this chat's notes",
  effect: "read",
  description:
    "Lists the chat's notes and its characters' notes: title, whose it is, whether it's on, and whether you may change it. On notes are already in your context.",
  parameters: Type.Object({}),
  execute: (context) =>
    safely(
      "list_notes",
      Effect.gen(function* () {
        const notes = yield* notesAt(context)
        if (notes.length === 0) return { text: "The chat has no notes." }
        return {
          text: notes
            .map(
              (n) =>
                `“${n.title}” (${n.owner}'s; ${n.active ? "on" : "off"}${n.editable ? "; you may change it" : ""})${
                  n.active ? "" : `: ${n.content.replace(/\s+/g, " ").slice(0, 200)}`
                }`
            )
            .join("\n")
        }
      })
    )
}

export const switchNote: RolloutTool<{ readonly note: string; readonly on: boolean }> = {
  id: "switch_note",
  label: "Switched a note",
  explanation: "Switch the notes you let it change",
  effect: "chat_state",
  description:
    "Turns one of the notes on or off from the next message on, by its title (list_notes gives them). Only notes you may change.",
  parameters: Type.Object({
    note: Type.String({ description: "The note's title." }),
    on: Type.Boolean({ description: "True to turn it on." })
  }),
  summarize: ({ note, on }) => `“${note}”: ${on ? "on" : "off"}`,
  execute: (context, { note, on }) =>
    safely(
      "switch_note",
      Effect.gen(function* () {
        const wanted = note.trim().toLowerCase()
        const found = (yield* notesAt(context)).filter((n) => n.title.trim().toLowerCase() === wanted)
        if (found.length !== 1)
          return {
            text: found.length ? `Several notes are called “${note}”.` : `No note is called “${note}”.`,
            isError: true
          }
        const target = found[0]!
        if (!target.editable) return { text: `You may not change “${target.title}”.`, isError: true }
        const { result } = yield* context.writer.ApplyRolloutEffect({
          userId: context.userId,
          rolloutId: context.rolloutId,
          toolCallId: context.toolCallId,
          events: [{ key: on ? "note.activate" : "note.deactivate", value: { note: target.entity } }],
          result: `“${target.title}” is ${on ? "on" : "off"} from the next message on.`
        })
        return { text: result }
      })
    )
}
