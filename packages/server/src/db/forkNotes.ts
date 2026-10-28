// Human note inheritance is a comparison of two projections of the same source fork.
// Both the reader's preview and the writer's atomic validation use this query.
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { ForkNote } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc } from "@rp/shared/library.ts"
import { FoldableEvent, foldState, noteSwitches } from "@rp/shared/state.ts"
import { Effect, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { onPath } from "./forks.ts"
import { NotFound } from "./ops.ts"
import { stateEventRowsOnPath } from "./stateRead.ts"
import { sharedNote } from "./sharedNotes.ts"

const decodeEvent = Schema.decodeUnknownSync(FoldableEvent)

export const previewForkNotes = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  {
    userId,
    chatId,
    fromForkId,
    atSlotId
  }: {
    userId: UserId
    chatId: ChatId
    fromForkId: ForkId | null
    atSlotId: SlotId | null
  }
) {
  const [fork] = yield* sql<{ id: string; tip_slot_id: SlotId | null }>`
    SELECT f.id, f.tip_slot_id FROM forks f JOIN chats c ON c.id = f.chat_id
    WHERE c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      AND f.id = coalesce(${fromForkId}, c.current_fork_id) AND f.deleted_at IS NULL`
  if (!fork) return yield* new NotFound({ entity: "fork", id: fromForkId ?? chatId })
  if (atSlotId !== null) {
    const [live] =
      yield* sql`SELECT id FROM slots WHERE id = ${atSlotId} AND chat_id = ${chatId} AND deleted_at IS NULL`
    if (!live || !(yield* onPath(sql, chatId, fork.tip_slot_id, atSlotId)))
      return yield* new NotFound({ entity: "slot", id: atSlotId })
  }
  const thenRows = yield* stateEventRowsOnPath(sql, chatId, atSlotId, fork.id)
  const nowRows = yield* stateEventRowsOnPath(sql, chatId, fork.tip_slot_id, fork.id)
  const events = (rows: typeof thenRows) =>
    rows.map((row) => decodeEvent({ scope: row.scope, data: { key: row.key, value: JSON.parse(row.value_json) } }))
  const earlier = new Set(thenRows.map((row) => row.id))
  const noteKey = (key: string) => ["note.binding", "note.activate", "note.deactivate"].includes(key)
  const thenEvents = events(thenRows)
  // Agent effects remain causal. Only human changes after the point can be carried back.
  const nowEvents = events(
    nowRows.filter(
      (row) => earlier.has(row.id) || !noteKey(row.key) || (row.origin === "user" && row.version_id === null)
    )
  )
  const thenState = foldState(thenEvents)
  const nowState = foldState(nowEvents)
  const thenSwitches = noteSwitches(thenEvents)
  const nowSwitches = noteSwitches(nowEvents)
  const changed = new Set(
    nowRows.flatMap((row) =>
      !earlier.has(row.id) &&
      row.origin === "user" &&
      row.version_id === null &&
      ["note.binding", "note.activate", "note.deactivate"].includes(row.key)
        ? [(JSON.parse(row.value_json) as { note: string }).note]
        : []
    )
  )
  if (changed.size === 0) return []
  const rows = yield* sql<{ entity: EntityId; revision: string; doc_json: string; card_name: string | null }>`
    SELECT e.id AS entity, r.head_revision_id AS revision, h.doc_json,
      (SELECT label FROM entity_refs WHERE entity_id = json_extract(h.doc_json, '$.owner.card')
        AND ref_kind = 'upstream') AS card_name
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
      AND e.id IN ${sql.in([...changed])}
      AND (json_extract(h.doc_json, '$.owner.chat') = ${chatId}
        OR json_extract(h.doc_json, '$.owner.card') IN ${sql.in(nowState.participants.length ? [...nowState.participants] : [""])})
    ORDER BY e.id`
  const result: Array<ForkNote> = []
  for (const row of rows) {
    const head = JSON.parse(row.doc_json) as Doc
    const card = Predicate.isObject(head.owner) && typeof head.owner.card === "string"
    const snapshot = Effect.fnUntraced(function* (state: typeof thenState, switches: typeof thenSwitches) {
      // Card text is library-owned; only its activation in this chat is positional.
      const revision = card ? row.revision : (state.noteRevisions[row.entity] ?? row.revision)
      const [bound] = yield* sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions
        WHERE id = ${revision} AND entity_id = ${row.entity}`
      const doc = bound ? (JSON.parse(bound.doc_json) as Doc) : head
      const linked = typeof doc.link === "string" ? yield* sharedNote(sql, userId, doc.link) : null
      return {
        revision,
        content: linked?.content ?? (typeof doc.content === "string" ? doc.content : ""),
        enabled: switches.get(row.entity) ?? (card && doc.on_by_default === true)
      }
    })
    const then = yield* snapshot(thenState, thenSwitches)
    const now = yield* snapshot(nowState, nowSwitches)
    if (then.revision === now.revision && then.enabled === now.enabled) continue
    result.push({
      note: row.entity,
      title: typeof head.title === "string" && head.title ? head.title : "Untitled note",
      card,
      owner: card ? (row.card_name ?? "Character note") : "This chat",
      then,
      now
    })
  }
  return result
})
