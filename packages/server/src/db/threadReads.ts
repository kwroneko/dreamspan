// The thread sets a fork is in (spec/THREADS.md §4.3, §13), for the branch control's Threads
// section, the timeline's row and the composer's chip: each set's threads with their names, the
// fork a link to each opens (of its live forks, the one current most recently) and how many it
// has. Everything comes from the chat's fork summaries (stored, db/forkSummaries.ts) and the
// set's few member rows, so it costs the forks' stored rows, not their paths.
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import type { ThreadSet } from "@rp/shared/threads.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { displayThrough } from "./displayPath.ts"
import { forkColumns, forkRecency } from "./forks.ts"
import { chatForkSummaries } from "./forkSummaries.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import type { ForkRow } from "./rows.ts"
import { shownSplits } from "./threads.ts"
import { query } from "./tx.ts"

export const makeThreadReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ThreadsOf: ({ userId, chatId, forkId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: string }>`SELECT id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        // Live forks, most recently current first: the first of a thread's is the one it opens on.
        const rows = yield* sql<ForkRow>`
          SELECT ${sql.literal(forkColumns("f"))} FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
          ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
        const asked = rows.find((row) => row.id === forkId)
        if (!asked) return yield* new NotFound({ entity: "fork", id: forkId })
        const summaries = yield* chatForkSummaries(sql, userId, chatId, rows)
        const placesOf = (id: string) => summaries.get(id)?.threads ?? []
        const shown = shownSplits(rows.map((row) => placesOf(row.id)))
        const own = placesOf(forkId).filter((place) => shown.has(place.splitId))
        if (own.length === 0) return []
        const ids = JSON.stringify(own.map((place) => place.splitId))
        const splits = yield* sql<{
          id: string
          slot_id: string
          fork_id: string
          created_at: number
          depth: number
        }>`SELECT x.id, x.slot_id, x.fork_id, x.created_at, s.depth FROM json_each(${ids}) j
          CROSS JOIN thread_splits x ON x.id = j.value JOIN slots s ON s.id = x.slot_id
          WHERE x.chat_id = ${chatId}`
        const members = yield* sql<{
          split_id: string
          ordinal: number
          fork_id: string
          starts: number
          name: string | null
          name_user: number
          row_version: number
        }>`SELECT m.split_id, m.ordinal, m.fork_id, m.starts, m.name, m.name_user, m.row_version
          FROM json_each(${ids}) j CROSS JOIN thread_members m ON m.split_id = j.value ORDER BY m.split_id, m.ordinal`
        return yield* Effect.forEach(own, (place) =>
          Effect.gen(function* () {
            const split = splits.find((x) => x.id === place.splitId)!
            // Its position on this fork's display path: its depth when the fork inserts nothing.
            const through = yield* displayThrough(sql, chatId, forkId, split.slot_id)
            const set: ThreadSet = {
              splitId: split.id,
              slotId: split.slot_id as SlotId,
              position: through?.end ?? split.depth,
              forkId: split.fork_id as ForkId,
              createdAt: split.created_at,
              self: place.ordinal,
              threads: members
                .filter((m) => m.split_id === split.id)
                .map((m) => {
                  const forks = rows.filter((row) =>
                    placesOf(row.id).some((p) => p.splitId === split.id && p.ordinal === m.ordinal)
                  )
                  return {
                    ordinal: m.ordinal,
                    forkId: m.fork_id as ForkId,
                    starts: m.starts === 1,
                    name: m.name,
                    nameUser: m.name_user === 1,
                    openForkId: (forks[0]?.id ?? null) as ForkId | null,
                    forks: forks.length,
                    rowVersion: m.row_version
                  }
                })
            }
            return set
          })
        )
      }).pipe(query("ThreadsOf"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
