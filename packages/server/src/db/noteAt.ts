import { eventApplies, inFork } from "./forkState.ts"
// Resolve the editor through the same branch binding the assembler reads (DESIGN §3.4).
import type { UserId } from "@dreamspan/shared/domain.ts"
import { attachedApplies, slotDeletedIn, viewAt } from "./forkState.ts"
import type { ChatNotePosition } from "@dreamspan/shared/editorApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { makeLibraryQueries, RefRow } from "./library.ts"
import type { ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { entityDraftTarget } from "@dreamspan/shared/drafts.ts"
import { SUMMARY_HISTORY, summaryOnPath } from "../assembler/summary.ts"
import { noteHistory } from "./noteHistory.ts"
import { NotFound } from "./ops.ts"
import { displayEndOf, displayEvents, displayThrough } from "./displayPath.ts"

/**
 * A chat's own note as its branch has it at `position`: the revision bound there. `latest`
 * reads it at the branch's latest message instead, whatever message the position names: where a
 * note is edited, since an edit is tied to the chat's current state (owner, 2026-11-02, via the
 * coordinator: "When you edit a note, the edits are inherently tied to the current chat state").
 */
export const noteAt = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  lib: ReturnType<typeof makeLibraryQueries>,
  userId: UserId,
  ref: RefRow,
  position: ChatNotePosition,
  latest = false
) {
  const { chatId } = position
  let slotId = position.slotId
  const [chat] = yield* sql<{
    id: string
  }>`SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
  if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
  if (slotId !== null) {
    const [slot] = yield* sql<{
      id: string
    }>`SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}
      AND (${latest ? 1 : 0} OR deleted_at IS NULL)`
    if (!slot) return yield* new NotFound({ entity: "slot", id: slotId })
  }
  const head = yield* lib.loadDoc(ref.head_revision_id)
  // A binding attached to a version applies where the fork in view shows it.
  const fork = yield* viewAt(sql, chatId, slotId).pipe(inFork(sql, chatId, position.forkId, slotId))
  if (fork === null) return yield* new NotFound({ entity: "fork", id: chatId })
  if (ref.kind !== "note" || (head.owner as { chat?: string } | undefined)?.chat !== chatId) {
    return yield* new NotFound({ entity: "note", id: ref.id })
  }
  const [tip] = yield* sql<{ tip: SlotId | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${fork}`
  const end = latest
    ? ((yield* displayEndOf(sql, chatId, { id: fork, tip_slot_id: tip?.tip ?? null })) as SlotId | null)
    : (tip?.tip ?? null)
  if (latest) slotId = end
  // In a fork with insertions, the binding nearest before the slot in display order.
  const shown = yield* displayThrough(sql, chatId, fork, slotId)
  const [binding] = shown
    ? yield* sql<{ revision: string }>`
      ${displayEvents(sql, chatId, shown.pieces)}
      SELECT json_extract(e.value_json, '$.revision') AS revision FROM path_events e LEFT JOIN slots s ON s.id = e.slot_id
      WHERE e.key = 'note.binding' AND json_extract(e.value_json, '$.note') = ${ref.entity_id}
        AND ${eventApplies(sql, fork, "e")}
        AND (e.slot_id IS NULL OR NOT ${slotDeletedIn(sql, fork, "s")})
        AND ${attachedApplies(sql, fork, "s", "e.version_id")}
      ORDER BY coalesce(e.position, -1) DESC, e.seq DESC LIMIT 1`
    : yield* sql<{ revision: string }>`
      WITH RECURSIVE path(id) AS (
        SELECT id FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}
        UNION ALL
        SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
      )
      SELECT json_extract(e.value_json, '$.revision') AS revision FROM state_events e
      LEFT JOIN path p ON p.id = e.slot_id LEFT JOIN slots s ON s.id = p.id
      WHERE e.chat_id = ${chatId} AND e.key = 'note.binding' AND json_extract(e.value_json, '$.note') = ${ref.entity_id}
        AND ${eventApplies(sql, fork, "e")}
        AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND NOT ${slotDeletedIn(sql, fork, "s")}))
        AND ${attachedApplies(sql, fork, "s", "e.version_id")}
      ORDER BY coalesce(s.depth, -1) DESC, e.seq DESC LIMIT 1`
  const [revision] = yield* sql<{
    id: string
  }>`SELECT id FROM entity_revisions WHERE id = ${binding?.revision ?? ref.head_revision_id} AND entity_id = ${ref.entity_id}`
  if (!revision) return yield* new NotFound({ entity: "revision", id: binding?.revision ?? ref.head_revision_id })
  const current = yield* lib.loadDoc(revision.id)
  let doc = current
  let selected = revision.id
  if (current.kind === "imported_summary" && current.source_slot_id !== undefined) {
    const sources = noteHistory(sql, userId, chatId)
    const history = yield* sources.noteHistory(ref.entity_id, revision.id, SUMMARY_HISTORY)
    const slots = [
      ...new Set(history.flatMap(({ doc }) => (typeof doc.source_slot_id === "string" ? [doc.source_slot_id] : [])))
    ]
    const found = summaryOnPath(current, history, yield* sources.onPath(slotId, slots))
    doc = found?.doc ?? { ...current, content: "" }
    selected = found?.revision ?? revision.id
  }
  // Its unsaved text is its branch's (the drafts' scope).
  return { ref: { ...ref, head_revision_id: selected }, doc, fork, tip: end, scope: fork }
})

/** A chat's own note where it's edited: at its branch's latest message (`noteAt`). */
export const noteHere = (
  sql: SqlClient.SqlClient,
  lib: ReturnType<typeof makeLibraryQueries>,
  userId: UserId,
  ref: RefRow,
  position: ChatNotePosition
) => noteAt(sql, lib, userId, ref, position, true)

/**
 * Whether another live branch (fork) of the chat has a version of the note of its own: unsaved
 * text there, or a change bound there that makes it differ at its latest message from `here`
 * (by content, not revision id). A branch that never changed it isn't counted.
 */
export const otherBranches = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  lib: ReturnType<typeof makeLibraryQueries>,
  userId: UserId,
  ref: RefRow,
  chatId: ChatNotePosition["chatId"],
  here: { readonly fork: string; readonly ref: RefRow }
) {
  const hash = (revision: string) =>
    sql<{ hash: string }>`SELECT doc_hash AS hash FROM entity_revisions WHERE id = ${revision}`.pipe(
      Effect.map(([row]) => row?.hash ?? revision)
    )
  const mine = yield* hash(here.ref.head_revision_id)
  const forks = yield* sql<{ id: ForkId; tip: SlotId | null }>`
    SELECT id, tip_slot_id AS tip FROM forks WHERE chat_id = ${chatId} AND deleted_at IS NULL AND id <> ${here.fork}`
  for (const fork of forks) {
    const [typed] = yield* sql<{ one: number }>`SELECT 1 AS one FROM drafts WHERE user_id = ${userId}
      AND target_kind = 'entity_field' AND target_id = ${entityDraftTarget(ref.id, fork.id)} AND status = 'active' LIMIT 1`
    if (typed) return true
    const there = yield* noteHere(sql, lib, userId, ref, { chatId, forkId: fork.id, slotId: fork.tip }).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(null))
    )
    // A branch that never changed it (its library head, as made) has no version of its own.
    if (there === null || there.ref.head_revision_id === ref.head_revision_id) continue
    if ((yield* hash(there.ref.head_revision_id)) !== mine) return true
  }
  return false
})

/**
 * Where each of a chat note's revisions took effect: the messages its bindings are at, and
 * whether each applies on `fork` (the branch shown) or on another branch only.
 */
export const noteChangedAt = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: string,
  revisions: ReadonlyArray<string>
) {
  const rows = yield* sql<{ revision: string; depth: number | null; here: number }>`
    SELECT json_extract(e.value_json, '$.revision') AS revision, s.depth AS depth,
      ${eventApplies(sql, fork, "e")} AS here
    FROM state_events e LEFT JOIN slots s ON s.id = e.slot_id
    WHERE e.chat_id = ${chatId} AND e.key = 'note.binding' AND e.superseded_by_changeset IS NULL
      AND json_extract(e.value_json, '$.revision') IN (SELECT value FROM json_each(${JSON.stringify(revisions)}))
    ORDER BY e.seq`
  const out = new Map<string, Array<{ message: number | null; thisBranch: boolean }>>()
  for (const row of rows) {
    const list = out.get(row.revision) ?? []
    const at = { message: row.depth === null ? null : row.depth + 1, thisBranch: row.here === 1 }
    if (!list.some((seen) => seen.message === at.message && seen.thisBranch === at.thisBranch)) list.push(at)
    out.set(row.revision, list)
  }
  return out
})
