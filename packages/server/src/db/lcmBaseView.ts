// Message overrides in one fork's bounded lineage, scoped to one read transaction.
import { Context, Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { lineageCte } from "./forkLabels.ts"
import { withFork } from "./forkState.ts"

interface MessageOverride {
  readonly kind: string
  readonly target_id: string
  readonly value_id: string | null
  readonly flag: number | null
  readonly summaries_done: number
}
export const BaseViews = Context.Reference<Map<string | null, ReadonlyArray<MessageOverride>> | null>(
  "rp/lcm/BaseViews",
  { defaultValue: () => null }
)

export const messageView = (sql: SqlClient.SqlClient, fork: string | null) =>
  Effect.gen(function* () {
    const memo = yield* BaseViews
    const hit = memo?.get(fork)
    if (hit) return hit
    const rows = yield* sql<MessageOverride>`WITH RECURSIVE ${withFork(sql, fork, (f) => lineageCte("lineage", f))}
    SELECT o.kind,o.target_id,o.value_id,o.flag,o.summaries_done FROM lineage l
      CROSS JOIN fork_overrides o INDEXED BY fork_overrides_point ON o.fork_id=l.fork_id AND o.seq<=l.bound
    WHERE o.kind IN ('select','replace','delete_slot','delete_version','hide','hide_range','image_exclude')
    ORDER BY l.n,o.seq DESC`
    const seen = new Set<string>()
    const effective = rows.filter((r) => {
      const key = `${r.kind}\u0000${r.target_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    memo?.set(fork, effective)
    return effective
  })

export const baseView = (sql: SqlClient.SqlClient, fork: string | null) =>
  Effect.map(messageView(sql, fork), (rows) => rows.length === 0)
