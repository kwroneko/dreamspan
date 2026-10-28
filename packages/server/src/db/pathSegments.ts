// The path from the root to a slot, read by chain segment (spec/FORK-INDEPENDENCE-DELTA.md
// §2.1; chains are assigned in schema/chains.ts). A chain id is its head's id, so the next
// segment up is two lookups by id, the head's parent and its chain's head: finding the
// segments costs the number of branch points the path passes, not its length. A slot is on the path iff some segment
// has its chain and covers its depth.
import type { SqlClient } from "effect/sql"

/**
 * `segments(chain_id, lo, hi, floor)`: the path to `slotId` as chains, newest first, each
 * covering depths `lo` to `hi` of it. With a `limit`, only the segments reaching into the
 * last `limit` depths are found (`floor` is the shallowest wanted), so a window costs the
 * segments it overlaps. Each step must go strictly up, so even a corrupted parent link
 * can't make the walk loop. Further common table expressions can follow it.
 */
export const pathSegments = (
  sql: SqlClient.SqlClient,
  chatId: string,
  slotId: string | null,
  limit: number | null
) => sql`
  WITH RECURSIVE segments(chain_id, lo, hi, floor) AS (
    SELECT s.chain_id, h.depth, s.depth, CASE WHEN ${limit} IS NULL THEN 0 ELSE max(0, s.depth - ${limit} + 1) END
    FROM slots s JOIN slots h ON h.id = s.chain_id
    WHERE s.id = ${slotId} AND s.chat_id = ${chatId}
    UNION ALL
    SELECT p.chain_id, ph.depth, p.depth, g.floor
    FROM segments g JOIN slots h ON h.id = g.chain_id JOIN slots p ON p.id = h.parent_slot_id
      JOIN slots ph ON ph.id = p.chain_id
    WHERE g.lo > g.floor AND p.depth < g.lo AND ph.depth <= p.depth
  )`

/**
 * `path_events`: the chat-wide state events (slot null) and those at any slot on the path
 * to `slotId` (none for null), found by their slot's chain and depth. Whether one applies
 * (its slot deleted, its version not selected, superseded) is for the caller. The segments
 * drive the join (CROSS JOIN fixes the order): left to itself, SQLite read every event of
 * the chat and looked each one up among the segments.
 */
export const pathEvents = (sql: SqlClient.SqlClient, chatId: string, slotId: string | null) => sql`
  ${pathSegments(sql, chatId, slotId, null)},
  path_events AS (
    SELECT e.* FROM state_events e WHERE e.chat_id = ${chatId} AND e.slot_id IS NULL
    UNION ALL
    SELECT e.* FROM segments g CROSS JOIN state_events e
      ON e.chat_id = ${chatId} AND e.slot_chain_id = g.chain_id AND e.slot_depth BETWEEN g.lo AND g.hi
  )`
