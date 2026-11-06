// The note tools (spec/AGENTIC.md §4.5): what notes the chat has at the position; switching one
// on or off, writing a new one and editing one, each from the next message on, attached to the
// reply being written so a swipe takes it back. Changing a note is something the user allows
// (DESIGN §4.1a [D]): a note marked agent-editable, one the agent wrote, or one the chat allows
// (`agent.permission`), never one the chat forbids.
import { Type } from "@earendil-works/pi-ai"
import type { EntityId } from "@rp/shared/chat.ts"
import { NOTE_SCHEMA_VERSION } from "@rp/shared/docs/note.ts"
import type { Doc, RevisionId } from "@rp/shared/library.ts"
import { type ChatState, foldState, noteSwitches, permissionKey } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { RolloutTool, ToolContext } from "../tools.ts"
import { safely } from "./history.ts"

export interface NoteView {
  readonly entity: EntityId
  readonly title: string
  readonly owner: string
  /** The card whose note it is; null for the chat's own. */
  readonly card: EntityId | null
  readonly active: boolean
  readonly editable: boolean
  /** It shows a shared note's text, which only its own editor changes. */
  readonly linked: boolean
  readonly content: string
  /** The note's document and revision as the position shows them: what an edit starts from. */
  readonly doc: Doc
  readonly revision: RevisionId
}

/** Whether the chat lets agent replies change a note: its own override, else the note's flag. */
const noteEditable = (state: ChatState, entity: string, doc: Doc) =>
  state.agentPermissions[permissionKey({ note: entity })!] ?? doc["agent_editable"] === true

/**
 * Where notes are read: where a reply is being written (a tool's context), or the position the
 * chat's settings show (`displayEnd`, as the Notes list reads it).
 */
export type NotesPosition = Pick<ToolContext, "userId" | "chatId" | "forkId" | "reader"> & {
  readonly slotId: ToolContext["slotId"] | null
  readonly displayEnd?: boolean
}

/**
 * The chat's state where the reply is being written: the parent's, with the reply's own effects
 * so far (spec/AGENTIC.md §4.3, mid-rollout reads), which apply while it's shown.
 */
const stateHere = (context: NotesPosition) =>
  Effect.gen(function* () {
    const { userId, chatId, forkId, slotId, reader, displayEnd } = context
    const events = yield* reader.StateEventsAt({
      userId,
      chatId,
      slotId,
      forkId,
      ...(displayEnd ? { displayEnd } : {})
    })
    return { events, state: foldState(events) }
  })

/**
 * The notes the assembler reads at the position, as the chat's notes list shows them: a note an
 * agent reply wrote only where that reply is shown.
 */
export const notesAt = (context: NotesPosition) =>
  Effect.gen(function* () {
    const { userId, chatId, forkId, slotId, reader } = context
    const { events, state } = yield* stateHere(context)
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
    const notes = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const bound = state.noteRevisions[entry.ref.entityId] as RevisionId | undefined
        // A card's note is the revision the chat binds; a chat's note comes resolved at the position.
        const revision = entry.card !== null && bound ? bound : entry.ref.headRevisionId
        const doc =
          entry.card !== null && bound
            ? yield* reader.GetRevisionDoc({ userId, refId: entry.ref.id, revisionId: bound })
            : entry.doc
        const onByDefault = entry.card !== null && doc["on_by_default"] === true
        return {
          entity: entry.ref.entityId,
          title: String(doc["title"] ?? entry.ref.label),
          owner: entry.card === null ? "the chat" : (names.get(entry.card) ?? "a character"),
          card: entry.card,
          active: switches.get(entry.ref.entityId) ?? onByDefault,
          editable: noteEditable(state, entry.ref.entityId, doc),
          linked: entry.linked !== null,
          content: String(entry.linked ? entry.doc["content"] : (doc["content"] ?? "")),
          doc,
          revision
        } satisfies NoteView
      })
    )
    return { notes, state }
  })

/** The one note called `title` (case and spaces aside), or the error the model sees. */
const named = (notes: ReadonlyArray<NoteView>, title: string) => {
  const wanted = title.trim().toLowerCase()
  const found = notes.filter((n) => n.title.trim().toLowerCase() === wanted)
  if (found.length === 1) return found[0]!
  return {
    text: found.length ? `Several notes are called “${title}”.` : `No note is called “${title}”.`,
    isError: true
  }
}

/** Why the agent may not change a note, or null when it may. */
const refusal = (note: NoteView) =>
  !note.editable
    ? `You may not change “${note.title}”.`
    : note.linked
      ? `“${note.title}” shows a shared note, which only its editor changes.`
      : null

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
        const { notes } = yield* notesAt(context)
        if (notes.length === 0) return { text: "The chat has no notes." }
        return {
          text: notes
            .map(
              (n) =>
                `“${n.title}” (${n.owner}'s; ${n.active ? "on" : "off"}${n.editable && !n.linked ? "; you may change it" : ""})${
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
        const target = named((yield* notesAt(context)).notes, note)
        if ("isError" in target) return target
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

/** The card named `character` among the chat's cast, by its in-chat name. */
export const castMember = (context: ToolContext, state: ChatState, character: string) =>
  Effect.gen(function* () {
    const ids = [...new Set([...state.participants, ...state.playedByMe])] as Array<EntityId>
    const cards = ids.length ? yield* context.reader.CastCards({ userId: context.userId, entityIds: ids }) : []
    const wanted = character.trim().toLowerCase()
    const card = cards.find((c) => [c.modelName, c.name].some((n) => n?.trim().toLowerCase() === wanted))
    if (card) return { ok: true as const, card, name: card.modelName ?? card.name }
    return {
      ok: false as const,
      error: {
        text: `No character called “${character}” is in the chat. In it: ${cards.map((c) => c.modelName ?? c.name).join(", ") || "nobody"}.`,
        isError: true
      }
    }
  })

/** The most a note the agent writes holds. */
const NOTE_CHARS = 8_000

export const writeNote: RolloutTool<{
  readonly title: string
  readonly content: string
  readonly depth?: number
  readonly for?: string
}> = {
  id: "write_note",
  label: "Wrote a note",
  explanation: "Write new notes for this chat",
  effect: "chat_state",
  description:
    "Writes a new note for the chat, on from the next message on: a lasting fact the story should keep (an injury, an outfit, a promise, where someone is). It goes at the end of your context unless you give a depth. Use edit_note to change a note that exists rather than writing another.",
  parameters: Type.Object({
    title: Type.String({ description: "A short title, unique among the notes." }),
    content: Type.String({ description: "The note's text." }),
    depth: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Place it this many messages from the end instead." })
    ),
    for: Type.Optional(Type.String({ description: "A character's name: the note applies only on their turns." }))
  }),
  summarize: ({ title }) => `“${title}”`,
  execute: (context, args) =>
    safely(
      "write_note",
      Effect.gen(function* () {
        const title = args.title.trim().slice(0, 200)
        if (!title) return { text: "Give the note a title.", isError: true }
        if (args.content.length > NOTE_CHARS)
          return { text: `A note holds at most ${NOTE_CHARS} characters.`, isError: true }
        const { notes, state } = yield* notesAt(context)
        if (notes.some((n) => n.title.trim().toLowerCase() === title.toLowerCase()))
          return { text: `A note called “${title}” exists: change it with edit_note.`, isError: true }
        const found = args.for === undefined ? null : yield* castMember(context, state, args.for)
        if (found && !found.ok) return found.error
        const member = found
        const doc: Doc = {
          schema_version: NOTE_SCHEMA_VERSION,
          title,
          content: args.content,
          placement:
            args.depth === undefined
              ? { mode: "tail", role: "system" }
              : { mode: "depth", depth: args.depth, role: "system" },
          exportable: false,
          // A note the agent wrote is one it may change again [P]; the user can turn that off.
          agent_editable: true,
          ...(member ? { condition: { when: "turn", cards: [member.card.entityId] } } : {})
        }
        const { result } = yield* context.writer.ApplyRolloutEffect({
          userId: context.userId,
          rolloutId: context.rolloutId,
          toolCallId: context.toolCallId,
          events: [],
          notes: [{ create: doc }],
          result: `Wrote “${title}”: it's on from the next message on.`
        })
        return { text: result }
      })
    )
}

/** `text` with the one occurrence of `find` replaced, or why it can't be. */
export const replaceOnce = (text: string, find: string, replace: string) => {
  if (!find) return { error: "Give the passage to find." }
  const at = text.indexOf(find)
  if (at < 0) return { error: "The passage isn't in it: give it exactly as it stands." }
  if (text.indexOf(find, at + 1) >= 0) return { error: "The passage is in it more than once: give more of it." }
  return { text: text.slice(0, at) + replace + text.slice(at + find.length) }
}

export const editNote: RolloutTool<{
  readonly note: string
  readonly find?: string
  readonly replace?: string
  readonly content?: string
}> = {
  id: "edit_note",
  label: "Changed a note",
  explanation: "Change the notes you let it change",
  effect: "chat_state",
  description:
    "Changes a note's text from the next message on, by its title: replace one exact passage (find and replace, the usual way), or give the whole new text as content. Only notes you may change.",
  parameters: Type.Object({
    note: Type.String({ description: "The note's title." }),
    find: Type.Optional(Type.String({ description: "The passage to change, exactly as it stands, once in the note." })),
    replace: Type.Optional(Type.String({ description: "What it becomes; empty removes it." })),
    content: Type.Optional(Type.String({ description: "The note's whole new text, in place of find and replace." }))
  }),
  summarize: ({ note }) => `“${note}”`,
  execute: (context, args) =>
    safely(
      "edit_note",
      Effect.gen(function* () {
        const target = named((yield* notesAt(context)).notes, args.note)
        if ("isError" in target) return target
        const refused = refusal(target)
        if (refused) return { text: refused, isError: true }
        const next =
          args.content !== undefined
            ? { text: args.content }
            : replaceOnce(target.content, args.find ?? "", args.replace ?? "")
        if ("error" in next) return { text: `${next.error} (“${target.title}”)`, isError: true }
        if (next.text.length > NOTE_CHARS)
          return { text: `A note holds at most ${NOTE_CHARS} characters.`, isError: true }
        if (next.text === target.content) return { text: `“${target.title}” already says that.` }
        const { result } = yield* context.writer.ApplyRolloutEffect({
          userId: context.userId,
          rolloutId: context.rolloutId,
          toolCallId: context.toolCallId,
          events: [],
          notes: [
            { revise: { note: target.entity, parent: target.revision, doc: { ...target.doc, content: next.text } } }
          ],
          result: `Changed “${target.title}” from the next message on.`
        })
        return { text: result }
      })
    )
}
