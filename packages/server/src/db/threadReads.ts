// The thread sets a fork is in (spec/THREADS.md §4.3, §13), for the branch control's Threads
// section, the timeline's row and the composer's chip: each set's threads with their names, the
// fork a link to each opens (of its live forks, the one current most recently) and how many it
// has. Everything comes from the chat's fork summaries (stored, db/forkSummaries.ts) and the
// set's few member rows, so it costs the forks' stored rows, not their paths.
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { awayAt } from "@rp/shared/knowledge.ts"
import { type FoldableEvent, foldState } from "@rp/shared/state.ts"
import type { ThreadPlace, ThreadSet } from "@rp/shared/threads.ts"

import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { displayThrough } from "./displayPath.ts"
import { forkColumns, forkRecency } from "./forks.ts"
import { chatForkSummaries } from "./forkSummaries.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import type { ForkRow } from "./rows.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"
import { shownSplits } from "./threads.ts"
import { query } from "./tx.ts"

/** Who of the cast is in a thread: its characters at S in the fork that starts it, not away there. */
const threadCastAt = (sql: SqlClient.SqlClient, chatId: string, forkId: string, slotId: string) =>
  Effect.gen(function* () {
    const rows = yield* stateEventsThrough(sql, chatId as ChatId, slotId as SlotId, forkId)
    const state = foldState(
      yield* withoutPurged(
        sql,
        rows.map((e) => ({
          scope: e.scope,
          data: { key: e.key, value: JSON.parse(e.value_json) }
        })) as Array<FoldableEvent>
      )
    )
    const away = awayAt(state)
    return state.participants.filter(
      (id) => !away.includes(id) && state.roles[id] !== "narrator" && !state.playedByMe.includes(id)
    ) as Array<EntityId>
  })

/**
 * What the left panel's Threads group calls each fork (spec/THREADS.md §13.6): the thread of
 * its innermost shown set, its name and its characters, by fork id. Read only for the rows that
 * group returns, so it costs their sets' member rows and one state fold per unnamed thread.
 */
export const threadLabels = (
  sql: SqlClient.SqlClient,
  forks: ReadonlyArray<{ readonly forkId: string; readonly chatId: string; readonly place: ThreadPlace }>
) =>
  Effect.gen(function* () {
    const labels = new Map<string, { name: string | null; cast: ReadonlyArray<EntityId> }>()
    if (forks.length === 0) return labels
    const ids = JSON.stringify([...new Set(forks.map((f) => f.place.splitId))])
    const members = yield* sql<{
      split_id: string
      ordinal: number
      fork_id: string
      name: string | null
      slot_id: string
    }>`SELECT m.split_id, m.ordinal, m.fork_id, m.name, x.slot_id FROM json_each(${ids}) j
        CROSS JOIN thread_members m ON m.split_id = j.value JOIN thread_splits x ON x.id = m.split_id`
    const casts = new Map<string, ReadonlyArray<EntityId>>()
    for (const fork of forks) {
      const member = members.find((m) => m.split_id === fork.place.splitId && m.ordinal === fork.place.ordinal)
      if (!member) continue
      const key = `${member.split_id}:${member.ordinal}`
      let cast = casts.get(key)
      if (cast === undefined) {
        cast = yield* threadCastAt(sql, fork.chatId, member.fork_id, member.slot_id)
        casts.set(key, cast)
      }
      labels.set(fork.forkId, { name: member.name, cast })
    }
    return labels
  })

export const makeThreadReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const castAt = (chatId: string, forkId: string, slotId: string) => threadCastAt(sql, chatId, forkId, slotId)
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
            const own = members.filter((m) => m.split_id === split.id)
            const casts = yield* Effect.forEach(own, (m) => castAt(chatId, m.fork_id, split.slot_id))
            const set: ThreadSet = {
              splitId: split.id,
              slotId: split.slot_id as SlotId,
              position: through?.end ?? split.depth,
              forkId: split.fork_id as ForkId,
              createdAt: split.created_at,
              self: place.ordinal,
              threads: own.map((m, index) => {
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
                  cast: casts[index]!,
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
