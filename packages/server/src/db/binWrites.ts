// Recycle bin write handlers (DESIGN §6.2), in the writer worker.
import type { BinLimits } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeBin, toBinItem } from "./bin.ts"
import { NotFound, WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeBinWriteHandlers = (limits: BinLimits) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const bin = makeBin(sql, limits)

    /** Runs a delete, keeps the section within its limits, and returns the new item. */
    const deleting = <E, R>(operation: string, userId: UserId, del: Effect.Effect<string, E, R>) =>
      Effect.gen(function* () {
        const itemId = yield* del
        yield* bin.evictDeleted(userId)
        return toBinItem(yield* bin.loadItem(userId, itemId))
      }).pipe(transaction(sql, operation))

    const handlers = {
      DeleteChat: ({ userId, chatId }) => deleting("DeleteChat", userId, bin.deleteChat(userId, chatId)),
      DeleteMessage: ({ userId, slotId }) => deleting("DeleteMessage", userId, bin.deleteMessage(userId, slotId)),
      DeleteBranch: ({ userId, slotId }) => deleting("DeleteBranch", userId, bin.deleteBranch(userId, slotId)),
      DeleteVersion: ({ userId, versionId }) => deleting("DeleteVersion", userId, bin.deleteVersion(userId, versionId)),
      DeleteEntity: ({ userId, entityId }) => deleting("DeleteEntity", userId, bin.deleteEntity(userId, entityId)),
      RestoreBinItem: ({ userId, itemId }) => bin.restore(userId, itemId).pipe(transaction(sql, "RestoreBinItem")),
      PurgeBinItem: ({ userId, itemId }) => bin.purge(userId, itemId).pipe(transaction(sql, "PurgeBinItem")),
      EmptyBin: ({ userId }) =>
        bin.emptyBin(userId).pipe(
          Effect.map((purged) => ({ purged })),
          transaction(sql, "EmptyBin")
        ),
      DeleteRecoveredText: ({ userId, id }) =>
        Effect.gen(function* () {
          const rows = yield* sql`DELETE FROM recovered_texts WHERE id = ${id} AND user_id = ${userId} RETURNING id`
          if (rows.length === 0) return yield* new NotFound({ entity: "recovered text", id })
        }).pipe(transaction(sql, "DeleteRecoveredText")),
      ClearRecoveredTexts: ({ userId }) =>
        sql`DELETE FROM recovered_texts WHERE user_id = ${userId} RETURNING id`.pipe(
          Effect.map((rows) => ({ deleted: rows.length })),
          transaction(sql, "ClearRecoveredTexts")
        )
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    return handlers
  })
