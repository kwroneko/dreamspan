// Enabling LCM on a chat and holding its backfill to what the user approved (spec/LCM.md §2.7,
// §2.11). Enabling is one transaction: the imported summary becomes the first level over the run
// it covers (or the run is just shown), the switch is written, and the backfill is recorded. It
// never generates; the next reply, or "Summarize now", plans the work.
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { tokensOf } from "../assembler/st.ts"
import type { Bin } from "./bin.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { BACKFILL_KIND, type BackfillPayload, backfillOf, capFor, spentSince } from "./lcmBackfill.ts"
import { importedSummary } from "./lcmImported.ts"
import { NotFound, StorageError, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/** The rule of `lcmPath`: a slot's effective version, none when the slot or its text is out of the context. */
const EFFECTIVE = `s.deleted_at IS NULL AND s.purged_at IS NULL AND s.context_excluded = 0
  AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status NOT IN ('generating', 'failed') AND length(v.content) > 0`

export const makeLcmEnableWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)
    const reject = (operation: string, message: string) =>
      new StorageError({ operation, reason: "constraint", message })
    const ownedChat = (userId: UserId, chatId: string, leafSlotId: string | null) =>
      Effect.gen(function* () {
        const [row] = leafSlotId
          ? yield* sql`SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
              WHERE s.id = ${leafSlotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
          : yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "chat", id: chatId })
      })
    const save = (id: string, payload: BackfillPayload) =>
      sql`UPDATE jobs SET payload_json = ${JSON.stringify(payload)}, updated_at = ${Date.now()} WHERE id = ${id}`

    return {
      EnableLcm: ({ userId, chatId, leafSlotId, choice, approved }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId, leafSlotId)
          const imported = yield* importedSummary(sql, userId, chatId, leafSlotId)
          const [existing] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM summaries
            WHERE chat_id = ${chatId} AND status IN ('complete', 'truncated')`
          const covered = imported !== null && existing!.n === 0
          if (choice === "adopt" && !covered)
            return yield* reject("EnableLcm", "This chat has no imported summary to adopt.")
          const now = Date.now()
          let unhidden = 0
          let summaryId: string | null = null
          // The run is shown again either way: adopted, its summary stands in for it; redone, the
          // summaries are made from it. A hidden slot has no effective version (spec/LCM.md §2.2).
          if (covered) {
            const shown = yield* sql<{ id: string }>`WITH RECURSIVE chain(id, parent) AS (
                SELECT id, parent_slot_id FROM slots WHERE id = ${imported.lastSlotId}
                UNION ALL SELECT s.id, s.parent_slot_id FROM slots s JOIN chain c ON s.id = c.parent
              ) UPDATE slots SET context_excluded = 0, row_version = row_version + 1
              WHERE id IN (SELECT id FROM chain) AND context_excluded = 1 RETURNING id`
            unhidden = shown.length
          }
          if (choice === "adopt" && covered) {
            summaryId = uuidv7()
            const revisionId = uuidv7()
            const [first] = yield* sql<{ depth: number }>`SELECT depth FROM slots WHERE id = ${imported.firstSlotId}`
            yield* sql`INSERT INTO summary_revisions ${sql.insert({
              id: revisionId,
              summary_id: summaryId,
              content: imported.content,
              token_count: tokensOf({ content: imported.content }),
              origin: "imported",
              created_at: now
            })}`
            yield* sql`INSERT INTO summaries ${sql.insert({
              id: summaryId,
              chat_id: chatId,
              level: 1,
              selected_revision_id: revisionId,
              first_slot_id: imported.firstSlotId,
              last_slot_id: imported.lastSlotId,
              slot_count: imported.slotCount,
              status: "complete",
              created_at: now
            })}`
            // Each slot's effective version, now that the run is shown.
            yield* sql`INSERT INTO summary_inputs (summary_id, ordinal, slot_id, version_id, amend_count)
              WITH RECURSIVE chain(id, parent, depth) AS (
                SELECT id, parent_slot_id, depth FROM slots WHERE id = ${imported.lastSlotId}
                UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN chain c ON s.id = c.parent
                  WHERE c.id <> ${imported.firstSlotId}
              ) SELECT ${summaryId}, c.depth - ${first!.depth}, c.id,
                CASE WHEN ${sql.literal(EFFECTIVE)} THEN v.id END,
                CASE WHEN ${sql.literal(EFFECTIVE)} THEN (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) ELSE 0 END
              FROM chain c JOIN slots s ON s.id = c.id LEFT JOIN versions v ON v.id = s.selected_version_id
              ORDER BY c.depth`
            yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${summaryId}`
          }
          // The switch, keeping the chat's other settings.
          const [latest] = yield* sql<{ value_json: string }>`SELECT value_json FROM state_events
            WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings'
            ORDER BY seq DESC LIMIT 1`
          const settings = latest ? (JSON.parse(latest.value_json) as Record<string, unknown>) : {}
          yield* graph.insertStateEvent(userId, chatId, null, null, null, {
            key: "lcm.settings",
            value: { ...settings, enabled: true } as never
          })
          // A previous backfill of this chat is over once the user chooses again.
          yield* sql`UPDATE jobs SET status = 'complete', updated_at = ${now}
            WHERE kind = ${BACKFILL_KIND} AND status = 'processing' AND json_extract(payload_json, '$.chatId') = ${chatId}`
          if (approved.jobs > 0) {
            const payload: BackfillPayload = {
              chatId,
              leafSlotId,
              choice,
              startedAt: now,
              armed: true,
              paused: false,
              capped: false,
              drive: false,
              approvedTokens: approved.tokens,
              approvedCost: approved.cost,
              currency: approved.currency,
              ...capFor(approved, { tokens: 0, cost: 0 })
            }
            yield* sql`INSERT INTO jobs ${sql.insert({
              id: uuidv7(),
              owner_user_id: userId,
              kind: BACKFILL_KIND,
              status: "processing",
              request_class: "background",
              payload_json: JSON.stringify(payload),
              created_at: now,
              updated_at: now
            })}`
          }
          return { unhidden, summaryId }
        }).pipe(transaction(sql, "EnableLcm")),

      SetBackfill: ({ userId, chatId, action, approved }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId, null)
          const row = yield* backfillOf(sql, chatId)
          if (!row || row.ownerUserId !== userId) return yield* new NotFound({ entity: "backfill", id: chatId })
          if (row.status === "complete") return
          const { id, ownerUserId: _owner, status: _status, ...payload } = row
          if (action === "finish") {
            yield* sql`UPDATE jobs SET status = 'complete', updated_at = ${Date.now()} WHERE id = ${id}`
          } else if (action === "pause") {
            yield* save(id, { ...payload, paused: true })
          } else if (action === "begin") {
            yield* save(id, { ...payload, armed: false })
          } else if (action === "drive") {
            yield* save(id, { ...payload, armed: false, drive: true })
          } else {
            // Continue: a new cap of 150% of what is left, counted from what has been spent.
            if (!approved) return yield* reject("SetBackfill", "Continuing needs the estimate of what is left.")
            const spent = yield* spentSince(sql, chatId, row.startedAt)
            yield* save(id, {
              ...payload,
              paused: false,
              capped: false,
              armed: false,
              approvedTokens: spent.tokens + approved.tokens,
              approvedCost:
                row.approvedCost === null || approved.cost === null ? null : (spent.cost ?? 0) + approved.cost,
              ...capFor(approved, { tokens: spent.tokens, cost: spent.cost })
            })
          }
        }).pipe(transaction(sql, "SetBackfill"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  })
