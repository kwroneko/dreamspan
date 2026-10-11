// Write operation handlers. They run inside the writer worker, each as one transaction.
import type { ChatId, EntityId, NewVersion, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { FoldableEvent, StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { composerKey, type DraftKey } from "@rp/shared/drafts.ts"
import type { Bin } from "./bin.ts"
import { NotAmendable } from "@rp/shared/chatApi.ts"
import { AppendResult, LeafMoved, NotFound, StaleWrite, WriteOps } from "./ops.ts"
import { amendCount, type ChatRow, toChat, toVersion, type VersionRow } from "./rows.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { transaction as runTransaction } from "./tx.ts"

type Count = Effect.Effect<ReadonlyArray<{ readonly n: number }>, SqlError.SqlError>

type WriteHandlers = Parameters<typeof WriteOps.of>[0]
/** Graph and chat write handlers. Library handlers are in libraryWrites.ts. */
export const makeWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const transaction = (operation: string) => runTransaction(sql, operation)
    const { drafts } = bin

    /** Fails with NotFound unless `query` counts exactly one row. */
    const found = <E>(query: Effect.Effect<ReadonlyArray<{ readonly n: number }>, E>, entity: string, id: string) =>
      Effect.flatMap(query, ([row]) => (row?.n === 1 ? Effect.void : Effect.fail(new NotFound({ entity, id }))))

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

    const ownedChat = (userId: UserId, chatId: ChatId) =>
      sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))
        )
      )

    const ownedSlot = (userId: UserId, slotId: SlotId) =>
      sql<{ id: string; chat_id: string; row_version: number }>`
      SELECT s.id, s.chat_id, s.row_version FROM slots s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "slot", id: slotId }))
        )
      )

    /** A version of the user's, with its amend count; `live` also refuses one in the bin. */
    const ownedVersion = (userId: UserId, versionId: VersionId, live: boolean) =>
      sql<VersionRow>`
      SELECT v.*, ${sql.literal(amendCount("v"))} FROM versions v JOIN slots s ON s.id = v.slot_id
        JOIN chats c ON c.id = s.chat_id
      WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
        AND (${live ? 0 : 1} OR (v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL))`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "version", id: versionId }))
        )
      )

    const checkSpeaker = (userId: UserId, speaker: EntityId | null) =>
      speaker === null
        ? Effect.void
        : found(
            sql`SELECT count(*) AS n FROM entities WHERE id = ${speaker} AND owner_user_id = ${userId} AND deleted_at IS NULL`,
            "entity",
            speaker
          )

    /** An edit's source is a live version of the same slot, so a new slot's first version has none. */
    const checkSource = (slotId: string, source: VersionId | undefined) =>
      source === undefined
        ? Effect.void
        : found(
            sql`SELECT count(*) AS n FROM versions WHERE id = ${source} AND slot_id = ${slotId} AND deleted_at IS NULL`,
            "version",
            source
          )

    const insertVersion = (slotId: string, ordinal: number, version: NewVersion, at: number) =>
      Effect.andThen(
        checkSource(slotId, version.sourceVersionId),
        sql<VersionRow>`INSERT INTO versions ${sql.insert({
          id: uuidv7(),
          slot_id: slotId,
          ordinal,
          status: version.status,
          speaker_entity_id: version.speakerEntityId,
          writer: version.writer,
          content: version.content,
          macro_mode: version.macroMode,
          origin: version.origin,
          source_version_id: version.sourceVersionId ?? null,
          direction: version.direction ?? null,
          error_json: version.error ? JSON.stringify(version.error) : null,
          created_at: at,
          updated_at: at
        })} RETURNING *`.pipe(Effect.map(([row]) => row!))
      )

    const insertSlot = (
      chatId: string,
      laneId: string,
      parent: { id: string; depth: number } | null,
      version: NewVersion,
      at: number
    ) =>
      Effect.gen(function* () {
        const slotId = uuidv7()
        const row = yield* insertVersion(slotId, 0, version, at)
        yield* sql`INSERT INTO slots ${sql.insert({
          id: slotId,
          chat_id: chatId,
          lane_id: laneId,
          parent_slot_id: parent?.id ?? null,
          depth: parent ? parent.depth + 1 : 0,
          selected_version_id: row.id,
          created_at: at
        })}`
        return { slotId, version: row }
      })

    /** A user's state change, after checking everything its value names. */
    const insertStateEvent = (
      userId: UserId,
      chatId: string,
      slotId: string | null,
      versionId: string | null,
      scope: FoldableEvent["scope"],
      data: StateEventData
    ) =>
      Effect.gen(function* () {
        yield* checkStateReferences(sql, userId, chatId, data, scope)
        const [next] = yield* sql<{ n: number }>`
          SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${chatId} AND slot_id IS ${slotId}`
        const id = uuidv7()
        yield* sql`INSERT INTO state_events ${sql.insert({
          id,
          chat_id: chatId,
          slot_id: slotId,
          version_id: versionId,
          seq: next!.n,
          key: data.key,
          scope,
          value_json: JSON.stringify(data.value),
          origin: "user",
          created_at: Date.now()
        })}`
        return { id, seq: next!.n }
      })

    const handlers = {
      Ready: () => Effect.void,

      CreateChat: ({ userId, kind, status, title, participants, greeting }) =>
        Effect.gen(function* () {
          const at = Date.now()
          const chatId = uuidv7()
          const laneId = uuidv7()
          yield* sql`INSERT INTO chats ${sql.insert({ id: chatId, owner_user_id: userId, kind, status, title, created_at: at })}`
          yield* sql`INSERT INTO lanes ${sql.insert({ id: laneId, chat_id: chatId, name: "main", created_at: at })}`
          for (const entity of participants) {
            yield* insertStateEvent(userId, chatId, null, null, null, { key: "participant.join", value: { entity } })
          }
          if (greeting) {
            yield* checkSpeaker(userId, greeting.speakerEntityId)
            const { slotId } = yield* insertSlot(chatId, laneId, null, greeting, at)
            yield* sql`UPDATE chats SET active_leaf_slot_id = ${slotId} WHERE id = ${chatId}`
          }
          const [row] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
          return toChat(row!)
        }).pipe(transaction("CreateChat")),

      SaveDraft: ({ userId, key, content, expectedRowVersion, baseRevision }) =>
        drafts
          .save({ userId, key, content, expectedRowVersion, baseRevision, checkTarget: draftTarget(userId, key) })
          .pipe(transaction("SaveDraft")),

      CopyComposer: ({ userId, chatId, fromTipSlotId, toTipSlotId }) =>
        Effect.gen(function* () {
          yield* draftTarget(userId, composerKey(chatId, toTipSlotId))
          const from = yield* drafts.find(userId, composerKey(chatId, fromTipSlotId))
          if (from === null || from.status !== "active" || from.content === "") return null
          const to = yield* drafts.find(userId, composerKey(chatId, toTipSlotId))
          // Never overwrite text already typed on the other branch.
          if (to !== null && to.status === "active" && to.content !== "") return drafts.toDraft(to)
          return yield* drafts.save({
            userId,
            key: composerKey(chatId, toTipSlotId),
            content: from.content,
            expectedRowVersion: to?.row_version ?? null,
            baseRevision: null,
            checkTarget: Effect.void
          })
        }).pipe(transaction("CopyComposer")),

      RestoreDraftState: ({ userId, key, seq, expectedRowVersion }) =>
        drafts.restore(userId, key, seq, expectedRowVersion).pipe(transaction("RestoreDraftState")),

      ClearDraft: ({ userId, key, outcome, expectedRowVersion }) =>
        drafts.clear(userId, key, outcome, expectedRowVersion).pipe(transaction("ClearDraft")),

      AppendMessage: ({ userId, chatId, parentSlotId, branch, version, commitDraft }) =>
        Effect.gen(function* () {
          const at = Date.now()
          const current = yield* ownedChat(userId, chatId)
          yield* checkSpeaker(userId, version.speakerEntityId)
          let parent: { id: string; depth: number; lane_id: string } | null = null
          if (parentSlotId !== null) {
            const [row] = yield* sql<{ id: string; depth: number; lane_id: string }>`
            SELECT id, depth, lane_id FROM slots WHERE id = ${parentSlotId} AND chat_id = ${chatId} AND deleted_at IS NULL`
            if (!row) return yield* new NotFound({ entity: "slot", id: parentSlotId })
            parent = row
          }
          if (!branch && parentSlotId !== current.active_leaf_slot_id) {
            return yield* new LeafMoved({ chatId, activeLeafSlotId: current.active_leaf_slot_id })
          }
          const laneId =
            parent?.lane_id ??
            (yield* sql<{
              id: string
            }>`SELECT id FROM lanes WHERE chat_id = ${chatId} ORDER BY created_at, id LIMIT 1`)[0]!.id
          const { slotId, version: row } = yield* insertSlot(chatId, laneId, parent, version, at)
          const [chat] = yield* sql<ChatRow>`
          UPDATE chats SET active_leaf_slot_id = ${slotId}, last_message_at = ${at},
            status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            row_version = row_version + 1
          WHERE id = ${chatId} RETURNING *`
          const committed = yield* drafts.commit(userId, commitDraft)
          // The composer at the old tip moves to the new one: text typed while something
          // else was appended stays in view, and a send's recovery text goes along with it.
          yield* sql`UPDATE drafts SET field = ${slotId}, row_version = row_version + 1
                   WHERE target_kind = 'composer' AND target_id = ${chatId} AND field = ${parentSlotId ?? ""}`
          const movedComposer =
            committed !== null && committed.key.targetKind === "composer" && committed.key.targetId === chatId
          const draft = movedComposer ? yield* drafts.find(userId, composerKey(chatId, slotId)) : null
          return new AppendResult({
            slotId: slotId as SlotId,
            version: toVersion(row),
            chat: toChat(chat!),
            draft: draft ? drafts.toDraft(draft) : committed
          })
        }).pipe(transaction("AppendMessage")),

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
            yield* sql`UPDATE slots SET selected_version_id = ${row.id}, row_version = row_version + 1 WHERE id = ${slotId}`
          }
          yield* drafts.commit(userId, commitDraft)
          return toVersion(row)
        }).pipe(transaction("AddVersion")),

      SelectVersion: ({ userId, slotId, versionId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const slot = yield* ownedSlot(userId, slotId)
          const [version] = yield* sql<{
            id: string
          }>`SELECT id FROM versions WHERE id = ${versionId} AND slot_id = ${slotId} AND deleted_at IS NULL`
          if (!version) return yield* new NotFound({ entity: "version", id: versionId })
          if (slot.row_version !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "slot",
              id: slotId,
              expected: expectedRowVersion,
              actual: slot.row_version
            })
          }
          const [updated] = yield* sql<{ row_version: number }>`
          UPDATE slots SET selected_version_id = ${versionId}, row_version = row_version + 1
          WHERE id = ${slotId} RETURNING row_version`
          return { rowVersion: updated!.row_version }
        }).pipe(transaction("SelectVersion")),

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

      AddSelectedVersion: ({ userId, slotId, version, expectedRowVersion }) =>
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
          const [next] = yield* sql<{
            n: number
          }>`SELECT coalesce(max(ordinal), -1) + 1 AS n FROM versions WHERE slot_id = ${slotId}`
          const row = yield* insertVersion(slotId, next!.n, version, Date.now())
          yield* sql`UPDATE slots SET selected_version_id = ${row.id}, row_version = row_version + 1 WHERE id = ${slotId}`
          return toVersion(row)
        }).pipe(transaction("AddSelectedVersion")),

      AmendVersion: ({ userId, versionId, content, expectedRowVersion }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          if (row.writer !== "human" || row.status === "generating") return yield* new NotAmendable({ versionId })
          const rowVersion = 1 + (row.amend_count ?? 0)
          if (rowVersion !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "version",
              id: versionId,
              expected: expectedRowVersion,
              actual: rowVersion
            })
          }
          if (content === row.content) return toVersion(row)
          // The trigger keeps the previous text in version_history (DESIGN §3.1).
          yield* sql`UPDATE versions SET content = ${content}, updated_at = ${Date.now()} WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, true))
        }).pipe(transaction("AmendVersion")),

      SaveGeneration: ({ userId, versionId, content, status, error }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, false)
          if (row.writer !== "model" || row.status !== "generating") {
            return yield* new NotFound({ entity: "generating version", id: versionId })
          }
          yield* sql`UPDATE versions SET content = ${content}, status = ${status},
            error_json = ${error === null ? null : JSON.stringify(error)}, updated_at = ${Date.now()}
            WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, false))
        }).pipe(transaction("SaveGeneration")),

      InterruptGenerations: () =>
        sql`UPDATE versions SET status = 'interrupted', updated_at = ${Date.now()} WHERE status = 'generating'
            RETURNING id`.pipe(
          Effect.map((rows) => ({ interrupted: rows.length })),
          transaction("InterruptGenerations")
        )
    } satisfies Partial<WriteHandlers>
    return handlers
  })
