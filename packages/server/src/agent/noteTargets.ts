// How an agent reply changes a card field or prompt in a chat without editing it (spec/AGENTIC.md
// §4.6): through a note that replaces the target there, the note-overrides mechanism
// (spec/NOTE-OVERRIDES.md §3). The edit tools reach that mechanism only through these.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { NOTE_SCHEMA_VERSION, type ReplaceTarget, readReplaceTarget, targetCard } from "@dreamspan/shared/docs/note.ts"
import type { Doc } from "@dreamspan/shared/library.ts"
import { type FoldableEvent, swappedCard } from "@dreamspan/shared/state.ts"
import type { Writer } from "../db/Database.ts"
import type { NoteView } from "./tools/notes.ts"

type NoteWrite = NonNullable<Parameters<Writer["Service"]["ApplyRolloutEffect"]>[0]["notes"]>[number]

const sameTarget = (a: ReplaceTarget, owner: string | null, b: ReplaceTarget, events: ReadonlyArray<FoldableEvent>) =>
  a.kind === "preset_prompt"
    ? b.kind === "preset_prompt" && a.identifier === b.identifier
    : b.kind === "card_field" &&
      a.field === b.field &&
      swappedCard(events, targetCard(a, owner)) === targetCard(b, null)

/**
 * The note at the position that replaces `target`, if any: an on one first (the assembler's
 * choice), else one that's off, which an edit turns back on rather than adding a second.
 */
export const replacing = (
  notes: ReadonlyArray<NoteView>,
  target: ReplaceTarget,
  events: ReadonlyArray<FoldableEvent>
) => {
  const candidates = notes.filter((n) => {
    const replaces = readReplaceTarget(n.doc["replaces"])
    return replaces !== null && sameTarget(replaces, n.card, target, events)
  })
  return candidates.find((n) => n.active) ?? candidates[0] ?? null
}

/**
 * The note writes that make `text` replace `target` from the next message on: a new chat note
 * in its place, or a revision of the one replacing it (turned on if it was off).
 */
export const replaceEffects = (
  note: NoteView | null,
  target: ReplaceTarget,
  text: string,
  title: string
): { readonly notes: ReadonlyArray<NoteWrite>; readonly activate: ReadonlyArray<EntityId> } => {
  if (note === null)
    return {
      notes: [
        {
          create: {
            schema_version: NOTE_SCHEMA_VERSION,
            title,
            content: text,
            // Goes in the target's place (replacesInPlace); a placement it still needs.
            placement: { mode: "tail", role: "system" },
            replaces: target,
            exportable: false,
            agent_editable: true
          } satisfies Doc
        }
      ],
      activate: []
    }
  return {
    notes:
      note.content === text
        ? []
        : [{ revise: { note: note.entity, parent: note.revision, doc: { ...note.doc, content: text } } }],
    activate: note.active ? [] : [note.entity]
  }
}
