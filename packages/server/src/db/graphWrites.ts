import { stateEventsOnPath } from "./stateRead.ts"
import { recordHistoryReduction } from "./historyChanges.ts"
// What the writer's chat operations share (writes.ts, chatSetupWrites.ts): ownership
// checks, inserting versions, slots and state events, and appending a message. Each runs
// inside the calling operation's transaction.
import type { ChatId, EntityId, ForkId, NewVersion, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { branchOwned, foldState, type FoldableEvent, type WritableStateEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import type { CommitDraft } from "./drafts.ts"
import { AppendResult, LeafMoved, NotFound, StaleWrite } from "./ops.ts"
import { forkThrough, onForkPath, onPath } from "./forks.ts"
import { hiddenAtFork, pathPieces, slotPlace } from "./displayPath.ts"
import {
  forkAt,
  nextSeq,
  insertFork,
  originalSql,
  replacedIn,
  selectionIn,
  writeInsert,
  writeSelect
} from "./forkState.ts"
import { versionExtras, type ChatRow, type ForkRow, toChat, toVersion, type VersionRow } from "./rows.ts"
import { checkStateReferences, withoutPurged } from "./stateRefs.ts"

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

  const checkImages = (userId: string, images: import("@rp/shared/chat.ts").MessageImages) =>
    Effect.forEach(
      images,
      (image) =>
        found(
          sql`SELECT count(*) AS n FROM media_refs r JOIN media_assets m ON m.id=r.media_id
        WHERE r.owner_user_id=${userId} AND r.media_id=${image.mediaId}
          AND m.mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')`,
          "media",
          image.mediaId
        ),
      { discard: true }
    )

  const insertVersion = (slotId: string, ordinal: number, version: NewVersion, at: number, owner?: string) =>
    Effect.gen(function* () {
      yield* checkSource(slotId, version.sourceVersionId)
      const row = yield* sql<VersionRow>`INSERT INTO versions ${sql.insert({
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
        reasoning: version.reasoning || null,
        error_json: version.error ? JSON.stringify(version.error) : null,
        created_at: at,
        updated_at: at
      })} RETURNING *`
      const inserted = row[0]!
      if (version.images !== undefined) {
        const [chat] = yield* sql<{
          owner: string
        }>`SELECT c.owner_user_id AS owner FROM slots s JOIN chats c ON c.id=s.chat_id WHERE s.id=${slotId}`
        if (!chat && !owner) return yield* new NotFound({ entity: "slot", id: slotId })
        yield* checkImages(chat?.owner ?? owner!, version.images)
        for (const [ordinal, image] of version.images.entries())
          yield* sql`INSERT INTO version_attachments(version_id, ordinal, media_id, kind, alt_text)
            VALUES (${inserted.id}, ${ordinal}, ${image.mediaId}, 'image', ${image.altText ?? null})`
      } else if (version.sourceVersionId) {
        yield* sql`INSERT INTO version_attachments(version_id, ordinal, media_id, kind, alt_text)
          SELECT ${inserted.id}, ordinal, media_id, kind, alt_text FROM version_attachments WHERE version_id=${version.sourceVersionId}`
      }
      if (version.images !== undefined || version.sourceVersionId) {
        const [attachments] = yield* sql<{ images_json: string }>`SELECT json_group_array(json_object(
          'mediaId', a.media_id, 'altText', coalesce(a.alt_text, ''))) AS images_json
          FROM (SELECT * FROM version_attachments WHERE version_id=${inserted.id} ORDER BY ordinal) a`
        return { ...inserted, images_json: attachments!.images_json }
      }
      return inserted
    })

  /**
   * A new slot under `parent` with its first version, and `more` after it; `selected` of
   * them is its selection, which no write changes afterwards (a fork selects with an
   * override). `forkId` is the fork appending it (provenance; null: the chat's current fork).
   * `inserted` marks a message inserted between others (spec/MESSAGE-INSERT.md §2.2).
   */
  const insertSlot = (
    chatId: string,
    laneId: string,
    parent: { id: string; depth: number } | null,
    version: NewVersion,
    at: number,
    forkId: string | null = null,
    more: ReadonlyArray<NewVersion> = [],
    selected = 0,
    inserted = false
  ) =>
    Effect.gen(function* () {
      const slotId = uuidv7()
      const fork =
        forkId ??
        (yield* sql<{ id: string | null }>`SELECT current_fork_id AS id FROM chats WHERE id = ${chatId}`)[0]?.id ??
        null
      const [owner] = yield* sql<{ id: string }>`SELECT owner_user_id AS id FROM chats WHERE id=${chatId}`
      const rows = [yield* insertVersion(slotId, 0, version, at, owner!.id)]
      for (const [i, next] of more.entries()) rows.push(yield* insertVersion(slotId, i + 1, next, at, owner!.id))
      yield* sql`INSERT INTO slots ${sql.insert({
        id: slotId,
        chat_id: chatId,
        lane_id: laneId,
        parent_slot_id: parent?.id ?? null,
        depth: parent ? parent.depth + 1 : 0,
        selected_version_id: rows[selected]!.id,
        fork_id: fork,
        created_at: at,
        ...(inserted ? { inserted: 1 } : {})
      })}`
      return { slotId, version: rows[0]!, selected: rows[selected]! }
    })

  /** A user's state change, after checking everything its value names. */
  const insertStateEvent = (
    userId: UserId,
    chatId: string,
    slotId: string | null,
    versionId: string | null,
    scope: FoldableEvent["scope"],
    data: WritableStateEvent,
    forkId: string | null = null
  ) =>
    Effect.gen(function* () {
      if (data.key === "lcm.settings" && (slotId !== null || versionId !== null || scope !== null))
        return yield* new NotFound({ entity: "chat-wide settings", id: chatId })
      const fork = forkId ?? (yield* forkAt(sql, chatId, slotId))
      if (fork === null) return yield* new NotFound({ entity: "fork", id: chatId })
      const [owned] = yield* sql<{
        tip_slot_id: string | null
      }>`SELECT tip_slot_id FROM forks WHERE id = ${fork} AND chat_id = ${chatId} AND deleted_at IS NULL`
      if (!owned) return yield* new NotFound({ entity: "fork", id: fork })
      if (slotId !== null && !(yield* onPath(sql, chatId, owned.tip_slot_id, slotId))) {
        // Until import unit 9 gives every ST path a fork row, its reads return the
        // current fork as a fallback. Preserve positional edits addressed by that ID too.
        if (branchOwned.has(data.key) || fork !== (yield* forkAt(sql, chatId, slotId)))
          return yield* new NotFound({ entity: "fork position", id: slotId })
      }
      if (branchOwned.has(data.key)) {
        if (versionId !== null || scope !== null)
          return yield* new NotFound({ entity: "branch-owned event", id: chatId })
        slotId = null
      }
      yield* checkStateReferences(sql, userId, chatId, data, scope)
      if (data.key === "played_by_me.set") data = { ...data, value: { entities: data.value.entities.slice(-1) } }
      if (data.key === "card.swap") {
        const [family] = yield* sql`WITH RECURSIVE ancestors(id, parent) AS (
          SELECT id, forked_from_entity_id FROM entities WHERE id = ${data.value.entity}
          UNION SELECT e.id, e.forked_from_entity_id FROM entities e JOIN ancestors a ON e.id = a.parent
        ), other(id, parent) AS (
          SELECT id, forked_from_entity_id FROM entities WHERE id = ${data.value.replaces}
          UNION SELECT e.id, e.forked_from_entity_id FROM entities e JOIN other a ON e.id = a.parent
        ) SELECT 1 FROM ancestors a JOIN other b ON a.id = b.id LIMIT 1`
        if (!family) return yield* new NotFound({ entity: "card family", id: data.value.entity })
      }
      // These fields follow the cast position through a swap. Store a later change
      // against its pre-swap identity, since branch-owned swaps fold after positions.
      // Card bindings deliberately keep their own identity (the replaced binding sleeps).
      if (
        [
          "participant.join",
          "participant.leave",
          "presence.set",
          "played_by_me.set",
          "lorebook.binding",
          "lorebook.embedded"
        ].includes(data.key)
      ) {
        const rows = yield* stateEventsOnPath(sql, chatId as ChatId, slotId as SlotId | null, fork)
        const events = yield* withoutPurged(
          sql,
          rows.map((e) => ({
            scope: e.scope,
            data: { key: e.key, value: JSON.parse(e.value_json) }
          })) as Array<FoldableEvent>
        )
        const originals = new Map(
          foldState(events.filter((e) => !branchOwned.has(e.data.key))).participants.map((id) => [id, id])
        )
        for (const { data: e } of events) {
          if (e.key !== "card.swap" || e.value.entity === e.value.replaces) continue
          const original = originals.get(e.value.replaces)
          if (original === undefined) continue
          originals.delete(e.value.replaces)
          originals.set(e.value.entity, original)
        }
        const original = (id: EntityId) => (originals.get(id) ?? id) as EntityId
        const rekey = <A extends { readonly value: { readonly entity: EntityId } }>(event: A): A => ({
          ...event,
          value: { ...event.value, entity: original(event.value.entity) }
        })
        switch (data.key) {
          case "participant.join":
          case "participant.leave":
          case "presence.set":
          case "lorebook.binding":
          case "lorebook.embedded":
            data = rekey(data)
            break
          case "played_by_me.set":
            data = { ...data, value: { entities: data.value.entities.map(original) } }
            break
        }
      }
      const forkSeq = yield* nextSeq(sql, chatId)
      const [next] = yield* sql<{ n: number }>`
          SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${chatId} AND slot_id IS ${slotId}`
      const id = uuidv7()
      yield* sql`INSERT INTO state_events ${sql.insert({
        id,
        chat_id: chatId,
        slot_id: slotId,
        version_id: versionId,
        seq: next!.n,
        fork_id: fork,
        fork_seq: forkSeq,
        key: data.key,
        scope,
        value_json: JSON.stringify(data.value),
        origin: "user",
        created_at: Date.now()
      })}`
      return { id, seq: next!.n }
    })

  /** A live fork of the user's chat: `forkId`, or the chat's current one when null. */
  const ownedFork = (userId: UserId, chatId: ChatId, forkId: ForkId | null) =>
    sql<ForkRow>`
      SELECT f.* FROM forks f JOIN chats c ON c.id = f.chat_id
      WHERE f.id = coalesce(${forkId}, c.current_fork_id) AND c.id = ${chatId} AND c.owner_user_id = ${userId}
        AND c.deleted_at IS NULL AND f.deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "fork", id: forkId ?? chatId }))
      )
    )

  /**
   * Fork `row`, just made from `from` at `baseSlotId`, places no inserted slot `from` doesn't
   * show up to there: each gets a row of 0 (`hiddenAtFork`, spec/MESSAGE-INSERT.md §2.4).
   * Costs the branch points and insertions of both paths; read even when `from` shows no
   * insertion, since it may have one structurally while inheriting its row.
   */
  const placeAsShown = (chatId: string, from: ForkRow, baseSlotId: string | null, row: ForkRow) =>
    Effect.gen(function* () {
      const shown = yield* pathPieces(sql, chatId, from.id, from.tip_slot_id)
      const base = baseSlotId === null ? null : yield* slotPlace(sql, chatId, baseSlotId)
      const own = yield* pathPieces(sql, chatId, row.id, row.tip_slot_id)
      for (const slotId of hiddenAtFork(shown, base, own)) yield* writeInsert(sql, { id: row.id, chatId }, slotId, 0)
    })

  /**
   * A new fork of `from` at `atSlotId` (null: before the first message), which must be on
   * its display path. Its tip is that message until something is sent in it, and it becomes
   * the chat's current fork: the one created by forking (UX-REWORK §3). It shows exactly what
   * `from` shows up to there: an inserted slot it would place after it gets a row of 0
   * (`hiddenAtFork`, spec/MESSAGE-INSERT.md §2.4).
   */
  const createFork = (chatId: string, from: ForkRow, atSlotId: string | null, at: number, checked = false) =>
    Effect.gen(function* () {
      if (!checked && atSlotId !== null && !(yield* onForkPath(sql, chatId, from, atSlotId)))
        return yield* new NotFound({ entity: "slot", id: atSlotId })
      const row = yield* insertFork(sql, { chatId, parent: from, baseSlotId: atSlotId, tipSlotId: atSlotId, at })
      yield* placeAsShown(chatId, from, atSlotId, row)
      yield* sql`UPDATE chats SET current_fork_id = ${row.id}, row_version = row_version + 1 WHERE id = ${chatId}`
      return row
    })

  /** The fork was chatted in: it's the chat's current fork now (UX-REWORK §3, owner 2026-10-27). */
  const chatIn = (forkId: string, at: number) =>
    Effect.gen(function* () {
      yield* sql`UPDATE forks SET last_chatted_at = ${at}, row_version = row_version + 1 WHERE id = ${forkId}`
      yield* sql`UPDATE chats SET current_fork_id = ${forkId}, row_version = row_version + 1
        WHERE id = (SELECT chat_id FROM forks WHERE id = ${forkId})`
    })

  /**
   * A new slot under `parentSlotId` (null: the first message) in fork `forkId` (null: the
   * current one), becoming its tip. The fork is chatted in, so it becomes the chat's
   * current fork, unless the queue posts it (`chatted: false`). Without `branch` the parent
   * must be the fork's tip, and a tab that missed a newer message gets `LeafMoved` with the
   * tip. With `branch` the parent can be any live slot: a new fork is made there first
   * (CreateFork), from this fork if the parent is on its path, else from the most recent
   * fork through it, unless the parent is that fork's tip, which it then just continues.
   * `commitDraft` is committed with it.
   */
  const appendMessage = (params: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly forkId?: ForkId | null
    readonly parentSlotId: SlotId | null
    readonly branch: boolean
    readonly version: NewVersion
    readonly commitDraft: CommitDraft | null
    /** False for the queue posting what was sent earlier: the fork was chatted in then. */
    readonly chatted?: boolean
  }) =>
    Effect.gen(function* () {
      const { userId, chatId, parentSlotId, branch, version, commitDraft } = params
      const chatted = params.chatted ?? true
      const at = Date.now()
      yield* ownedChat(userId, chatId)
      let fork = yield* ownedFork(userId, chatId, params.forkId ?? null)
      yield* checkSpeaker(userId, version.speakerEntityId)
      let parent: { id: string; depth: number; lane_id: string } | null = null
      if (parentSlotId !== null) {
        const [row] = yield* sql<{ id: string; depth: number; lane_id: string }>`
            SELECT id, depth, lane_id FROM slots WHERE id = ${parentSlotId} AND chat_id = ${chatId} AND deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "slot", id: parentSlotId })
        parent = row
      }
      if (branch) {
        const from =
          parentSlotId === null || (yield* onForkPath(sql, chatId, fork, parentSlotId))
            ? fork
            : ((yield* forkThrough(sql, chatId, parentSlotId)) ?? fork)
        // At a fork's own tip it just continues. Elsewhere it makes a fork, checked above: a
        // parent no live fork's path holds (below a deleted branch) still takes a branch, as
        // it did before forks.
        fork = from.tip_slot_id === parentSlotId ? from : yield* createFork(chatId, from, parentSlotId, at, true)
      } else if (parentSlotId !== fork.tip_slot_id) {
        return yield* new LeafMoved({ chatId, activeLeafSlotId: fork.tip_slot_id })
      }
      const laneId =
        parent?.lane_id ??
        (yield* sql<{
          id: string
        }>`SELECT id FROM lanes WHERE chat_id = ${chatId} ORDER BY created_at, id LIMIT 1`)[0]!.id
      const { slotId, version: row } = yield* insertSlot(chatId, laneId, parent, version, at, fork.id)
      yield* sql`UPDATE forks SET tip_slot_id = ${slotId}, row_version = row_version + 1 WHERE id = ${fork.id}`
      if (chatted) yield* chatIn(fork.id, at)
      const [chat] = yield* sql<ChatRow>`
          UPDATE chats SET last_message_at = ${at},
            status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            row_version = row_version + 1
          WHERE id = ${chatId} RETURNING *`
      // The composer is the fork's, so text typed while something else was appended stays
      // in view without moving.
      const committed = yield* drafts.commit(userId, commitDraft, {
        targetKind: "composer",
        targetId: chatId,
        content: row.writer === "model" ? (row.direction ?? "") : row.content
      })
      return new AppendResult({
        slotId: slotId as SlotId,
        forkId: fork.id as ForkId,
        version: toVersion(row),
        chat: toChat(chat!),
        // The named draft as the write left it.
        draft: committed.draft === null ? null : yield* drafts.ownDraft(userId, committed.draft.id),
        recovered: committed.recovered
      })
    })

  /**
   * A fork of the slot's chat (`forkId`, null: the current one) and the slot as that fork
   * shows it: its selection there, the version shown for it, and its row version there, which
   * is the slot's plus the newest seq of its selection, replacement, deletion and visibility
   * overrides (`selectionIn`), so a choice made in another fork never makes this one's stale
   * (spec/FORK-INDEPENDENCE-DELTA.md §2.2).
   */
  const slotInFork = (userId: UserId, slotId: SlotId, forkId: ForkId | null) =>
    Effect.gen(function* () {
      const slot = yield* ownedSlot(userId, slotId)
      const fork = yield* ownedFork(userId, slot.chat_id as ChatId, forkId)
      const selection = (yield* selectionIn(sql, fork.id, slotId))!
      return {
        slot,
        fork,
        selected: selection.version_id as VersionId,
        shown: selection.shown_id as VersionId,
        rowVersion: slot.row_version + selection.seq
      }
    })

  /**
   * Fork `forkId` (null: the current one) shows a live version of the slot from now on, if
   * the fork still showed the version the user saw there (`expectedVersionId`). Either may be
   * a fork's copy standing in for one of the message's own versions: that one is selected.
   */
  const selectVersion = (
    userId: UserId,
    slotId: SlotId,
    versionId: VersionId,
    forkId: ForkId | null,
    expectedVersionId: VersionId
  ) =>
    Effect.gen(function* () {
      const { slot, fork, selected, shown, rowVersion } = yield* slotInFork(userId, slotId, forkId)
      const [version] = yield* sql<{ id: string; content: string }>`
        SELECT o.id, (SELECT content FROM versions WHERE id = ${replacedIn(sql, fork.id, "o.id")}) AS content
        FROM versions v JOIN versions o ON o.id = ${sql.literal(originalSql("v"))}
        WHERE v.id = ${versionId} AND v.slot_id = ${slotId} AND v.deleted_at IS NULL AND o.deleted_at IS NULL`
      if (!version) return yield* new NotFound({ entity: "version", id: versionId })
      if (selected !== expectedVersionId && shown !== expectedVersionId) {
        return yield* new StaleWrite({ entity: "slot", id: slotId, expected: rowVersion, actual: rowVersion })
      }
      if (selected === version.id) return { chatId: slot.chat_id as ChatId, forkId: fork.id as ForkId }
      yield* recordHistoryReduction(sql, slotId, version.content, null, fork.id)
      yield* writeSelect(sql, { id: fork.id, chatId: slot.chat_id }, slotId, version.id)
      return { chatId: slot.chat_id as ChatId, forkId: fork.id as ForkId }
    })

  return {
    found,
    slotInFork,
    selectVersion,
    ownedChat,
    ownedSlot,
    ownedVersion,
    ownedFork,
    createFork,
    placeAsShown,
    chatIn,
    checkImages,
    checkSpeaker,
    insertVersion,
    insertSlot,
    insertStateEvent,
    appendMessage
  }
}
