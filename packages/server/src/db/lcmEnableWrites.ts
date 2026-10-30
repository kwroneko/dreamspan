import { eventApplies, forkAt } from "./forkState.ts"
// Enabling LCM on a chat and holding its backfill to what the user approved (spec/LCM.md §2.7,
// §2.11). Bounded preparation precedes one publication transaction: the imported summary becomes the first level over the run
// it covers (or the run is just shown), the switch is written, and the backfill is recorded. It
// never generates; the next reply, or "Summarize now", plans the work.
import type { UserId } from "@rp/shared/domain.ts"
import {
  imageExcludedIn,
  inFork,
  nextSeq,
  originalSql,
  shownIn,
  shownVersionDeletedIn,
  slotDeletedIn,
  viewAt
} from "./forkState.ts"
import { gatheredImages } from "./lcmImages.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { tokensOf } from "../assembler/st.ts"
import type { Bin } from "./bin.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { BACKFILL_KIND, type BackfillPayload, backfillOf, capFor, spentSince } from "./lcmBackfill.ts"
import type { ImportedSummary } from "./lcmImported.ts"
import { NotFound, StorageError, type WriteOps } from "./ops.ts"
import { LcmSettingsInvalid } from "@rp/shared/lcm.ts"
import { transaction } from "./tx.ts"

/** Why settings with a target at or above its maximum can't be stored, or null. */
export const orderProblem = (s: Record<string, unknown>) => {
  const over = (target: string, max: string) =>
    typeof s[target] === "number" && typeof s[max] === "number" && (s[target] as number) >= (s[max] as number)
  return over("recentTarget", "recentMax")
    ? `The recent messages' target (${(s.recentTarget as number).toLocaleString("en-US")}) must be below their maximum (${(s.recentMax as number).toLocaleString("en-US")}).`
    : over("layerTarget", "layerMax")
      ? `The summary block's target (${(s.layerTarget as number).toLocaleString("en-US")}) must be below its maximum (${(s.layerMax as number).toLocaleString("en-US")}).`
      : null
}

/** The effective version after the covered run is shown; deleted/failed text still has none. */
const effective = (sql: SqlClient.SqlClient, fork: string | null) =>
  sql`NOT ${slotDeletedIn(sql, fork, "s")} AND NOT ${shownVersionDeletedIn(sql, fork, "v")}
    AND v.status NOT IN ('generating', 'failed') AND length(v.content) > 0`

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
      StageLcmEnable: ({ userId, chatId, leafSlotId, forkId, choice, approved, imported, runId }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId, leafSlotId)
          if (!runId) {
            if (choice === "adopt" && !imported)
              return yield* reject("StageLcmEnable", "This chat has no imported summary to adopt.")
            yield* sql`UPDATE lcm_enable_runs SET phase = 'cancelled' WHERE chat_id = ${chatId} AND published = 0 AND phase <> 'cancelled'`
            const id = uuidv7()
            const targetForkId = yield* viewAt(sql, chatId, leafSlotId)
            yield* sql`INSERT INTO lcm_enable_runs(id, chat_id, payload_json, cursor, phase)
              VALUES (${id}, ${chatId}, ${JSON.stringify({ leafSlotId, choice, approved, imported, forkId: targetForkId })},
                ${imported?.lastSlotId ?? null}, ${imported ? "gather" : "ready"})`
            return { runId: id, ready: !imported }
          }
          const [run] = yield* sql<{
            payload_json: string
            cursor: string | null
            gathered: number
            copied: number
            phase: string
            images_json: string | null
          }>`
            SELECT * FROM lcm_enable_runs WHERE id = ${runId} AND chat_id = ${chatId} AND published = 0`
          if (!run || run.phase === "cancelled") return yield* new NotFound({ entity: "enable run", id: runId })
          const payload = JSON.parse(run.payload_json) as { imported: ImportedSummary; choice: string; forkId: string }
          if (payload.forkId !== (yield* viewAt(sql, chatId, leafSlotId)))
            return yield* reject("StageLcmEnable", "The enable fork changed.")
          const source = payload.imported
          if (run.phase === "gather") {
            // The range as the fork it was offered in shows it.
            const fork = yield* viewAt(sql, chatId, leafSlotId)
            const rows = yield* sql<{
              id: string
              parent: string | null
              depth: number
              version_id: string | null
              amend_count: number
              merged: number
              generating: number
              images_json: string | null
              withheld_json: string | null
              attached: number
            }>`
              WITH RECURSIVE chain(id, parent, depth, n) AS (
                SELECT id, parent_slot_id, depth, 1 FROM slots WHERE id = ${run.cursor} AND chat_id = ${chatId}
                UNION ALL SELECT s.id, s.parent_slot_id, s.depth, c.n + 1 FROM slots s JOIN chain c ON s.id = c.parent WHERE c.n < 500
              ) SELECT c.id, c.parent, c.depth,
                CASE WHEN ${effective(sql, fork)} THEN v.id END AS version_id,
                CASE WHEN ${effective(sql, fork)} THEN (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) ELSE 0 END AS amend_count,
                EXISTS(SELECT 1 FROM slot_parents p WHERE p.slot_id = c.id) AS merged,
                coalesce(v.status = 'generating', 0) AS generating,
                CASE WHEN ${effective(sql, fork)} THEN (SELECT json_group_array(a.media_id) FROM (SELECT media_id FROM version_attachments
                  WHERE version_id = v.id AND NOT ${imageExcludedIn(sql, fork, `(${originalSql("v")})`, "media_id")} ORDER BY ordinal) a) END AS images_json,
                CASE WHEN ${effective(sql, fork)} THEN (SELECT json_group_array(a.media_id) FROM (SELECT media_id FROM version_attachments
                  WHERE version_id = v.id AND ${imageExcludedIn(sql, fork, `(${originalSql("v")})`, "media_id")} ORDER BY ordinal) a) END AS withheld_json,
                CASE WHEN ${effective(sql, fork)} THEN EXISTS(SELECT 1 FROM version_attachments a WHERE a.version_id = v.id) ELSE 0 END AS attached
              FROM chain c JOIN slots s ON s.id = c.id LEFT JOIN versions v ON v.id = ${shownIn(sql, fork, "s")}
              ORDER BY c.depth DESC`
            if (
              !rows.length ||
              rows.some((r, n) => r.depth !== source.slotCount - 1 - run.gathered - n || r.merged || r.generating)
            )
              return yield* reject("StageLcmEnable", "The imported range changed. Review the offer again.")
            yield* sql`INSERT INTO lcm_enable_slots ${sql.insert(rows.map((r) => ({ run_id: runId, ordinal: r.depth, slot_id: r.id, version_id: r.version_id, amend_count: r.amend_count })))}`
            // The images the imported summary is taken as written with: what this fork sends for its range.
            if (run.images_json !== null || rows.some((r) => r.attached)) {
              const earlier = rows.toReversed()
              const list = (json: string | null) => (json ? (JSON.parse(json) as Array<string>) : [])
              const images = gatheredImages(
                run.images_json,
                earlier.flatMap((r) => list(r.images_json)),
                earlier.flatMap((r) => list(r.withheld_json))
              )
              yield* sql`UPDATE lcm_enable_runs SET images_json = ${images} WHERE id = ${runId}`
            }
            const last = rows.at(-1)!
            const gathered = run.gathered + rows.length
            if (gathered === source.slotCount && (last.id !== source.firstSlotId || last.parent !== null))
              return yield* reject("StageLcmEnable", "The imported range changed.")
            yield* sql`UPDATE lcm_enable_runs SET cursor = ${last.parent}, gathered = ${gathered},
              phase = ${gathered === source.slotCount ? (payload.choice === "adopt" ? "create" : "ready") : "gather"} WHERE id = ${runId}`
          } else if (run.phase === "create") {
            yield* sql`UPDATE lcm_enable_runs SET phase = 'copy' WHERE id = ${runId}`
            const revisionId = uuidv7(),
              now = Date.now()
            yield* sql`INSERT INTO summary_revisions ${sql.insert({
              id: revisionId,
              summary_id: runId,
              content: source.content,
              token_count: tokensOf({ content: source.content }),
              origin: "imported",
              created_at: now
            })}`
            yield* sql`INSERT INTO summaries ${sql.insert({
              id: runId,
              chat_id: chatId,
              level: 1,
              selected_revision_id: revisionId,
              first_slot_id: source.firstSlotId,
              last_slot_id: source.lastSlotId,
              slot_count: source.slotCount,
              status: "complete",
              created_at: now,
              images_json: run.images_json
            })}`
          } else if (run.phase === "copy") {
            yield* sql`INSERT INTO summary_inputs(summary_id, ordinal, slot_id, version_id, amend_count)
              SELECT run_id, ordinal, slot_id, version_id, amend_count FROM lcm_enable_slots
              WHERE run_id = ${runId} AND ordinal >= ${run.copied} ORDER BY ordinal LIMIT 500`
            const copied = Math.min(source.slotCount, run.copied + 500)
            yield* sql`UPDATE lcm_enable_runs SET copied = ${copied}, phase = ${copied === source.slotCount ? "ready" : "copy"} WHERE id = ${runId}`
          }
          const [updated] = yield* sql<{ phase: string }>`SELECT phase FROM lcm_enable_runs WHERE id = ${runId}`
          return { runId, ready: updated!.phase === "ready" }
        }).pipe(inFork(sql, chatId, forkId, leafSlotId), transaction(sql, "StageLcmEnable")),

      ChangeLcmSettings: ({ userId, chatId, change, forkId }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId, null)
          const [latest] = yield* sql<{ value_json: string }>`SELECT value_json FROM state_events e
            WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' AND ${eventApplies(sql, forkId ?? (yield* forkAt(sql, chatId, null)), "e")}
            ORDER BY seq DESC LIMIT 1`
          const settings: Record<string, unknown> = latest
            ? (JSON.parse(latest.value_json) as Record<string, unknown>)
            : { enabled: false }
          for (const [key, value] of Object.entries(change)) {
            if (value === undefined) continue
            if (value === null) delete settings[key]
            else settings[key] = value
          }
          const problem = orderProblem(settings)
          if (problem) return yield* new LcmSettingsInvalid({ message: problem })
          yield* graph.insertStateEvent(
            userId,
            chatId,
            null,
            null,
            null,
            {
              key: "lcm.settings",
              value: settings as never
            },
            forkId ?? null
          )
        }).pipe(transaction(sql, "ChangeLcmSettings")),

      EnableLcm: ({ userId, chatId, leafSlotId, forkId, choice, approved, runId, switchOff }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId, leafSlotId)
          let unhidden = 0
          let summaryId: string | null = null
          if (runId) {
            const [run] = yield* sql<{ payload_json: string; phase: string }>`SELECT * FROM lcm_enable_runs
              WHERE id = ${runId} AND chat_id = ${chatId} AND published = 0`
            if (!run || run.phase !== "ready")
              return yield* reject("EnableLcm", "The imported range is still being prepared.")
            const payload = JSON.parse(run.payload_json) as {
              imported: ImportedSummary | null
              choice: string
              leafSlotId: string
              forkId: string
            }
            if (
              payload.choice !== choice ||
              payload.leafSlotId !== leafSlotId ||
              payload.forkId !== (yield* viewAt(sql, chatId, leafSlotId))
            )
              return yield* reject("EnableLcm", "The enable choice changed.")
            unhidden = payload.imported?.hidden ?? 0
            if (choice === "adopt") {
              summaryId = runId
              yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${summaryId}`
            }
            const seq = yield* nextSeq(sql, chatId)
            yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, flag)
              VALUES (${uuidv7()}, ${chatId}, ${payload.forkId}, ${seq}, 'hide_range', ${runId}, 0)`
            yield* sql`UPDATE lcm_enable_runs SET published = 1 WHERE id = ${runId}`
          } else if (choice === "adopt") return yield* reject("EnableLcm", "Adoption needs a prepared range.")
          const now = Date.now()
          // The switch, keeping the chat's other settings.
          const [latest] = yield* sql<{ value_json: string }>`SELECT value_json FROM state_events e
            WHERE chat_id = ${chatId} AND slot_id IS NULL AND scope IS NULL AND key = 'lcm.settings' AND ${eventApplies(sql, forkId ?? (yield* forkAt(sql, chatId, leafSlotId)), "e")}
            ORDER BY seq DESC LIMIT 1`
          const settings = latest ? (JSON.parse(latest.value_json) as Record<string, unknown>) : {}
          yield* graph.insertStateEvent(
            userId,
            chatId,
            null,
            null,
            null,
            {
              key: "lcm.settings",
              value: { ...settings, enabled: true } as never
            },
            forkId ?? (yield* forkAt(sql, chatId, leafSlotId))
          )
          // The imported summary note goes off with it, visibly: an ordinary switch at the leaf (DESIGN §8 [P]).
          for (const note of switchOff ?? [])
            yield* graph.insertStateEvent(
              userId,
              chatId,
              leafSlotId,
              null,
              null,
              {
                key: "note.deactivate",
                value: { note }
              },
              forkId ?? null
            )
          // A previous backfill of this chat is over once the user chooses again.
          yield* sql`UPDATE jobs SET status = 'complete', updated_at = ${now}
            WHERE kind = ${BACKFILL_KIND} AND status = 'processing' AND json_extract(payload_json, '$.chatId') = ${chatId}
              AND coalesce(json_extract(payload_json,'$.forkId'),(SELECT current_fork_id FROM chats WHERE id=${chatId})) IS ${yield* viewAt(sql, chatId, leafSlotId)}`
          if (approved.jobs > 0) {
            const payload: BackfillPayload = {
              chatId,
              forkId: yield* viewAt(sql, chatId, leafSlotId),
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
        }).pipe(inFork(sql, chatId, forkId, leafSlotId), transaction(sql, "EnableLcm")),

      SetBackfill: ({ userId, chatId, forkId, action, approved }) =>
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
            const spent = yield* spentSince(sql, chatId, row.startedAt, row.forkId)
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
        }).pipe(inFork(sql, chatId, forkId, null), transaction(sql, "SetBackfill"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  })
