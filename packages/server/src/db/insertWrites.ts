// Inserting a message anywhere in a fork's history (spec/MESSAGE-INSERT.md §2.4, §7; owner
// decision DESIGN §3.1, 2026-10-30). The message is an ordinary slot below its anchor, marked
// inserted, and an `insert` override places it in the fork; forks made from that fork later
// inherit it, and no other fork shows it (displayPath.ts). One writer transaction.
import type { SlotId } from "@rp/shared/chat.ts"
import { NewVersion } from "@rp/shared/chat.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { onDisplayPath, pathPieces, positionOf, slotPlace } from "./displayPath.ts"
import { selectionIn, shownIn, slotDeletedIn, versionAsShown, writeInsert } from "./forkState.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { extendStretches } from "./stretches.ts"
import { presenceAt, presenceJson } from "./participation.ts"
import { InsertRefused } from "@rp/shared/messagesApi.ts"
import { InsertResult, NotFound, StaleWrite, type WriteOps } from "./ops.ts"
import { type ChatRow, toChat, toVersion } from "./rows.ts"
import { transaction } from "./tx.ts"

/**
 * The columns a duplicate takes from the version it copies (spec §2.2): what it says and who
 * wrote it, with what. Its generation (rollout, usage, error), flags, history and source stay
 * behind: it wasn't generated here. A model-written copy is frozen like one.
 */
const copied = [
  "status",
  "speaker_entity_id",
  "writer",
  "content",
  "context_form",
  "display_form",
  "reasoning",
  "reply_sections",
  "macro_mode",
  "frozen_macros",
  "connection_id",
  "model_id",
  "recorded_model_json"
].join(", ")

type Handlers = Parameters<typeof WriteOps.of>[0]

export const makeInsertWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)

    return {
      InsertMessage: ({ userId, chatId, forkId, anchorSlotId, expectedRowVersion, body }) =>
        Effect.gen(function* () {
          const at = Date.now()
          yield* graph.ownedChat(userId, chatId)
          const fork = yield* graph.ownedFork(userId, chatId, forkId)

          // The anchor: shown in the fork and not deleted there. A neighbour inserted meanwhile
          // is no conflict; the new message still goes directly below the anchor.
          let anchor: { id: string; depth: number } | null = null
          if (anchorSlotId !== null) {
            const [row] = yield* sql<{ id: string; depth: number; row_version: number }>`
              SELECT id, depth, row_version FROM slots WHERE id = ${anchorSlotId} AND chat_id = ${chatId}`
            if (!row) return yield* new NotFound({ entity: "slot", id: anchorSlotId })
            const place = (yield* slotPlace(sql, chatId, anchorSlotId))!
            const shown = onDisplayPath(yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id), place)
            const [deleted] = yield* sql<{ n: number }>`
              SELECT count(*) AS n FROM slots s WHERE s.id = ${anchorSlotId} AND ${slotDeletedIn(sql, fork.id, "s")}`
            if (!shown || deleted!.n > 0) {
              const selection = yield* selectionIn(sql, fork.id, anchorSlotId)
              return yield* new StaleWrite({
                entity: "slot",
                id: anchorSlotId,
                expected: expectedRowVersion,
                actual: row.row_version + (selection?.seq ?? 0)
              })
            }
            anchor = row
          }

          let slotId: string
          let versionId: string
          if (body._tag !== "Duplicate") {
            yield* graph.checkSpeaker(userId, body.speaker)
            // Written: a finished human version. Generated: a model version still being written,
            // as a swipe's is; the API starts its generation once this commits.
            const version =
              body._tag === "Write"
                ? new NewVersion({
                    speakerEntityId: body.speaker,
                    writer: "human",
                    content: body.content,
                    ...(body.images !== undefined ? { images: body.images } : {}),
                    status: "complete",
                    macroMode: "verbatim",
                    origin: "user_written"
                  })
                : new NewVersion({
                    speakerEntityId: body.speaker,
                    writer: "model",
                    content: "",
                    status: "generating",
                    macroMode: "verbatim",
                    origin: "generated",
                    ...(body.direction?.trim() ? { direction: body.direction } : {})
                  })
            const inserted = yield* graph.insertSlot(chatId, anchor, version, at, fork.id, [], 0, true)
            slotId = inserted.slotId
            versionId = inserted.version.id
          } else {
            // The version the fork shows at the anchor: its own, or the fork's copy in its place.
            const [source] =
              anchor === null
                ? []
                : yield* sql<{ id: string; status: string }>`
                    SELECT v.id, v.status FROM versions v JOIN slots s ON s.id = v.slot_id
                    WHERE v.id = ${body.versionId} AND s.id = ${anchor.id} AND v.deleted_at IS NULL
                      AND v.purged_at IS NULL`
            if (!source) return yield* new NotFound({ entity: "version", id: body.versionId })
            const [shown] = yield* sql<{ id: string }>`SELECT ${shownIn(sql, fork.id, "s")} AS id FROM slots s
              WHERE s.id = ${anchor!.id}`
            if (shown!.id !== source.id) {
              const selection = (yield* selectionIn(sql, fork.id, anchor!.id))!
              const [row] = yield* sql<{ row_version: number }>`SELECT row_version FROM slots WHERE id = ${anchor!.id}`
              return yield* new StaleWrite({
                entity: "slot",
                id: anchor!.id,
                expected: expectedRowVersion,
                actual: row!.row_version + selection.seq
              })
            }
            if (source.status === "generating" || source.status === "failed")
              return yield* new InsertRefused({
                message:
                  source.status === "generating"
                    ? "This version is still being written. Duplicate it once it's finished."
                    : "A failed version has nothing to duplicate."
              })
            slotId = uuidv7()
            versionId = uuidv7()
            yield* sql`INSERT INTO version_records (id, slot_id, ordinal, origin, authoring_fork_id, created_at, updated_at, ${sql.literal(copied)})
              SELECT ${versionId}, ${slotId}, 0, 'duplicate', ${fork.id}, ${at}, ${at}, ${sql.literal(copied)}
              FROM version_records WHERE id = ${source.id}`
            yield* sql`INSERT INTO version_attachments (version_id, ordinal, media_id, kind, alt_text)
              SELECT ${versionId}, ordinal, media_id, kind, alt_text FROM version_attachments WHERE version_id = ${source.id}`
            yield* sql`INSERT INTO slots ${sql.insert({
              id: slotId,
              chat_id: chatId,
              parent_slot_id: anchor!.id,
              depth: anchor!.depth + 1,
              selected_version_id: versionId,
              fork_id: fork.id,
              created_at: at,
              inserted: 1
            })}`
            const there = yield* presenceAt(sql, chatId, anchor!.id, fork.id)
            yield* sql`UPDATE version_records SET cast_json = ${JSON.stringify(there.cast)},
              presence_json = ${presenceJson(there.presence)} WHERE id = ${versionId}`
          }

          yield* writeInsert(sql, { id: fork.id, chatId }, slotId, 1)
          // Inside a separate join's parallel stretch, it is part of it (spec/THREADS.md §7.3).
          if (anchorSlotId !== null) yield* extendStretches(sql, chatId, fork, anchorSlotId, slotId)
          // The editor's draft, if it still holds what was inserted (§3.10).
          if (body._tag !== "Duplicate" && body.draft !== undefined)
            yield* bin.drafts.commit(userId, body.draft, {
              targetKind: "insert",
              targetId: chatId,
              matchesField: (_, field) => field === `${fork.id}:${anchorSlotId ?? ""}`,
              content: body._tag === "Write" ? body.content : (body.direction ?? "")
            })
          // Inserting adds a message: the fork is chatted in (ARCHITECTURE §3.8).
          yield* graph.chatIn(fork.id, at)
          const [chat] = yield* sql<ChatRow>`
            UPDATE chats SET last_message_at = ${at},
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              row_version = row_version + 1
            WHERE id = ${chatId} RETURNING *`
          const [tip] = yield* sql<{ tip: string | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${fork.id}`
          const pieces = yield* pathPieces(sql, chatId, fork.id, tip!.tip)
          const position = positionOf(pieces, (yield* slotPlace(sql, chatId, slotId))!)!
          return new InsertResult({
            slotId: slotId as SlotId,
            forkId: fork.id as InsertResult["forkId"],
            position,
            version: toVersion((yield* versionAsShown(sql, fork.id, versionId))!),
            chat: toChat(chat!)
          })
        }).pipe(transaction(sql, "InsertMessage"))
    } satisfies Partial<Handlers>
  })
