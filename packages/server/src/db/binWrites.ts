// Recycle bin write handlers (DESIGN §6.2), in the writer worker.
import { readBinLimits } from "./binLimits.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type Bin, toBinItem } from "./bin.ts"
import { NotFound, WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeBinWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    /** Runs a delete, keeps the section within its limits, and returns the new item. */
    const deleting = <E, R>(operation: string, userId: UserId, del: Effect.Effect<string, E, R>) =>
      Effect.gen(function* () {
        const itemId = yield* del
        yield* bin.evictDeleted(userId, itemId)
        return toBinItem(yield* bin.loadItem(userId, itemId))
      }).pipe(transaction(sql, operation))

    const handlers = {
      ChangeBinLimit: ({ userId, key, value }) =>
        Effect.gen(function* () {
          const limits = { ...(yield* readBinLimits(sql, userId)), [key]: value }
          yield* sql`INSERT INTO user_settings (user_id, key, value_json)
            VALUES (${userId}, 'bin.limits', ${JSON.stringify(limits)})
            ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json`
          return limits
        }).pipe(transaction(sql, "ChangeBinLimit")),
      DeleteChat: ({ userId, chatId }) => deleting("DeleteChat", userId, bin.deleteChat(userId, chatId)),
      DeleteMessage: ({ userId, slotId, forkId }) =>
        deleting("DeleteMessage", userId, bin.deleteMessage(userId, slotId, forkId)),
      DeleteFork: ({ userId, forkId }) => deleting("DeleteFork", userId, bin.deleteFork(userId, forkId)),
      DeleteVersion: ({ userId, versionId, forkId }) =>
        deleting("DeleteVersion", userId, bin.deleteVersion(userId, versionId, forkId)),
      DeleteEntity: ({ userId, entityId }) => deleting("DeleteEntity", userId, bin.deleteEntity(userId, entityId)),
      DeleteConnection: ({ userId, connectionId }) =>
        deleting("DeleteConnection", userId, bin.deleteConnection(userId, connectionId)),
      RestoreBinItem: ({ userId, itemId }) => bin.restore(userId, itemId).pipe(transaction(sql, "RestoreBinItem")),
      PurgeBinItem: ({ userId, itemId, expectedForkIds }) =>
        bin.purge(userId, itemId, expectedForkIds).pipe(transaction(sql, "PurgeBinItem")),
      EmptyBin: ({ userId, itemIds, expectedForkIds }) =>
        bin.emptyBin(userId, itemIds, expectedForkIds).pipe(transaction(sql, "EmptyBin")),
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
