// Summary facts a read-only connection keeps per fork between operations (ARCHITECTURE.md §16, "Kept planning facts").
// They stay valid while the chat's LCM stamp (baseline.ts `lcmStamp`) and the schema do: every
// write that can change a sealed summary's facts moves the stamp, and appending doesn't, so a
// reply's plans extend what the last one read instead of reading it again. Summaries sealed since
// are found by rowid: a summary is inserted and sealed in one transaction (lcmWrites.ts and the
// other three writers), and its row is never deleted while its chat exists.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { lcmStampTriggers } from "./baseline.ts"

/** At most this many forks' facts per connection, and this many characters across them. */
const MAX_KEPT_FORKS = 8
const MAX_KEPT_CHARACTERS = 64_000_000

interface Kept {
  readonly stamp: number
  readonly value: unknown
  readonly characters: number
}
interface Connection {
  readonly schema: number
  readonly enabled: boolean
  readonly kept: Map<string, Kept>
}
const connections = new WeakMap<SqlClient.SqlClient, Connection>()

/**
 * The facts kept for `key` (a fork of chat `chatId`) if the chat's stamp hasn't moved since,
 * the highest summary rowid of the chat now (`top`), and `save` for the operation's commit.
 * Undefined: this database lacks the stamp's triggers, so nothing may be kept.
 */
export const factStore = <A>(sql: SqlClient.SqlClient, chatId: string, key: string) =>
  Effect.gen(function* () {
    const [schema] = yield* sql<{ schema_version: number }>`PRAGMA schema_version`
    let state = connections.get(sql)
    if (!state || state.schema !== schema!.schema_version) {
      const [row] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM sqlite_schema
        WHERE type='trigger' AND name IN (SELECT value FROM json_each(${JSON.stringify(lcmStampTriggers)}))`
      state = { schema: schema!.schema_version, enabled: row!.count === lcmStampTriggers.length, kept: new Map() }
      connections.set(sql, state)
    }
    if (!state.enabled) return undefined
    const [chat] = yield* sql<{ stamp: number; top: number | null }>`SELECT lcm_stamp AS stamp,
      (SELECT max(rowid) FROM summaries WHERE chat_id=${chatId}) AS top FROM chats WHERE id=${chatId}`
    if (!chat) return undefined
    const kept = state.kept
    const old = kept.get(key)
    return {
      hit: old !== undefined && old.stamp === chat.stamp ? (old.value as A) : undefined,
      top: chat.top ?? 0,
      save: (value: A, characters: number) => {
        kept.delete(key)
        if (characters > MAX_KEPT_CHARACTERS) return
        let total = characters
        for (const entry of kept.values()) total += entry.characters
        // Least recently used first: a Map iterates in insertion order and each save reinserts.
        for (const [oldest, entry] of kept) {
          if (kept.size < MAX_KEPT_FORKS && total <= MAX_KEPT_CHARACTERS) break
          kept.delete(oldest)
          total -= entry.characters
        }
        kept.set(key, { stamp: chat.stamp, value, characters })
      }
    }
  })
