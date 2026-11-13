// Presence corrections share the fork override lineage with thread corrections. One row holds
// chain intervals, never copies of messages or swipes. Existing children keep their old value.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { lineageCte } from "./forkLabels.ts"
import { type ForkRef, withFork } from "./forkState.ts"
import type { PathPiece } from "./displayPath.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { VersionPresence } from "@rp/shared/knowledge.ts"

export interface PresenceRange {
  readonly identities: ReadonlyArray<string>
  readonly away: boolean
  readonly cutoff: number
  readonly spans: ReadonlyArray<{ chain: string; lo: number; hi: number }>
}

/** Display intervals include inserted messages, but never structural siblings. */
export const presenceSpans = (pieces: ReadonlyArray<PathPiece>, from: number, through: number) =>
  pieces.flatMap((p) => {
    const lo = p.kind === "run" ? p.lo : p.depth
    const hi = p.kind === "run" ? p.hi : p.depth
    const start = Math.max(from, p.start)
    const end = Math.min(through, p.start + hi - lo)
    return start > end ? [] : [{ chain: p.chainId, lo: lo + start - p.start, hi: lo + end - p.start }]
  })

/** Newest first; disabled targets mask inherited corrections, as every other override does. */
export const readPresenceRanges = (sql: SqlClient.SqlClient, fork: ForkRef) =>
  Effect.gen(function* () {
    if (fork === null) return []
    const rows = yield* sql<{ value_id: string }>`
      WITH RECURSIVE ${withFork(sql, fork, (f) => lineageCte("lineage", f))}
      SELECT value_id FROM (
        SELECT o.value_id, o.flag, o.seq,
          row_number() OVER (PARTITION BY o.target_id ORDER BY l.n, o.seq DESC) AS n
        FROM lineage l CROSS JOIN fork_overrides o
        WHERE o.fork_id=l.fork_id AND o.kind='presence_range' AND o.seq<=l.bound
      ) WHERE n=1 AND flag=1 ORDER BY seq DESC`
    return rows.map((r) => JSON.parse(r.value_id) as PresenceRange)
  })

export const rangeAway = (
  ranges: ReadonlyArray<PresenceRange>,
  chain: string,
  depth: number,
  seq: number,
  card: string
) =>
  ranges.find(
    (r) =>
      seq <= r.cutoff &&
      r.identities.includes(card) &&
      r.spans.some((s) => s.chain === chain && depth >= s.lo && depth <= s.hi)
  )?.away

export const rangedPresence = (
  presence: VersionPresence | null,
  ranges: ReadonlyArray<PresenceRange>,
  chain: string,
  depth: number,
  seq: number
): VersionPresence | null => {
  if (ranges.length === 0) return presence
  const away = new Set(presence?.away ?? [])
  for (const card of new Set(ranges.flatMap((r) => r.identities))) {
    const value = rangeAway(ranges, chain, depth, seq, card)
    if (value === true) away.add(card as EntityId)
    if (value === false) away.delete(card as EntityId)
  }
  return away.size || presence?.narrators?.length
    ? {
        ...(away.size ? { away: [...away] } : {}),
        ...(presence?.narrators?.length ? { narrators: presence.narrators } : {})
      }
    : null
}

/** Scalar SQL value: 0 present, 1 away, NULL unchanged; aliases s (slot) and v (version). */
export const rangeAwaySql = (sql: SqlClient.SqlClient, ranges: ReadonlyArray<PresenceRange>, card: string) =>
  ranges.length === 0
    ? sql`NULL`
    : sql`(SELECT r.value ->> 'away' FROM json_each(${JSON.stringify(ranges)}) r
    WHERE coalesce((SELECT seq FROM versions source WHERE source.id=v.source_version_id AND v.fork_id IS NOT NULL), v.seq) <= r.value ->> 'cutoff'
      AND EXISTS (SELECT 1 FROM json_each(r.value, '$.identities') presence_card WHERE presence_card.value=${sql.literal(card)})
      AND EXISTS (SELECT 1 FROM json_each(r.value, '$.spans') span
        WHERE span.value ->> 'chain'=s.chain_id AND s.depth BETWEEN span.value ->> 'lo' AND span.value ->> 'hi')
    ORDER BY CAST(r.key AS INTEGER) LIMIT 1)`
