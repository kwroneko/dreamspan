// What the writer's chat operations share (writes.ts, chatSetupWrites.ts): ownership
// checks, inserting versions, slots and state events, and appending a message. Each runs
// inside the calling operation's transaction.
import type { ChatId, EntityId, NewVersion, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { FoldableEvent, StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import type { CommitDraft } from "./drafts.ts"
import { AppendResult, LeafMoved, NotFound, StaleWrite } from "./ops.ts"
import { versionExtras, type ChatRow, toChat, toVersion, type VersionRow } from "./rows.ts"
import { checkStateReferences } from "./stateRefs.ts"

export const makeGraphWrites = (sql: SqlClient.SqlClient, drafts: Bin["drafts"]) => {
  /** Fails with NotFound unless `query` counts exactly one row. */
  const found = <E>(query: Effect.Effect<ReadonlyArray<{ readonly n: number }>, E>, entity: string, id: string) =>
    Effect.flatMap(query, ([row]) => (row?.n === 1 ? Effect.void : Effect.fail(new NotFound({ entity, id }))))

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
    )

  const ownedSlot = (userId: UserId, slotId: SlotId) =>
    sql<{ id: string; chat_id: string; row_version: number }>`
      SELECT s.id, s.chat_id, s.row_version FROM slots s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "slot", id: slotId }))))
    )

  /** A version of the user's, with its amend count; `live` also refuses one in the bin. */
  const ownedVersion = (userId: UserId, versionId: VersionId, live: boolean) =>
    sql<VersionRow & { purged_at: number | null }>`
      SELECT v.*, ${sql.literal(versionExtras("v"))} FROM versions v JOIN slots s ON s.id = v.slot_id
        JOIN chats c ON c.id = s.chat_id
      WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
        AND (${live ? 0 : 1} OR (v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL))`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "version", id: versionId }))
      )
    )

  /** A speaker is a live card of the user's. */
  const checkSpeaker = (userId: UserId, speaker: EntityId | null) =>
    speaker === null
      ? Effect.void
      : found(
          sql`SELECT count(*) AS n FROM entities WHERE id = ${speaker} AND owner_user_id = ${userId}
            AND kind = 'card' AND deleted_at IS NULL`,
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
        greeting_ref: version.greetingRef ? JSON.stringify(version.greetingRef) : null,
        frozen_macros: version.frozenMacros ? JSON.stringify(version.frozenMacros) : null,
        direction: version.direction ?? null,
        error_json: version.error ? JSON.stringify(version.error) : null,
        created_at: at,
        updated_at: at
      })} RETURNING *`.pipe(Effect.map(([row]) => row!))
    )

  /** A new slot under `parent` with its first version, selected; more versions may follow. */
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

  /**
   * A new slot under `parentSlotId` (null: the first message), becoming the active leaf,
   * unless `keepLeaf` (a message posted on a branch the user has moved away from).
   * Without `branch` the parent must be the active leaf. `commitDraft` is committed with it.
   */
  const appendMessage = (params: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly parentSlotId: SlotId | null
    readonly branch: boolean
    readonly version: NewVersion
    readonly commitDraft: CommitDraft | null
    readonly keepLeaf?: boolean
  }) =>
    Effect.gen(function* () {
      const { userId, chatId, parentSlotId, branch, version, commitDraft } = params
      const keepLeaf = params.keepLeaf ?? false
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
          UPDATE chats SET active_leaf_slot_id = ${keepLeaf ? current.active_leaf_slot_id : slotId}, last_message_at = ${at},
            status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            row_version = row_version + 1
          WHERE id = ${chatId} RETURNING *`
      const committed = yield* drafts.commit(userId, commitDraft, {
        targetKind: "composer",
        targetId: chatId,
        content: row.writer === "model" ? (row.direction ?? "") : row.content
      })
      // The composer at the old tip moves to the new one: text typed while something
      // else was appended stays in view, and a send's recovery text goes along with it.
      const movedRecovery = yield* drafts.moveComposer(userId, chatId, parentSlotId, slotId)
      return new AppendResult({
        slotId: slotId as SlotId,
        version: toVersion(row),
        chat: toChat(chat!),
        // The named draft as the write left it, wherever its tip is now.
        draft: committed.draft === null ? null : yield* drafts.ownDraft(userId, committed.draft.id),
        recovered: committed.recovered + movedRecovery
      })
    })

  /** Selects a live version of the slot, if the slot is still at the row version the user saw. */
  const selectVersion = (userId: UserId, slotId: SlotId, versionId: VersionId, expectedRowVersion: number) =>
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
      return { rowVersion: updated!.row_version, chatId: slot.chat_id as ChatId }
    })

  return {
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
  }
}
