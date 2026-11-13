// A separate join's parallel stretch (spec/THREADS.md §7.3, TH7): the messages a stretch view
// filters by presence (`STRETCH_VIEW`, db/knowers.ts). The join records them as its branch
// showed them (`thread_stretch_slots`): the join, the destination's messages beside the joined
// part, inserted ones included, and the message just before them (`opens`). A message inserted
// later after one of those, in a branch that shows the join, joins the stretch, so nothing
// written into the stretch is ever read whole by a character who wasn't there.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { onForkPath } from "./forks.ts"

/** Records a separate join's stretch at `joinSlot`: its span (as shown), the join, and the slot before. */
export const recordStretch = (
  sql: SqlClient.SqlClient,
  mergeId: string,
  joinSlot: string,
  span: ReadonlyArray<string>,
  before: string | null
) =>
  Effect.gen(function* () {
    const rows = [
      ...[...new Set([...span, joinSlot])].map((slot_id) => ({ merge_id: mergeId, slot_id, opens: 0 })),
      ...(before !== null && before !== joinSlot && !span.includes(before)
        ? [{ merge_id: mergeId, slot_id: before, opens: 1 }]
        : [])
    ]
    for (let i = 0; i < rows.length; i += 200)
      yield* sql`INSERT INTO thread_stretch_slots ${sql.insert(rows.slice(i, i + 200))}`
  })

/**
 * A message `slot` inserted after `anchor` in `fork`: in the stretch of each separate join the
 * fork shows whose stretch holds the anchor (or opens with it) and which isn't the join itself.
 */
export const extendStretches = (
  sql: SqlClient.SqlClient,
  chatId: string,
  fork: { readonly id: string; readonly tip_slot_id: string | null },
  anchor: string,
  slot: string
) =>
  Effect.gen(function* () {
    const joins = yield* sql<{ merge_id: string; join_slot: string }>`
      SELECT DISTINCT t.merge_id, m.slot_id AS join_slot FROM thread_stretch_slots t
        JOIN chat_merges m ON m.id = t.merge_id
      WHERE t.slot_id = ${anchor} AND m.slot_id <> ${anchor} AND m.chat_id = ${chatId}`
    for (const join of joins)
      if (yield* onForkPath(sql, chatId, fork, join.join_slot))
        yield* sql`INSERT OR IGNORE INTO thread_stretch_slots ${sql.insert({ merge_id: join.merge_id, slot_id: slot, opens: 0 })}`
  })
