import { recordHistoryReduction } from "./historyChanges.ts"
import { contextExcluded } from "./lcmVisibility.ts"
// Write operation handlers. They run inside the writer worker, each as one transaction.
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { cleanName, renamedTitle } from "@rp/shared/chatName.ts"
import { composerKey, type DraftKey } from "@rp/shared/drafts.ts"
import type { Bin } from "./bin.ts"
import { NotAmendable } from "@rp/shared/chatApi.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, StaleWrite, WriteOps } from "./ops.ts"
import { newChatLcmSettings, ownedModel } from "./generationSettings.ts"
import { type ChatRow, toChat, toVersion } from "./rows.ts"
import { transaction as runTransaction } from "./tx.ts"

type Count = Effect.Effect<ReadonlyArray<{ readonly n: number }>, SqlError.SqlError>

type WriteHandlers = Parameters<typeof WriteOps.of>[0]
/** Graph and chat write handlers. Library handlers are in libraryWrites.ts. */
export const makeWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const transaction = (operation: string) => runTransaction(sql, operation)
    const { drafts } = bin

    const {
      found,
      selectVersion,
      ownedChat,
      ownedSlot,
      ownedVersion,
      checkSpeaker,
      insertVersion,
      insertSlot,
      insertStateEvent,
      appendMessage
    } = makeGraphWrites(sql, drafts)

    /** A draft's target must belong to the user. */
    const draftTargets: Record<DraftKey["targetKind"], (userId: UserId, key: DraftKey) => Count> = {
      composer: (userId, key) =>
        key.field === ""
          ? sql`SELECT count(*) AS n FROM chats WHERE id = ${key.targetId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          : sql`SELECT count(*) AS n FROM slots s JOIN chats c ON c.id = s.chat_id
              WHERE s.id = ${key.field} AND c.id = ${key.targetId} AND c.owner_user_id = ${userId}
                AND s.deleted_at IS NULL AND c.deleted_at IS NULL`,
      version_edit: (userId, key) => sql`SELECT count(*) AS n FROM versions v JOIN slots s ON s.id = v.slot_id
        JOIN chats c ON c.id = s.chat_id WHERE v.id = ${key.targetId} AND c.owner_user_id = ${userId}
          AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`,
      scratchpad: (userId, key) => sql`SELECT count(*) AS n FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${key.targetId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`,
      entity_field: (userId, key) => sql`SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
        WHERE r.id = ${key.targetId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`,
      summary_edit: (userId, key) => sql`SELECT count(*) AS n FROM summaries s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${key.targetId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
    }
    const draftTarget = (userId: UserId, key: DraftKey) =>
      found(Effect.orDie(draftTargets[key.targetKind](userId, key)), key.targetKind, key.targetId)

    const handlers = {
      Ready: () => Effect.void,

      CreateChat: ({ userId, kind, status, title, participants, greeting }) =>
        Effect.gen(function* () {
          const at = Date.now()
          const chatId = uuidv7()
          const laneId = uuidv7()
          yield* sql`INSERT INTO chats ${sql.insert({ id: chatId, owner_user_id: userId, kind, status, title, created_at: at })}`
          yield* sql`INSERT INTO lanes ${sql.insert({ id: laneId, chat_id: chatId, name: "main", created_at: at })}`
          yield* insertStateEvent(userId, chatId, null, null, null, {
            key: "lcm.settings",
            value: yield* newChatLcmSettings(sql, userId)
          })
          for (const entity of participants) {
            yield* insertStateEvent(userId, chatId, null, null, null, { key: "participant.join", value: { entity } })
          }
          if (greeting) {
            yield* checkSpeaker(userId, greeting.speakerEntityId)
            const { slotId } = yield* insertSlot(chatId, laneId, null, greeting, at)
            yield* sql`UPDATE chats SET active_leaf_slot_id = ${slotId}, current_leaf_slot_id = ${slotId} WHERE id = ${chatId}`
          }
          const [row] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
          return toChat(row!)
        }).pipe(transaction("CreateChat")),

      SaveDraft: ({ userId, key, draftId, content, expectedRowVersion, expectedSession, baseRevision }) =>
        drafts
          .save({
            userId,
            key,
            draftId,
            content,
            base: expectedRowVersion === null ? null : { rowVersion: expectedRowVersion, session: expectedSession },
            baseRevision,
            checkTarget: draftTarget(userId, key)
          })
          .pipe(transaction("SaveDraft")),

      OpenComposer: ({ userId, chatId, tipSlotId, copyFrom }) =>
        Effect.gen(function* () {
          const key = composerKey(chatId, tipSlotId)
          yield* draftTarget(userId, key)
          yield* drafts.checkIdentity(userId, copyFrom)
          const from = copyFrom === null ? null : yield* drafts.findComposer(userId, chatId, copyFrom)
          if (copyFrom !== null && from === null) return yield* new NotFound({ entity: "draft", id: copyFrom })
          return yield* drafts.openComposer(userId, key, from)
        }).pipe(transaction("OpenComposer")),

      SetComposerChoice: ({ userId, chatId, draftId, speakerEntityId, replyFromEntityId, consumeReplyFromEntityId }) =>
        drafts
          .setComposerChoice(userId, chatId, draftId, {
            ...(speakerEntityId === undefined ? {} : { speakerEntityId }),
            ...(replyFromEntityId === undefined ? {} : { replyFromEntityId }),
            ...(consumeReplyFromEntityId === undefined ? {} : { consumeReplyFromEntityId })
          })
          .pipe(transaction("SetComposerChoice")),

      // Into a chat of the user's, live or in the bin: text typed as it was deleted is kept too.
      SaveComposer: ({ userId, chatId, draftId, rowVersion, session, next, operationId, content }) =>
        Effect.gen(function* () {
          yield* found(
            Effect.orDie(
              sql<{ n: number }>`SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId}`
            ),
            "chat",
            chatId
          )
          return yield* drafts.saveComposer(
            userId,
            chatId,
            { draftId, rowVersion, session, next, operationId },
            content
          )
        }).pipe(transaction("SaveComposer")),

      RestoreComposer: ({ userId, chatId, draftId, seq, expectedRowVersion, content }) =>
        drafts
          .restoreComposer(userId, chatId, draftId, seq, expectedRowVersion, content)
          .pipe(transaction("RestoreComposer")),

      RestoreDraftState: ({ userId, key, draftId, seq, expectedRowVersion, content }) =>
        drafts.restore(userId, key, draftId, seq, expectedRowVersion, content).pipe(transaction("RestoreDraftState")),

      ClearDraft: ({ userId, key, draftId, outcome, expectedRowVersion }) =>
        drafts.clear(userId, key, draftId, outcome, expectedRowVersion).pipe(transaction("ClearDraft")),

      AppendMessage: (params) => appendMessage(params).pipe(transaction("AppendMessage")),

      AddVersion: ({ userId, slotId, version, select, commitDraft }) =>
        Effect.gen(function* () {
          const at = Date.now()
          yield* ownedSlot(userId, slotId)
          yield* checkSpeaker(userId, version.speakerEntityId)
          const [next] = yield* sql<{
            n: number
          }>`SELECT coalesce(max(ordinal), -1) + 1 AS n FROM versions WHERE slot_id = ${slotId}`
          const row = yield* insertVersion(slotId, next!.n, version, at)
          if (select) {
            yield* recordHistoryReduction(sql, slotId, row.content)
            yield* sql`UPDATE slots SET selected_version_id = ${row.id}, row_version = row_version + 1 WHERE id = ${slotId}`
          }
          yield* drafts.commit(userId, commitDraft, {
            targetKind: "version_edit",
            targetId: version.sourceVersionId ?? "",
            content: row.content
          })
          return toVersion(row)
        }).pipe(transaction("AddVersion")),

      SelectVersion: ({ userId, slotId, versionId, expectedRowVersion }) =>
        selectVersion(userId, slotId, versionId, expectedRowVersion).pipe(
          Effect.map(({ rowVersion }) => ({ rowVersion })),
          transaction("SelectVersion")
        ),

      SetSlotHidden: ({ userId, slotId, hidden }) =>
        Effect.gen(function* () {
          yield* ownedSlot(userId, slotId)
          // What the context reads: a staged LCM unhide shows a slot whose flag is still set.
          const [row] = yield* sql<{ raw: number; effective: number }>`
            SELECT s.context_excluded AS raw, ${sql.literal(contextExcluded("s"))} AS effective
            FROM slots s WHERE s.id = ${slotId}`
          if ((row!.effective === 1) === hidden) return { changed: false }
          const flag = hidden ? 1 : 0
          // Setting the flag ends a staged unhide's overlay (lcm_enable_explicit_visibility),
          // and a hide records a history reduction (history_reduced_slot) for stepped history.
          yield* sql`UPDATE slots SET context_excluded = ${flag}, hidden_by_user = ${flag},
            row_version = row_version + 1 WHERE id = ${slotId}`
          // Hidden under the overlay, the flag was set already, so the trigger saw no change.
          if (hidden && row!.raw === 1)
            yield* sql`INSERT INTO history_changes SELECT id, chat_id, depth, 1 FROM slots WHERE id = ${slotId}
              ON CONFLICT(slot_id) DO UPDATE SET revision = revision + 1`
          return { changed: true }
        }).pipe(transaction("SetSlotHidden")),

      AddStateEvent: ({ userId, chatId, slotId, versionId, scope, data }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId)
          if (slotId !== null) {
            yield* found(
              sql`SELECT count(*) AS n FROM slots WHERE id = ${slotId} AND chat_id = ${chatId} AND deleted_at IS NULL`,
              "slot",
              slotId
            )
          }
          if (versionId !== null) {
            yield* found(
              sql`SELECT count(*) AS n FROM versions WHERE id = ${versionId} AND slot_id IS ${slotId} AND deleted_at IS NULL`,
              "version",
              versionId
            )
          }
          return yield* insertStateEvent(userId, chatId, slotId, versionId, scope, data)
        }).pipe(transaction("AddStateEvent")),

      // --- Chats

      AddSelectedVersion: ({ userId, slotId, version, expectedRowVersion, model, commitDraft }) =>
        Effect.gen(function* () {
          const slot = yield* ownedSlot(userId, slotId)
          if (slot.row_version !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "slot",
              id: slotId,
              expected: expectedRowVersion,
              actual: slot.row_version
            })
          }
          yield* checkSpeaker(userId, version.speakerEntityId)
          if (model && (version.writer !== "model" || !(yield* ownedModel(sql, userId, model.connection, model.model))))
            return yield* new NotFound({ entity: "model", id: model.model })
          const [next] = yield* sql<{
            n: number
          }>`SELECT coalesce(max(ordinal), -1) + 1 AS n FROM versions WHERE slot_id = ${slotId}`
          const inserted = yield* insertVersion(slotId, next!.n, version, Date.now())
          // The model chosen for it shows from the start; its rollout records the same one.
          if (model)
            yield* sql`UPDATE versions SET connection_id = ${model.connection}, model_id = ${model.model}
              WHERE id = ${inserted.id}`
          const row = model ? yield* ownedVersion(userId, inserted.id as VersionId, true) : inserted
          yield* recordHistoryReduction(sql, slotId, row.content)
          yield* sql`UPDATE slots SET selected_version_id = ${row.id}, row_version = row_version + 1 WHERE id = ${slotId}`
          if (version.origin === "generated")
            yield* sql`UPDATE chats SET current_leaf_slot_id = ${slotId} WHERE id = ${slot.chat_id}`
          // An edit's text was typed into the edit of its source; a version of one's own, into the slot's.
          yield* drafts.commit(
            userId,
            commitDraft ?? null,
            version.sourceVersionId
              ? { targetKind: "version_edit", targetId: version.sourceVersionId, content: row.content }
              : { targetKind: "scratchpad", targetId: slotId, content: row.content }
          )
          return { chatId: slot.chat_id as ChatId, version: toVersion(row) }
        }).pipe(transaction("AddSelectedVersion")),

      AmendVersion: ({ userId, versionId, content, expectedRowVersion, commitDraft }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          if (row.writer !== "human") return yield* new NotAmendable({ versionId })
          const rowVersion = 1 + (row.amend_count ?? 0)
          if (rowVersion !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "version",
              id: versionId,
              expected: expectedRowVersion,
              actual: rowVersion
            })
          }
          yield* drafts.commit(userId, commitDraft ?? null, {
            targetKind: "version_edit",
            targetId: versionId,
            content
          })
          if (content === row.content) return toVersion(row)
          // The trigger keeps the previous text in version_history (DESIGN §3.1).
          yield* recordHistoryReduction(sql, row.slot_id, content, versionId)
          yield* sql`UPDATE versions SET content = ${content}, updated_at = ${Date.now()} WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, true))
        }).pipe(transaction("AmendVersion")),

      SaveGeneration: ({ userId, versionId, content, reasoning, status, error }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, false)
          // A version deleted for good stays empty, whatever was still generating into it.
          if (row.writer !== "model" || row.status !== "generating" || row.purged_at !== null) {
            return yield* new NotFound({ entity: "generating version", id: versionId })
          }
          yield* recordHistoryReduction(sql, row.slot_id, content, versionId)
          yield* sql`UPDATE versions SET content = ${content}, status = ${status},
            reasoning = CASE WHEN ${reasoning === undefined ? 1 : 0} THEN reasoning ELSE ${reasoning || null} END,
            error_json = ${error === null ? null : JSON.stringify(error)}, updated_at = ${Date.now()}
            WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, false))
        }).pipe(transaction("SaveGeneration")),

      SetVersionFlags: ({ userId, versionId, starred, hidden }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          const flag = (value: boolean | undefined, now: number) => (value === undefined ? now : value ? 1 : 0)
          yield* sql`UPDATE versions SET starred = ${flag(starred, row.starred)}, hidden = ${flag(hidden, row.hidden)}
            WHERE id = ${versionId}`
          const [slot] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM slots WHERE id = ${row.slot_id}`
          return {
            chatId: slot!.chat_id as ChatId,
            version: toVersion(yield* ownedVersion(userId, versionId, true))
          }
        }).pipe(transaction("SetVersionFlags")),

      MarkVersion: ({ userId, versionId, mark }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          if (row.writer !== "model" || row.status !== "complete" || row.purged_at !== null)
            return yield* new NotFound({ entity: "version", id: versionId })
          yield* sql`UPDATE versions SET mark = ${mark} WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, true))
        }).pipe(transaction("MarkVersion")),

      RenameChats: ({ userId, chats, name }) =>
        Effect.gen(function* () {
          const renamed: Array<ReturnType<typeof toChat>> = []
          for (const { chatId, from } of chats) {
            const chat = yield* ownedChat(userId, chatId)
            if (from !== null && chat.title !== from) continue
            const [row] = yield* sql<ChatRow>`
              UPDATE chats SET title = ${renamedTitle(chat.title, name)}, title_source = 'user',
                row_version = row_version + 1
              WHERE id = ${chatId} RETURNING *`
            renamed.push(toChat(row!))
          }
          return renamed
        }).pipe(transaction("RenameChats")),

      // --- Branches (DESIGN §3.2)

      SetBranchName: ({ userId, slotId, name }) =>
        Effect.gen(function* () {
          yield* ownedSlot(userId, slotId)
          const clean = cleanName(name)
          yield* sql`UPDATE slots SET branch_name = ${clean === "" ? null : clean}, branch_name_user = 1,
            row_version = row_version + 1 WHERE id = ${slotId}`
        }).pipe(transaction("SetBranchName")),

      SetActiveLeaf: ({ userId, chatId, slotId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const chat = yield* ownedChat(userId, chatId)
          if (chat.row_version !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "chat",
              id: chatId,
              expected: expectedRowVersion,
              actual: chat.row_version
            })
          }
          yield* found(
            sql`SELECT count(*) AS n FROM slots WHERE id = ${slotId} AND chat_id = ${chatId} AND deleted_at IS NULL`,
            "slot",
            slotId
          )
          const [row] = yield* sql<ChatRow>`
            UPDATE chats SET active_leaf_slot_id = ${slotId}, row_version = row_version + 1
            WHERE id = ${chatId} RETURNING *`
          return toChat(row!)
        }).pipe(transaction("SetActiveLeaf"))
    } satisfies Partial<WriteHandlers>
    return handlers
  })
