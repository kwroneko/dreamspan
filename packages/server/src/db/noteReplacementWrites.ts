// One replacing note per target, including off notes. Run inside the writer's transaction so
// two clients cannot both claim a target. Resolve branch bindings and card swaps as assembly does.
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { readReplaceTarget, targetCard } from "@rp/shared/docs/note.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { Doc } from "@rp/shared/library.ts"
import { type FoldableEvent, foldState, swappedCard } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { displayEndOf } from "./displayPath.ts"
import { chatFork } from "./snippets.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { agentWrittenNotes, notesNamed } from "./agentNotes.ts"

const ownerOf = (doc: Doc) => doc.owner as { card?: string; chat?: string } | undefined
const keyOf = (doc: Doc, events: ReadonlyArray<FoldableEvent> = []) => {
  const target = readReplaceTarget(doc.replaces)
  if (target === null) return null
  if (target.kind === "preset_prompt") return `preset:${target.identifier}`
  const card = targetCard(target, ownerOf(doc)?.card ?? null)
  return card === null ? null : `card:${swappedCard(events, card) ?? card}:${target.field}`
}

/** Null if the claim is free; otherwise the user-facing reason for refusing it. */
export const replacementConflict = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  entity: string | null,
  doc: Doc,
  position?: ChatNotePosition,
  previous?: Doc
) {
  const target = keyOf(doc)
  const owner = ownerOf(doc)
  if (target === null || (!owner?.chat && !owner?.card)) return null
  if (previous && keyOf(previous) === target) return null
  const notes = yield* sql<{ entity: string; revision: string; doc_json: string }>`
    SELECT e.id AS entity, r.head_revision_id AS revision, h.doc_json
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL AND e.id != ${entity ?? ""}`
  const heads = notes.map((n) => ({ ...n, doc: JSON.parse(n.doc_json) as Doc }))
  // A note an agent reply wrote exists only where that reply is shown (agentNotes.ts).
  const byAgent = yield* agentWrittenNotes(
    sql,
    heads.filter((n) => ownerOf(n.doc)?.chat !== undefined).map((n) => n.entity)
  )
  const reason = (other: Doc) =>
    `Only one note can replace this target. Unlink the note “${String(other.title || "Untitled note")}” first.`
  // Two notes of one card already conflict without a chat. This also protects unused cards.
  if (owner.card) {
    const other = heads.find((n) => ownerOf(n.doc)?.card === owner.card && keyOf(n.doc) === target)
    if (other) return reason(other.doc)
  }
  const fork = position ? yield* chatFork(sql, userId, position.chatId, position.forkId ?? null) : null
  const forks = yield* sql<{ id: ForkId; chat_id: ChatId; tip_slot_id: SlotId | null }>`
    SELECT f.id, f.chat_id, f.tip_slot_id FROM forks f JOIN chats c ON c.id = f.chat_id
    WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
      AND (${fork} IS NULL OR f.id = ${fork})
      AND (${owner.chat ?? null} IS NULL OR c.id = ${owner.chat ?? null})`
  for (const view of forks) {
    const tip = (yield* displayEndOf(sql, view.chat_id, view)) as SlotId | null
    const rows = yield* stateEventsThrough(sql, view.chat_id, tip, view.id)
    const events = rows.map(
      (row) => ({ scope: row.scope, data: { key: row.key, value: JSON.parse(row.value_json) } }) as FoldableEvent
    )
    const state = foldState(events)
    const cards = new Set([...state.participants, ...state.playedByMe])
    // A library change doesn't affect a chat that pinned this card note to an older revision.
    if (owner.card && (!cards.has(owner.card) || (entity !== null && state.noteRevisions[entity] !== undefined)))
      continue
    const key = keyOf(doc, events)
    const named = notesNamed(rows)
    for (const note of heads) {
      const noteOwner = ownerOf(note.doc)
      if (noteOwner?.chat !== view.chat_id && !(noteOwner?.card && cards.has(noteOwner.card))) continue
      if (byAgent.has(note.entity) && !named.has(note.entity)) continue
      const bound = state.noteRevisions[note.entity]
      let theirs = note.doc
      if (bound && bound !== note.revision) {
        const [revision] = yield* sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions
          WHERE id = ${bound} AND entity_id = ${note.entity}`
        if (revision) theirs = JSON.parse(revision.doc_json) as Doc
      }
      if (keyOf(theirs, events) === key) return reason(theirs)
    }
  }
  return null
})
