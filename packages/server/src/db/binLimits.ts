import { defaultBinLimits, type BinLimits } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Context, Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const BinLimitDefaults = Context.Reference<BinLimits>("rp/db/BinLimitDefaults", {
  defaultValue: () => defaultBinLimits
})

export const readBinLimits = (sql: SqlClient.SqlClient, userId: UserId, defaults: BinLimits = defaultBinLimits) =>
  sql<{
    value_json: string
  }>`SELECT value_json FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = 'bin.limits'`.pipe(
    Effect.map(([row]): BinLimits => ({ ...defaults, ...(row ? JSON.parse(row.value_json) : {}) }))
  )
