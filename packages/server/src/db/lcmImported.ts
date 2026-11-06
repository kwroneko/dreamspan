import { contextExcludedIn } from "./lcmVisibility.ts"
// The ST summary an imported chat carries (ARCHITECTURE §13) as LCM can adopt it (spec/LCM.md
// §2.7): the note's text on the path shown, and the run of messages hidden from the first
// message that it covers. Shared by the offer (a read) and the adoption (the write).
import type { UserId } from "@rp/shared/domain.ts"
import { shownIn, viewAt } from "./forkState.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { makeLibraryQueries } from "./library.ts"
import { noteAt } from "./noteAt.ts"

const decodeNote = Schema.decodeUnknownOption(NoteDoc)

export interface ImportedSummary {
  readonly noteEntity: string
  /** The summary the shown path has: the note's newest text saved on a message of the path. */
  readonly content: string
  /** The run, from the chat's first message to the last slot it covers. */
  readonly firstSlotId: string
  readonly lastSlotId: string
  readonly slotCount: number
  /** Of those slots, how many are hidden now. */
  readonly hidden: number
}

/**
 * The chat's imported summary when it can stand in for the run it covers: the note records
 * `covers`, the run lies on the path to `leafSlotId` and starts at the chat's first message,
 * and nothing in it is a merge or still being generated. Null otherwise. Only counts are read
 * of the run, so a long one costs a walk, not its text.
 */
export const importedSummary = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, leafSlotId: string) =>
  Effect.gen(function* () {
    const lib = makeLibraryQueries(sql)
    const fork = yield* viewAt(sql, chatId, leafSlotId)
    const rows = yield* lib.refsWhere(
      `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM entity_revisions h WHERE h.id = r.head_revision_id
         AND json_extract(h.doc_json, '$.owner.chat') = ? AND json_extract(h.doc_json, '$.kind') = 'imported_summary')`,
      [userId, chatId]
    )
    for (const row of rows) {
      const resolved = yield* noteAt(sql, lib, userId, row, { chatId: chatId as never, slotId: leafSlotId as never })
      const note = decodeNote(resolved.doc)
      if (note._tag === "None" || note.value.covers === undefined || note.value.content.trim() === "") continue
      const { first_slot_id: first, last_slot_id: last } = note.value.covers
      const [onPath] = yield* sql<{ n: number }>`WITH RECURSIVE path(id) AS (
          SELECT ${leafSlotId} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
        ) SELECT count(*) AS n FROM path WHERE id = ${last}`
      if (onPath?.n !== 1) continue
      const [run] = yield* sql<{
        n: number
        root: number
        merged: number
        generating: number
        hidden: number
      }>`WITH RECURSIVE chain(id, parent, depth) AS (
          SELECT id, parent_slot_id, depth FROM slots WHERE id = ${last} AND chat_id = ${chatId}
          UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN chain c ON s.id = c.parent
            WHERE c.id <> ${first}
        ) SELECT count(*) AS n,
          coalesce(sum(c.id = ${first} AND c.parent IS NULL), 0) AS root,
          coalesce(sum(EXISTS (SELECT 1 FROM slot_parents m WHERE m.slot_id = c.id)), 0) AS merged,
          coalesce(sum(coalesce(v.status = 'generating', 0)), 0) AS generating,
          coalesce(sum(${contextExcludedIn(sql, fork)}), 0) AS hidden
          FROM chain c JOIN slots s ON s.id = c.id LEFT JOIN versions v ON v.id = ${shownIn(sql, fork, "s")}`
      if (!run || run.n < 1 || run.root !== 1 || run.merged > 0 || run.generating > 0) continue
      return {
        noteEntity: row.entity_id,
        content: note.value.content,
        firstSlotId: first,
        lastSlotId: last,
        slotCount: run.n,
        hidden: run.hidden
      } satisfies ImportedSummary
    }
    return null
  })

/** The chat's imported summary notes (kind `imported_summary`), by entity id. */
export const importedSummaryNotes = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  Effect.map(
    makeLibraryQueries(sql).refsWhere(
      `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM entity_revisions h WHERE h.id = r.head_revision_id
         AND json_extract(h.doc_json, '$.owner.chat') = ? AND json_extract(h.doc_json, '$.kind') = 'imported_summary')`,
      [userId, chatId]
    ),
    (rows) => rows.map((row) => row.entity_id)
  )
