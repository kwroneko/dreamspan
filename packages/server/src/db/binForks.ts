// The warning and the purge use the same fork view; the writer rechecks it before erasing.
import { BinForkShown } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { forksShowing, lastShown } from "./forks.ts"
import { shownIn } from "./forkState.ts"

export const binItemForks = (sql: SqlClient.SqlClient, userId: UserId, itemIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const shown: Array<BinForkShown> = []
    const items =
      itemIds.length === 0
        ? []
        : yield* sql<{ id: string; kind: string; target_id: string; chat_id: string; origin_json: string }>`
                SELECT id, kind, target_id, chat_id, origin_json FROM bin_items
                WHERE user_id = ${userId} AND kind IN ('message', 'version') AND chat_id IS NOT NULL
                  AND ${sql.in("id", itemIds)}`
    for (const item of items) {
      const origin = JSON.parse(item.origin_json) as { forkId?: string; slotId?: string; chatTitle?: string }
      if (origin.forkId === undefined || origin.slotId === undefined) continue
      const forks = yield* forksShowing(
        sql,
        item.chat_id,
        origin.slotId,
        item.kind === "version" ? item.target_id : null,
        origin.forkId,
        false
      )
      for (const fork of forks) {
        const end = yield* lastShown(sql, item.chat_id, fork)
        const [tip] = yield* sql<{ excerpt: string }>`
              SELECT substr(v.content, 1, 80) AS excerpt FROM slots t JOIN versions v ON v.id = ${shownIn(sql, fork.id, "t")}
              WHERE t.id = ${end}`
        shown.push(
          new BinForkShown({
            itemId: item.id,
            forkId: fork.id,
            chatTitle: origin.chatTitle ?? "",
            name: fork.name,
            tipExcerpt: tip?.excerpt ?? "",
            deleted: fork.deleted_at !== null
          })
        )
      }
    }
    return shown
  })
