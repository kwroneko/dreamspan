// Runs only in the writer's migration transaction (DESIGN §8). Chats copied the built-in sizes
// when they were made; those that never changed a size follow the new built-ins, and a size the
// user set (in the chat, or in the account default it was copied from) stays.
import { uuidv7 } from "@rp/shared/id.ts"
import { LCM_BUILTIN, LCM_OLD_BUILTIN_SIZES } from "@rp/shared/lcmSettings.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

type Size = keyof typeof LCM_OLD_BUILTIN_SIZES
const SIZES = Object.keys(LCM_OLD_BUILTIN_SIZES) as ReadonlyArray<Size>
const PAIRS: ReadonlyArray<readonly [Size, Size]> = [
  ["recentTarget", "recentMax"],
  ["layerTarget", "layerMax"]
]

/** The settings with the old built-in sizes this chat never changed replaced by the new ones, or null. */
const followNewSizes = (
  history: ReadonlyArray<Record<string, unknown>>,
  account: Record<string, unknown>
): Record<string, unknown> | null => {
  const current = history.at(-1)
  if (!current) return null
  const next: Record<string, unknown> = { ...current }
  for (const key of SIZES)
    if (
      account[key] === undefined &&
      history.every((settings) => settings[key] === undefined || settings[key] === LCM_OLD_BUILTIN_SIZES[key]) &&
      current[key] === LCM_OLD_BUILTIN_SIZES[key]
    )
      next[key] = LCM_BUILTIN[key]
  // A pair half changed by the user and half followed could put the target at its maximum: keep that pair.
  for (const [target, max] of PAIRS)
    if (typeof next[target] === "number" && typeof next[max] === "number" && next[target] >= next[max]) {
      next[target] = current[target]
      next[max] = current[max]
    }
  return SIZES.some((key) => next[key] !== current[key]) ? next : null
}

export const lcmDefaultsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const accounts = new Map(
    (yield* sql<{ user_id: string; value_json: string }>`
      SELECT user_id, value_json FROM user_settings WHERE key = 'generation.lcm'`).map((row) => [
      row.user_id,
      JSON.parse(row.value_json) as Record<string, unknown>
    ])
  )
  const rows = yield* sql<{ chat_id: string; owner_user_id: string; value_json: string }>`
    SELECT e.chat_id, c.owner_user_id, e.value_json FROM state_events e JOIN chats c ON c.id = e.chat_id
    WHERE e.key = 'lcm.settings' AND e.slot_id IS NULL AND e.scope IS NULL ORDER BY e.chat_id, e.seq`
  const chats = new Map<string, { owner: string; history: Array<Record<string, unknown>> }>()
  for (const row of rows) {
    const chat = chats.get(row.chat_id) ?? { owner: row.owner_user_id, history: [] }
    chat.history.push(JSON.parse(row.value_json) as Record<string, unknown>)
    chats.set(row.chat_id, chat)
  }
  const at = Date.now()
  for (const [chatId, { owner, history }] of chats) {
    const next = followNewSizes(history, accounts.get(owner) ?? {})
    if (next === null) continue
    const [seq] = yield* sql<{ n: number }>`
      SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${chatId} AND slot_id IS NULL`
    yield* sql`INSERT INTO state_events ${sql.insert({
      id: uuidv7(),
      chat_id: chatId,
      slot_id: null,
      version_id: null,
      seq: seq!.n,
      key: "lcm.settings",
      scope: null,
      value_json: JSON.stringify(next),
      origin: "user",
      created_at: at
    })}`
  }
})
