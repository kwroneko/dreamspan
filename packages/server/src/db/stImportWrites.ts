import { recordCardArrival, recordChatArrival } from "./stArrival.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { ReplySections } from "@rp/shared/replySections.ts"
import { recordHistoryReduction } from "./historyChanges.ts"
import { refreshChatSummaries } from "./forkSummaries.ts"
import {
  inFork,
  viewAt,
  selectedIn,
  writeOverride,
  writeSelect,
  nextSeq,
  insertFork,
  effectiveOverride,
  slotDeletedIn,
  versionDeletedIn,
  eventApplies
} from "./forkState.ts"
import { pathEvents, pathSegments } from "./pathSegments.ts"
import { forkImportSlot } from "./stImportFork.ts"
import { placedInsertions } from "./displayPath.ts"
import { type ForkRow, recordedColumns, StoredGeneration } from "./rows.ts"
// Write handlers for the ST data folder import (ARCHITECTURE.md §13). Each is one
// transaction in the writer, and a chat goes in over several: its start, its messages in
// batches, its state. Nothing here reads a file: the format worker parsed them, and the main
// thread resolved what the messages name.
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { NOTE_SCHEMA_VERSION, type NoteDoc } from "@rp/shared/docs/note.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { validateDoc } from "@rp/shared/editing.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { unfinishedTitle } from "@rp/shared/stImportApi.ts"
import { foldState, type StateEventData } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { docHash, searchText } from "./documents.ts"
import { ImportLeaseLost, NotFound, ST_CHAT_RECORD, ST_IMPORT_RUN, type StImportNote, WriteOps } from "./ops.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { transaction } from "./tx.ts"
import { DEFAULT_PRESET, newChatLcmSettings, ownedPreset } from "./generationSettings.ts"

/** A message as the format worker wrote it (formats/stChat.ts). */
const Message = Schema.Struct({
  arrivalAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  user: Schema.Boolean,
  hidden: Schema.Boolean,
  speaker: Schema.NullOr(Schema.String),
  selected: Schema.Int,
  versions: Schema.NonEmptyArray(
    Schema.Struct({
      content: Schema.String,
      reasoning: Schema.NullOr(Schema.String),
      sections: Schema.optionalKey(ReplySections),
      at: Schema.Number,
      /** Its model, times and token count as ST recorded them (formats/stChat.ts; rows.ts `recordedColumns`). */
      generation: Schema.optionalKey(StoredGeneration)
    })
  )
})
const Messages = Schema.fromJsonString(Schema.Array(Message))

/** State changed locally stays local, including the inverse of an imported switch. */
const stateTargets = (data: StateEventData): ReadonlyArray<string> => {
  switch (data.key) {
    case "participant.join":
      return [`participant:${data.value.entity}`, `presence:${data.value.entity}`]
    case "participant.leave":
      return [`participant:${data.value.entity}`]
    case "presence.set":
      return [`presence:${data.value.entity}`]
    case "note.activate":
    case "note.deactivate":
    case "note.binding":
      return [`note:${data.value.note}`]
    case "lorebook.attach":
    case "lorebook.detach":
      return [`lorebook:${data.value.ref}`]
    case "lorebook.binding":
    case "lorebook.embedded":
      return [`${data.key}:${data.value.entity}`]
    case "var.set":
      return [`var:${data.value.name}`]
    default:
      return [data.key]
  }
}

/** What a record's payload holds. */
interface RecordPayload {
  readonly source: string
  readonly forkId?: string
  readonly chatId: string
  readonly sha256?: string
  readonly state?: string
  readonly notes?: Record<string, string>
  /** The file's last slot when its import last finished. */
  readonly end?: string | null
  /** The file went into another file's chat: it's a branch of it. */
  readonly merged?: boolean
  /** The first slot the import running now added, for a run that resumes it. */
  readonly firstAdded?: string | null
  /** The chat's own title, while it shows as an unfinished import. */
  readonly title?: string
  /** Where the import last moved a new chat's leaf to, while its messages came in. */
  readonly advanced?: string | null
  /** The import run that may write the file now; null once it's finished. */
  readonly lease?: string | null
  /** The last slot an import of the file wrote or matched, as it went. */
  readonly last?: string | null
  /**
   * Where the file's earlier imports left it (`last` when this run claimed the record): the
   * slots on the path to it are the file's, whatever the user changed in them since.
   */
  readonly prior?: string | null
  /** Original suffix while a shared selection is being forked, including across interrupted batches. */
  readonly forkPrior?: string | null
  /** This pass matched a deleted subtree root; later live additions remain behind it. */
  readonly branchDeleted?: boolean
  /** A replacement ST path must not move the fork off locally changed history. */
  readonly keepTip?: boolean
  /** ST opened the file's card or group on it when the folder was read (`stCurrent`). */
  readonly stCurrent?: boolean
  /** Last resolved parent, retained when a later header loses main_chat. */
  readonly parentRecordId?: string
}

export const makeStImportWriteHandlers = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<{ id: string; active_leaf_slot_id: string | null }>`
      SELECT id, active_leaf_slot_id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId }))))
    )

  const ownedSlot = (chatId: string, slotId: string) =>
    sql<{ id: string; depth: number; lane_id: string; deleted_at: number | null }>`
      SELECT id, depth, lane_id, deleted_at FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "slot", id: slotId }))))
    )

  const record = (userId: UserId, recordId: string) =>
    sql<{ payload_json: string }>`
      SELECT payload_json FROM jobs WHERE id = ${recordId} AND owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD}`.pipe(
      Effect.flatMap(([row]) =>
        row
          ? Effect.succeed(JSON.parse(row.payload_json) as RecordPayload)
          : Effect.fail(new NotFound({ entity: "import record", id: recordId }))
      )
    )

  /** Older records resolve by their recorded end; new files receive their own fork at start. */
  const recordFork = Effect.fnUntraced(function* (payload: RecordPayload) {
    const [existing] = yield* sql<ForkRow>`SELECT * FROM forks WHERE chat_id = ${payload.chatId}
      AND (id = ${payload.forkId ?? ""} OR (${payload.forkId ?? null} IS NULL
        AND tip_slot_id IS ${payload.end ?? payload.last ?? null}))
      ORDER BY id = ${payload.forkId ?? ""} DESC, created_at, id LIMIT 1`
    if (existing) return existing
    if (payload.forkId !== undefined) return yield* new NotFound({ entity: "fork", id: payload.forkId })
    const [parent] = yield* sql<ForkRow>`SELECT f.* FROM forks f JOIN chats c ON c.current_fork_id = f.id
      WHERE c.id = ${payload.chatId}`
    return yield* insertFork(sql, {
      chatId: payload.chatId,
      parent: parent!,
      baseSlotId: null,
      tipSlotId: payload.end ?? payload.last ?? null,
      at: Date.now()
    })
  })

  /**
   * The fork an imported chat opens on, as ST opens it (owner, 2026-11-01): the one of the file
   * ST last opened (`chosen`, else a finished record's `stCurrent`), else the one with the
   * latest message (the earlier one on a tie), as ST picks when its record names no chat it
   * has. Only while the user hasn't chatted or branched in the chat here: a fork chatted in
   * (`last_chatted_at`) or made at a message (`base_slot_id`, which an import never sets) means
   * its current fork is theirs. A chat of one fork (most) has nothing to choose.
   */
  const openOnStCurrent = Effect.fnUntraced(function* (userId: UserId, chatId: string, chosen: string | null) {
    const [state] = yield* sql<{ forks: number; touched: number }>`SELECT count(*) AS forks,
        coalesce(max(last_chatted_at IS NOT NULL OR base_slot_id IS NOT NULL), 0) AS touched
      FROM forks WHERE chat_id = ${chatId} AND deleted_at IS NULL`
    if (state === undefined || state.forks < 2 || state.touched === 1) return
    const [recorded] =
      chosen !== null
        ? [{ id: chosen }]
        : yield* sql<{ id: string }>`SELECT f.id FROM jobs j
            JOIN forks f ON f.id = json_extract(j.payload_json, '$.forkId') AND f.chat_id = ${chatId} AND f.deleted_at IS NULL
            WHERE j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD} AND j.status = 'complete'
              AND json_extract(j.payload_json, '$.chatId') = ${chatId} AND json_extract(j.payload_json, '$.stCurrent') = 1
            ORDER BY j.updated_at DESC LIMIT 1`
    const [latest] = recorded
      ? [recorded]
      : yield* sql<{ id: string }>`SELECT f.id FROM forks f LEFT JOIN slots t ON t.id = f.tip_slot_id
          WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
          ORDER BY coalesce(t.created_at, 0) DESC, f.created_at, f.id LIMIT 1`
    if (latest)
      yield* sql`UPDATE chats SET current_fork_id = ${latest.id}, row_version = row_version + 1
        WHERE id = ${chatId} AND current_fork_id IS NOT ${latest.id}`
  })

  /** Deleting the recorded tail may have moved only this fork's tip up its path. */
  const relocatedEnd = Effect.fnUntraced(function* (fork: ForkRow, end: string | null) {
    const [row] = yield* sql<{ id: string }>`WITH RECURSIVE up(id, parent, deleted, depth) AS (
      SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, fork.id, "s")}, s.depth FROM slots s WHERE s.id = ${end}
      UNION ALL
      SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, fork.id, "s")}, s.depth
      FROM slots s JOIN up ON s.id = up.parent WHERE up.deleted
    ) SELECT id FROM up WHERE NOT deleted ORDER BY depth DESC LIMIT 1`
    return row?.id ?? null
  })

  /** An imported state event, after checking everything it names belongs to the user. */
  const insertEvent = (userId: UserId, chatId: string, slotId: string | null, data: StateEventData, forkId: string) =>
    Effect.gen(function* () {
      yield* checkStateReferences(sql, userId, chatId, data, null)
      if (data.key === "played_by_me.set") data = { ...data, value: { entities: data.value.entities.slice(-1) } }
      const [next] = yield* sql<{ n: number }>`
        SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${chatId} AND slot_id IS ${slotId}`
      yield* sql`INSERT INTO state_events ${sql.insert({
        id: uuidv7(),
        chat_id: chatId,
        slot_id: slotId,
        version_id: null,
        seq: next!.n,
        key: data.key,
        scope: null,
        value_json: JSON.stringify(data.value),
        fork_id: forkId,
        fork_seq: yield* nextSeq(sql, chatId),
        origin: "import",
        origin_ref: null,
        created_at: Date.now()
      })}`
    })

  /**
   * A revision per text of an imported note, oldest first, each on the one before and the
   * first on `parent`; the last one's id. The kind is written only for a summary, which the
   * assembler reads its history by: an imported author's note is an ordinary note (owner,
   * 2026-11-01).
   */
  const insertNoteRevisions = (
    entityId: string,
    chatId: string,
    source: string,
    note: StImportNote,
    parent: string | null,
    at: number
  ) =>
    Effect.gen(function* () {
      for (const [index, content] of note.contents.entries()) {
        // Earlier revisions are the history of the text. How it's sent (template, frequency) and
        // what it covers are on the current one; each keeps its placement, which a note needs.
        const current = index === note.contents.length - 1
        const doc: NoteDoc = {
          schema_version: NOTE_SCHEMA_VERSION,
          title: note.title,
          content,
          placement: note.placement,
          owner: { chat: chatId as ChatId },
          exportable: true,
          ...(note.kind === "imported_summary" ? { kind: note.kind } : {}),
          ...(note.scanLore ? { scan_lore: true } : {}),
          ...(note.template === undefined || !current ? {} : { template: note.template }),
          ...(note.covers === undefined || !current ? {} : { covers: note.covers }),
          ...(note.sources?.[index] ? { source_slot_id: note.sources[index] } : {})
        }
        const check = validateDoc("note", doc)
        if (!check.ok)
          return yield* Effect.die(new Error(`refusing to store an invalid note: ${check.problems.join("; ")}`))
        const sourceSlot = note.sources?.[index]
        const [sourceMessage] =
          sourceSlot == null
            ? []
            : yield* sql<{ created_at: number }>`
          SELECT created_at FROM slots WHERE id = ${sourceSlot} AND chat_id = ${chatId}`
        const revisionAt = sourceMessage?.created_at ?? note.modifiedAt ?? at
        const id = uuidv7()
        yield* sql`INSERT INTO entity_revisions ${sql.insert({
          id,
          entity_id: entityId,
          parents: JSON.stringify(parent === null ? [] : [parent]),
          doc_json: JSON.stringify(doc),
          doc_hash: docHash(doc),
          schema_version: NOTE_SCHEMA_VERSION,
          origin: "import",
          origin_ref: JSON.stringify({ file: source }),
          message: null,
          search_text: searchText(doc),
          created_at: revisionAt
        })}`
        parent = id
      }
      return parent!
    })

  /** A chat-owned note: an entity with a revision per text, oldest first, and its upstream ref. */
  const insertNote = (userId: UserId, chatId: string, source: string, note: StImportNote) =>
    Effect.gen(function* () {
      const at = Date.now()
      const entityId = uuidv7()
      yield* sql`INSERT INTO entities ${sql.insert({ id: entityId, owner_user_id: userId, kind: "note", created_at: at })}`
      const parent = yield* insertNoteRevisions(entityId, chatId, source, note, null, at)
      const [head] = yield* sql<{ created_at: number }>`SELECT created_at FROM entity_revisions WHERE id = ${parent}`
      yield* sql`INSERT INTO entity_refs ${sql.insert({
        id: uuidv7(),
        entity_id: entityId,
        ref_kind: "upstream",
        head_revision_id: parent,
        merge_base_revision_id: parent,
        label: note.title,
        subtitle: "",
        source_path: `${source}#${note.kind}`,
        created_at: at,
        updated_at: head!.created_at
      })}`
      return entityId as EntityId
    })

  /**
   * Fails unless `lease` is the user's current import run: a run the user started another
   * since is over, even while a request of it is still on its way.
   */
  const current = (userId: UserId, lease: string, recordId: string) =>
    sql<{ n: number }>`SELECT count(*) AS n FROM jobs WHERE owner_user_id = ${userId} AND kind = ${ST_IMPORT_RUN}
      AND json_extract(payload_json, '$.importId') = ${lease}`.pipe(
      Effect.flatMap(([row]) => (row?.n === 1 ? Effect.void : Effect.fail(new ImportLeaseLost({ recordId }))))
    )

  /**
   * The record, which this run holds the lease of: a run that another started since, or that
   * a finished import ended, writes nothing.
   */
  const leased = (userId: UserId, recordId: string, chatId: string, lease: string) =>
    Effect.andThen(
      current(userId, lease, recordId),
      Effect.flatMap(record(userId, recordId), (payload) =>
        payload.chatId === chatId && payload.lease === lease
          ? Effect.succeed(payload)
          : Effect.fail(new ImportLeaseLost({ recordId }))
      )
    )

  const handlers = {
    StImportDefaultPreset: ({ userId, importId, refId }) =>
      Effect.gen(function* () {
        yield* current(userId, importId, importId)
        if (!(yield* ownedPreset(sql, userId, refId))) return yield* new NotFound({ entity: "preset", id: refId })
        const changed = yield* sql`INSERT INTO user_settings (user_id,key,value_json)
          VALUES (${userId},${DEFAULT_PRESET},${JSON.stringify(refId)})
          ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json
          WHERE json_type(user_settings.value_json) = 'null' RETURNING user_id`
        return changed.length > 0
      }).pipe(transaction(sql, "StImportDefaultPreset")),
    StImportSummarySettings: ({ userId, importId, prompt, settings }) =>
      Effect.gen(function* () {
        yield* current(userId, importId, importId)
        yield* sql`INSERT INTO user_settings (user_id,key,value_json) VALUES (${userId},'import.st.memory',${settings})
          ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json`
        if (prompt === null) return
        // Re-importing must not undo an instruction the user has chosen since the import.
        yield* sql`INSERT INTO user_settings (user_id,key,value_json)
          VALUES (${userId},'generation.lcm',${JSON.stringify({ tail: prompt })})
          ON CONFLICT(user_id,key) DO UPDATE SET value_json=json_set(user_settings.value_json,'$.tail',${prompt})
          WHERE json_type(user_settings.value_json,'$.tail') IS NULL`
      }).pipe(transaction(sql, "StImportSummarySettings")),

    StImportBegin: ({ userId, importId }) =>
      Effect.gen(function* () {
        const at = Date.now()
        const payload = JSON.stringify({ importId })
        const updated = yield* sql`UPDATE jobs SET payload_json = ${payload}, updated_at = ${at}
          WHERE owner_user_id = ${userId} AND kind = ${ST_IMPORT_RUN} RETURNING id`
        if (updated.length === 0) {
          yield* sql`INSERT INTO jobs ${sql.insert({
            id: uuidv7(),
            owner_user_id: userId,
            kind: ST_IMPORT_RUN,
            status: "processing",
            payload_json: payload,
            created_at: at,
            updated_at: at
          })}`
        }
      }).pipe(transaction(sql, "StImportBegin")),

    StImportStartChat: ({ userId, source, title, createdAt, chatId: into, lease, parentRecordId, arrival, groupId }) =>
      Effect.gen(function* () {
        const recordId = uuidv7()
        yield* current(userId, lease, recordId)
        const at = Date.now()
        let chatId: string
        if (into !== null) {
          chatId = (yield* ownedChat(userId, into)).id
        } else {
          chatId = uuidv7()
          yield* sql`INSERT INTO chats ${sql.insert({
            id: chatId,
            owner_user_id: userId,
            kind: "rp",
            // Visible from its first message, as unfinished until its import finishes.
            status: "active",
            title: unfinishedTitle(title),
            created_at: createdAt
          })}`
          yield* sql`INSERT INTO lanes ${sql.insert({ id: uuidv7(), chat_id: chatId, name: "main", created_at: at })}`
          yield* sql`INSERT INTO state_events ${sql.insert({
            id: uuidv7(),
            chat_id: chatId,
            slot_id: null,
            version_id: null,
            seq: 0,
            key: "lcm.settings",
            // The account default copied, off until the user turns it on (DESIGN §8.1).
            value_json: JSON.stringify(yield* newChatLcmSettings(sql, userId, false)),
            origin: "import",
            created_at: at
          })}`
        }
        if (groupId !== undefined)
          yield* sql`UPDATE chats SET st_group_id = ${groupId} WHERE id = ${chatId} AND owner_user_id = ${userId}`
        if (arrival !== undefined) yield* recordChatArrival(sql, userId, chatId, arrival)
        // An earlier record of this file whose chat was deleted for good names nothing now.
        yield* sql`DELETE FROM jobs WHERE owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD}
          AND json_extract(payload_json, '$.source') = ${source}
          AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = json_extract(payload_json, '$.chatId'))`
        const parentPayload = parentRecordId === undefined ? null : yield* record(userId, parentRecordId)
        if (parentPayload !== null && parentPayload.chatId !== chatId)
          return yield* new NotFound({ entity: "import record", id: parentRecordId! })
        const [currentFork] =
          yield* sql<ForkRow>`SELECT f.* FROM forks f JOIN chats c ON c.current_fork_id = f.id WHERE c.id = ${chatId}`
        const parent = parentPayload === null ? currentFork : yield* recordFork(parentPayload)
        const fork =
          into === null
            ? parent!
            : yield* insertFork(sql, {
                chatId,
                parent: parent!,
                baseSlotId: null,
                tipSlotId: null,
                at
              })
        const payload: RecordPayload = { source, chatId, forkId: fork.id, merged: into !== null, title, lease }
        yield* sql`INSERT INTO jobs ${sql.insert({
          id: recordId,
          owner_user_id: userId,
          kind: ST_CHAT_RECORD,
          status: "processing",
          payload_json: JSON.stringify(payload),
          created_at: at,
          updated_at: at
        })}`
        return { chatId: chatId as ChatId, recordId }
      }).pipe(transaction(sql, "StImportStartChat")),

    StImportMessages: (input) =>
      // Decoded before the transaction, which holds only database work.
      Effect.flatMap(Schema.decodeEffect(Messages)(input.messagesJson).pipe(Effect.orDie), (messages) => {
        const arrivals = new Map<string, number>()
        for (const message of messages) {
          if (message.arrivalAt == null) continue
          const ref = message.speaker === null ? undefined : input.arrivalRefs?.[message.speaker]
          if (ref !== undefined) arrivals.set(ref, Math.min(arrivals.get(ref) ?? Infinity, message.arrivalAt))
        }
        const firstAt = messages.reduce<number | null>(
          (first, message) => (message.arrivalAt == null ? first : Math.min(first ?? Infinity, message.arrivalAt)),
          null
        )
        return Effect.gen(function* () {
          const { userId, chatId, speakers } = input
          yield* ownedChat(userId, chatId)
          const payload = yield* leased(userId, input.recordId, chatId, input.lease)
          const fileFork = yield* recordFork(payload)
          const previousTip = yield* relocatedEnd(fileFork, payload.advanced ?? payload.end ?? payload.last ?? null)
          const shownSql = selectedIn(sql, fileFork.id, "s")
          // Every speaker must be one of the user's live cards.
          const named = [...new Set(Object.values(speakers).filter((id): id is EntityId => id !== null))]
          for (const entity of named) {
            const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entities
            WHERE id = ${entity} AND owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL`
            if (row?.n !== 1) return yield* new NotFound({ entity: "entity", id: entity })
          }
          let parent: { id: string; depth: number; lane_id: string } | null =
            input.parentSlotId === null ? null : yield* ownedSlot(chatId, input.parentSlotId)
          const laneId =
            parent?.lane_id ??
            (yield* sql<{
              id: string
            }>`SELECT id FROM lanes WHERE chat_id = ${chatId} ORDER BY created_at, id LIMIT 1`)[0]!.id
          // The slots on the path to where earlier imports of the file left it, by depth, from
          // the batch's first message down: walked once, and only if a message doesn't match exactly.
          let priorPath: Map<number, string> | null = null
          const forkPrior = payload.forkPrior ?? null
          const firstDepth = parent === null ? 0 : parent.depth + 1
          const priorAt = (depth: number) =>
            Effect.gen(function* () {
              if (priorPath === null) {
                priorPath = new Map<number, string>()
                if (payload.prior == null && forkPrior === null) return undefined
                // The old suffix fills positions not yet copied. A resumed copy's new path
                // takes precedence at positions its earlier batches already wrote.
                if (forkPrior !== null) {
                  const rows = yield* sql<{ id: string; depth: number }>`
                    WITH RECURSIVE up(id, parent, depth) AS (
                      SELECT id, parent_slot_id, depth FROM slots WHERE id = ${forkPrior} AND chat_id = ${chatId}
                      UNION ALL
                      SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN up ON s.id = up.parent WHERE up.depth > ${firstDepth}
                    ) SELECT id, depth FROM up`
                  for (const row of rows) priorPath.set(row.depth, row.id)
                }
                const rows = yield* sql<{ id: string; depth: number }>`
                  WITH RECURSIVE up(id, parent, depth) AS (
                    SELECT id, parent_slot_id, depth FROM slots WHERE id = ${payload.prior} AND chat_id = ${chatId}
                    UNION ALL
                    SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN up ON s.id = up.parent WHERE up.depth > ${firstDepth}
                  )
                  SELECT id, depth FROM up`
                for (const row of rows) priorPath.set(row.depth, row.id)
              }
              return priorPath.get(depth)
            })
          let matching = input.matching
          let added = 0
          let differing = 0
          let updated = 0
          let branchDeleted = payload.branchDeleted ?? false
          let keepTip = payload.keepTip ?? false
          const changedSuffix = Effect.fnUntraced(function* (depth: number) {
            const prior = payload.prior ?? payload.end ?? payload.last ?? null
            if (prior === null || (yield* ownedSlot(chatId, prior)).depth < depth) return false
            // A message the user inserted in the fork where the replaced suffix starts (below its
            // parent, or above the first message) or inside it: the fork stays on the path that
            // shows it (spec/MESSAGE-INSERT.md §3.3). Deleted ones count, as a deletion does.
            const inserted = (yield* placedInsertions(sql, chatId, fileFork.id)).filter((x) =>
              x.anchorDepth === null ? depth === 0 : x.anchorDepth >= depth - 1
            )
            if (inserted.length > 0) {
              const [row] = yield* sql<{ n: number }>`
                ${pathSegments(sql, chatId, prior, null)}
                SELECT count(*) AS n FROM slots a JOIN segments g ON g.chain_id = a.chain_id AND a.depth BETWEEN g.lo AND g.hi
                WHERE a.id IN (SELECT value FROM json_each(${JSON.stringify(inserted.map((x) => x.anchorId))}))`
              if (inserted.some((x) => x.anchorId === null) || row!.n > 0) return true
            }
            const [row] = yield* sql<{ changed: number }>`
              ${pathSegments(sql, chatId, prior, null)}, changed(slot_id) AS (
                SELECT o.slot_id FROM forks f CROSS JOIN json_each(f.lineage_json) l
                JOIN fork_overrides o ON o.fork_id = l.value ->> 0
                  AND o.seq <= coalesce(l.value ->> 1, 9223372036854775807)
                WHERE f.id = ${fileFork.id} AND o.origin = 'user' AND o.slot_depth >= ${depth}
                UNION ALL
                SELECT v.slot_id FROM version_history h JOIN versions v ON v.id = h.version_id
                  JOIN slots s ON s.id = v.slot_id
                WHERE s.chat_id = ${chatId} AND s.depth >= ${depth} AND v.fork_id IS NULL
                UNION ALL
                SELECT e.slot_id FROM state_events e WHERE e.chat_id = ${chatId} AND e.origin <> 'import'
                  AND e.slot_depth >= ${depth} AND ${eventApplies(sql, fileFork.id, "e")}
              ) SELECT EXISTS (SELECT 1 FROM changed c JOIN slots s ON s.id = c.slot_id
                JOIN segments g ON g.chain_id = s.chain_id AND s.depth BETWEEN g.lo AND g.hi) AS changed`
            return row?.changed === 1
          })
          if (input.groupId !== undefined)
            yield* sql`UPDATE chats SET st_group_id = ${input.groupId} WHERE id = ${chatId} AND owner_user_id = ${userId}`
          if (input.groupArrival !== undefined) yield* recordChatArrival(sql, userId, chatId, input.groupArrival)
          for (const [ref, at] of arrivals) yield* recordCardArrival(sql, userId, ref, { at, basis: 1 })
          if (firstAt !== null) yield* recordChatArrival(sql, userId, chatId, { at: firstAt, basis: 1 })
          let firstAdded: string | null = null
          const slotIds: Array<SlotId> = []
          for (const message of messages) {
            const writer = message.user ? "human" : "model"
            const speaker = message.speaker === null ? null : (speakers[message.speaker] ?? null)
            const chosen = message.selected < message.versions.length ? message.selected : 0
            const insertVersion = (slotId: string, ordinal: number, version: (typeof message.versions)[number]) =>
              sql<{ id: string }>`INSERT INTO versions ${sql.insert({
                id: uuidv7(),
                slot_id: slotId,
                ordinal,
                status: "complete",
                speaker_entity_id: speaker,
                writer,
                content: version.content,
                macro_mode: "verbatim",
                origin: "imported",
                reasoning: version.reasoning,
                reply_sections: version.sections ? JSON.stringify(version.sections) : null,
                ...recordedColumns(version.generation),
                created_at: version.at,
                updated_at: version.at
              })} RETURNING id`.pipe(Effect.map(([row]) => row!.id))
            if (matching) {
              let copied: string | null = null
              if (forkPrior !== null) {
                const source = yield* priorAt(parent === null ? 0 : parent.depth + 1)
                if (source !== undefined) {
                  const [position] = yield* sql<{ parent: string | null; writer_matches: number }>`
                    SELECT s.parent_slot_id AS parent, EXISTS (
                      SELECT 1 FROM versions v WHERE v.slot_id = s.id AND v.writer = ${writer}
                    ) AS writer_matches FROM slots s WHERE s.id = ${source}`
                  if (position?.writer_matches === 1 && position.parent !== (parent?.id ?? null)) {
                    copied = yield* forkImportSlot(sql, source, parent?.id ?? null)
                    priorPath!.set(parent === null ? 0 : parent.depth + 1, copied)
                  }
                }
              }
              // Messages in the bin match too: a re-import doesn't bring back what was deleted here.
              // A version the user amended matches by the text it had before (`original`, its
              // oldest history entry), so it isn't imported again beside the amended one.
              const children = yield* sql<{
                slot_id: string
                version_id: string
                depth: number
                hidden: number
                selected: number
                content: string
                original: string
                created_at: number
                writer: string
                ordinal: number
                slot_purged: number
                version_purged: number
                branch_deleted: number
                deleted: number
                version_deleted: number
                locally_changed: number
              }>`
                SELECT s.id AS slot_id, v.id AS version_id, s.depth,
                  ${contextExcludedIn(sql, fileFork.id)} AS hidden,
                  v.id = ${shownSql} AS selected,
                  v.content, v.created_at, v.writer, v.ordinal,
                  s.purged_at IS NOT NULL AS slot_purged, v.purged_at IS NOT NULL AS version_purged,
                  s.branch_deleted,
                  ${slotDeletedIn(sql, fileFork.id, "s")} AS deleted, ${versionDeletedIn(sql, fileFork.id, "v")} AS version_deleted,
                  EXISTS (
                    SELECT 1 FROM version_history h WHERE h.version_id = ${shownSql}
                  ) OR EXISTS (
                    SELECT 1 FROM fork_overrides o WHERE o.id IN (
                      ${effectiveOverride(sql, "select", fileFork.id, "s.id")},
                      ${effectiveOverride(sql, "hide", fileFork.id, "s.id")},
                      ${effectiveOverride(sql, "delete_slot", fileFork.id, "s.id")}) AND o.origin = 'user'
                  ) OR EXISTS (
                    SELECT 1 FROM versions r JOIN fork_overrides o ON o.id IN (
                      ${effectiveOverride(sql, "replace", fileFork.id, "r.id")},
                      ${effectiveOverride(sql, "delete_version", fileFork.id, "r.id")})
                    WHERE r.slot_id = s.id AND o.origin = 'user'
                  ) AS locally_changed,
                  coalesce((SELECT h.content FROM version_history h WHERE h.version_id = v.id ORDER BY h.id LIMIT 1),
                    v.content) AS original
                FROM slots s JOIN versions v ON v.slot_id = s.id AND v.fork_id IS NULL
                WHERE ${parent === null ? sql`s.chat_id = ${chatId} AND s.depth = 0` : sql`s.parent_slot_id = ${parent.id}`}
                  AND s.inserted = 0
                ORDER BY s.id, v.ordinal`
              const same = (row: (typeof children)[number], version: (typeof message.versions)[number]) =>
                row.version_purged === 0 &&
                row.writer === writer &&
                row.created_at === version.at &&
                (row.content === version.content || row.original === version.content)
              const shown = message.versions[chosen]!
              const versionsOf = (slotId: string) => children.filter((row) => row.slot_id === slotId)
              // Every sibling with a version of the message: a branch that went its own way
              // has its own copy next to its parent's.
              const candidates = [
                ...new Set(
                  children
                    .filter((row) => message.versions.some((version) => same(row, version)))
                    .map((row) => row.slot_id)
                )
              ].map(versionsOf)
              // Whether a slot shows what the file shows, and hides what it hides.
              const alike = (own: typeof children) =>
                own.some((row) => row.selected === 1 && same(row, shown)) && own[0]!.hidden === (message.hidden ? 1 : 0)
              const exact = candidates.find(alike)
              // Otherwise the slot an earlier import of this file matched or made here, whatever
              // the user selected, hid or deleted in it since: the user's choices stay theirs.
              // A purged slot has no text left to match. Only this file's recorded path
              // may identify its placeholder, with the retained timestamp and writer.
              const purged = children.filter(
                (row) =>
                  row.slot_purged === 1 &&
                  row.writer === writer &&
                  message.versions.some((version) => row.created_at === version.at)
              )
              const mine =
                exact !== undefined && purged.length === 0 && new Set(children.map((row) => row.slot_id)).size === 1
                  ? undefined
                  : yield* priorAt(parent === null ? 0 : parent.depth + 1)
              // On this file's recorded path, ST may have overwritten every old swipe.
              // Position identifies the slot even when text and swipe dates changed. A
              // different writer still starts a new path; purged text is never restored.
              const earlier = mine === undefined ? undefined : versionsOf(mine)
              const recorded = earlier?.some((row) => row.writer === writer && row.slot_purged === 0)
                ? earlier
                : undefined
              const placeholder = mine === undefined ? undefined : purged.find((row) => row.slot_id === mine)
              // A branch merged into another file's chat is that file's only where it reads
              // the same: a branch from another swipe, or with messages hidden only in it,
              // diverges there, so its own path keeps what ST had on it.
              const own =
                recorded ??
                exact ??
                candidates.find((rows) => rows[0]!.hidden === (message.hidden ? 1 : 0)) ??
                (input.strict ? undefined : candidates[0])
              const match = placeholder ?? own?.[0]
              if (match !== undefined) {
                if (copied !== null) {
                  added++
                  firstAdded ??= copied
                }
                branchDeleted ||= match.branch_deleted === 1
                let showsSelected = own?.some((row) => row.selected === 1 && same(row, shown)) ?? false
                if (own !== undefined && match.slot_purged === 0) {
                  let next = Math.max(...own.map((row) => row.ordinal)) + 1
                  let changed = false
                  let selected = own.find((row) => same(row, shown) && row.version_deleted === 0)?.version_id
                  for (const version of message.versions) {
                    if (!own.some((row) => same(row, version))) {
                      const id = yield* insertVersion(match.slot_id, next++, version)
                      if (version === shown) selected = id
                      changed = true
                    }
                  }
                  // A local selection, edit, hide or deletion stays the user's. Import
                  // selections advance their baseline with the slot's optimistic revision.
                  if (!showsSelected && selected !== undefined && match.locally_changed === 0 && match.deleted === 0) {
                    yield* recordHistoryReduction(sql, match.slot_id, shown.content, null, fileFork.id)
                    yield* writeSelect(sql, { id: fileFork.id, chatId }, match.slot_id, selected, "import")
                    showsSelected = true
                    changed = true
                  }
                  if (changed) updated++
                }
                if (placeholder === undefined && (!showsSelected || match.hidden !== (message.hidden ? 1 : 0)))
                  differing++
                parent = { id: match.slot_id, depth: match.depth, lane_id: laneId }
                slotIds.push(match.slot_id as SlotId)
                continue
              }
              // A writer change (or a new unmatched message) replaces the remaining
              // path. Keep a fork with local choices on that suffix on its existing
              // path, just as when it has a local continuation. Store ST's new path
              // in the record without moving the user off their work.
              keepTip ||= yield* changedSuffix(parent === null ? 0 : parent.depth + 1)
              matching = false
            }
            const slotId = uuidv7()
            let selected = ""
            for (const [ordinal, version] of message.versions.entries()) {
              const id = yield* insertVersion(slotId, ordinal, version)
              if (ordinal === chosen) selected = id
            }
            const depth = parent === null ? 0 : parent.depth + 1
            yield* sql`INSERT INTO slots ${sql.insert({
              id: slotId,
              chat_id: chatId,
              lane_id: laneId,
              fork_id: fileFork.id,
              parent_slot_id: parent?.id ?? null,
              depth,
              selected_version_id: selected,
              context_excluded: message.hidden ? 1 : 0,
              created_at: message.versions[chosen]!.at
            })}`
            firstAdded ??= slotId
            parent = { id: slotId, depth, lane_id: laneId }
            slotIds.push(slotId as SlotId)
            added++
          }
          // The import is alive (the sweep goes by a record's last activity), and where the
          // file first went its own way is kept, for a run that resumes this one.
          // A new chat's leaf follows its messages, so a chat whose import stops shows them,
          // unless the user moved it: only from unset, or where the import last put it.
          let advanced = payload.advanced ?? null
          const tip = slotIds.length === 0 ? undefined : yield* relocatedEnd(fileFork, slotIds.at(-1)!)
          if (
            (input.advanceLeaf || payload.end == null || added > 0 || payload.advanced != null) &&
            !branchDeleted &&
            !keepTip &&
            tip !== undefined &&
            fileFork.deleted_at === null &&
            (fileFork.tip_slot_id === null || fileFork.tip_slot_id === previousTip)
          ) {
            yield* sql`UPDATE forks SET tip_slot_id = ${tip}, row_version = row_version + 1 WHERE id = ${fileFork.id}`
            advanced = tip
          }
          const progress: RecordPayload = {
            ...payload,
            forkId: fileFork.id,
            firstAdded: payload.firstAdded ?? firstAdded,
            advanced,
            branchDeleted,
            keepTip,
            forkPrior,
            last: slotIds.at(-1) ?? payload.last ?? null
          }
          yield* sql`UPDATE jobs SET updated_at = ${Date.now()}, payload_json = ${JSON.stringify(progress)}
            WHERE id = ${input.recordId}`
          return { slotIds, matching, added, updated, differing }
        }).pipe(transaction(sql, "StImportMessages"))
      }),

    StImportFinishChat: (input) =>
      Effect.gen(function* () {
        const { userId, chatId } = input
        yield* ownedChat(userId, chatId)
        const payload = yield* leased(userId, input.recordId, chatId, input.lease)
        const fileFork = yield* recordFork(payload)
        if (input.position !== null) yield* ownedSlot(chatId, input.position)
        const target = input.leaf === null ? null : yield* ownedSlot(chatId, input.leaf)
        if (input.end !== null) yield* ownedSlot(chatId, input.end)
        // Include dormant positional choices too: a later restore or swipe must retain
        // them. The lineage and suppression rules keep other forks' choices out.
        const local = yield* sql<{ key: StateEventData["key"]; value_json: string }>`
          ${pathEvents(sql, chatId, fileFork.tip_slot_id)}
          SELECT e.key, e.value_json FROM path_events e WHERE e.origin <> 'import'
            AND e.scope IS NULL AND ${eventApplies(sql, fileFork.id, "e")}`
        const localTargets = new Set(
          local.flatMap((e) => stateTargets({ key: e.key, value: JSON.parse(e.value_json) } as StateEventData))
        )
        const keepNote = Effect.fnUntraced(function* (id: string | undefined) {
          if (id === undefined) return false
          if (localTargets.has(`note:${id}`)) return true
          const [row] = yield* sql<{ changed: number }>`SELECT e.deleted_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM entity_refs r JOIN entity_revisions h ON h.id = r.head_revision_id
            WHERE r.entity_id = e.id AND r.ref_kind = 'upstream' AND h.origin <> 'import'
          ) AS changed FROM entities e WHERE e.id = ${id}`
          return row?.changed === 1
        })
        const notes: Record<string, EntityId> = {
          ...input.previousNotes,
          ...(payload.notes as Record<string, EntityId> | undefined)
        }
        for (const note of input.notes) {
          const replaced = notes[note.kind]
          if (yield* keepNote(replaced)) continue
          if (replaced !== undefined) {
            // The chat already has this ST note, from the file's parent or an earlier import of
            // it: its new text is a revision of that note bound in this file's fork from here,
            // as an edit there is (DESIGN §3.4), so each fork shows its own file's text and
            // the chat has one such note. A new note here showed up in every fork, switched off
            // in all but this one (owner, 2026-11-01).
            const [ref] = yield* sql<{ head_revision_id: string }>`
              SELECT head_revision_id FROM entity_refs WHERE entity_id = ${replaced} AND ref_kind = 'upstream'`
            const revision = yield* insertNoteRevisions(
              replaced,
              chatId,
              payload.source,
              note,
              ref!.head_revision_id,
              Date.now()
            )
            yield* insertEvent(
              userId,
              chatId,
              input.position,
              { key: "note.binding", value: { note: replaced, revision: revision as never } },
              fileFork.id
            )
            yield* insertEvent(
              userId,
              chatId,
              input.position,
              { key: note.activate ? "note.activate" : "note.deactivate", value: { note: replaced } },
              fileFork.id
            )
            continue
          }
          const entity = yield* insertNote(userId, chatId, payload.source, note)
          if (note.activate) {
            yield* insertEvent(
              userId,
              chatId,
              input.position,
              { key: "note.activate", value: { note: entity } },
              fileFork.id
            )
          }
          notes[note.kind] = entity
        }
        // A note the file no longer has (an emptied author's note) stops applying.
        for (const kind of input.removedNotes) {
          const gone = notes[kind]
          if (gone === undefined) continue
          if (yield* keepNote(gone)) continue
          yield* insertEvent(
            userId,
            chatId,
            input.position,
            { key: "note.deactivate", value: { note: gone } },
            fileFork.id
          )
          delete notes[kind]
        }
        for (const event of input.events)
          if (!stateTargets(event).some((target) => localTargets.has(target)))
            yield* insertEvent(userId, chatId, input.position, event, fileFork.id)
        // ST records a file's cast separately from its versions. Pin that imported cast
        // once; a later re-import or a local cast change must not rewrite old participation.
        const importedCast = foldState(input.events.map((data) => ({ scope: null, data }))).participants
        yield* sql`${pathSegments(sql, chatId, input.end, null)}
          UPDATE versions SET cast_json = ${JSON.stringify(importedCast)}
          WHERE origin = 'imported' AND cast_json IS NULL AND slot_id IN (
            SELECT s.id FROM segments g CROSS JOIN slots s
            WHERE s.chat_id = ${chatId} AND s.chain_id = g.chain_id AND s.depth BETWEEN g.lo AND g.hi
          )`
        // Advance only this file's fork, preserving a continuation made locally.
        if (
          fileFork.deleted_at === null &&
          !payload.keepTip &&
          target?.deleted_at === null &&
          (fileFork.tip_slot_id === null ||
            fileFork.tip_slot_id === (yield* relocatedEnd(fileFork, payload.advanced ?? payload.end ?? null)))
        )
          yield* sql`UPDATE forks SET tip_slot_id = ${input.leaf}, row_version = row_version + 1 WHERE id = ${fileFork.id} AND tip_slot_id IS NOT ${input.leaf}`
        if (!payload.merged && payload.title !== undefined)
          yield* sql`UPDATE chats SET title = ${payload.title} WHERE id = ${chatId} AND title = ${unfinishedTitle(payload.title)}`
        yield* sql`UPDATE chats SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
          last_message_at = max(coalesce(last_message_at, 0), coalesce(${input.lastMessageAt}, 0)), row_version = row_version + 1
          WHERE id = ${chatId}`
        const updated: RecordPayload = {
          ...payload,
          forkId: fileFork.id,
          stCurrent: input.stCurrent === true,
          ...(input.fork === null ? {} : { parentRecordId: input.fork.parentRecordId }),
          sha256: input.sha256,
          state: input.stateJson,
          notes,
          end: input.end,
          firstAdded: null,
          advanced: null,
          lease: null,
          forkPrior: null,
          prior: null,
          keepTip: false
        }
        yield* sql`UPDATE jobs SET status = 'complete', payload_json = ${JSON.stringify(updated)}, updated_at = ${Date.now()}
          WHERE id = ${input.recordId}`
        yield* openOnStCurrent(userId, chatId, input.stCurrent === true ? fileFork.id : null)
        // The shell's summaries of the finished chat, last, at the stamps this write left.
        yield* refreshChatSummaries(sql, userId, chatId)
        return { notes }
      }).pipe(transaction(sql, "StImportFinishChat")),

    // The import's hidden messages up to a slot shown again, in the fork through it (a `hide`
    // row of its own, spec/FORK-INDEPENDENCE-DELTA.md §2.4): other forks keep their hides.
    StImportUnhide: ({ userId, chatId, throughSlotId, forkId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        yield* ownedSlot(chatId, throughSlotId)
        const fork = yield* viewAt(sql, chatId, throughSlotId)
        if (fork === null) return { unhidden: 0 }
        const rows = yield* sql<{ id: string }>`
          WITH RECURSIVE path(id, parent) AS (
            SELECT id, parent_slot_id FROM slots WHERE id = ${throughSlotId}
            UNION ALL
            SELECT s.id, s.parent_slot_id FROM slots s JOIN path p ON s.id = p.parent
          )
          SELECT s.id FROM path p JOIN slots s ON s.id = p.id WHERE ${contextExcludedIn(sql, fork)} = 1`
        for (const row of rows)
          yield* writeOverride(
            sql,
            { id: fork, chatId },
            { kind: "hide", targetId: row.id, slotId: row.id, valueId: null, flag: 0 }
          )
        return { unhidden: rows.length }
      }).pipe(inFork(sql, chatId, forkId, throughSlotId), transaction(sql, "StImportUnhide")),

    StImportClaim: ({ userId, recordId, lease, parentRecordId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ status: string; payload_json: string; deleted_at: number | null }>`
          SELECT j.status, j.payload_json, coalesce(c.deleted_at, f.deleted_at) AS deleted_at FROM jobs j
          JOIN chats c ON c.id = json_extract(j.payload_json, '$.chatId') AND c.owner_user_id = ${userId}
          LEFT JOIN forks f ON f.id = json_extract(j.payload_json, '$.forkId')
          WHERE j.id = ${recordId} AND j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD}`
        if (!row) return yield* new NotFound({ entity: "import record", id: recordId })
        // A run that's over takes nothing; the current one takes its own lease, or one of a
        // run that's over, whatever the record's state.
        yield* current(userId, lease, recordId)
        const payload = JSON.parse(row.payload_json) as RecordPayload
        const prior = payload.last ?? payload.end ?? null
        const fileFork = yield* recordFork(payload)
        const parentId = parentRecordId ?? payload.parentRecordId
        if (parentRecordId !== undefined) yield* record(userId, parentRecordId)
        yield* sql`UPDATE jobs SET payload_json = ${JSON.stringify({
          ...payload,
          lease,
          prior,
          forkId: fileFork.id,
          ...(parentId === undefined ? {} : { parentRecordId: parentId }),
          branchDeleted: false
        })}, updated_at = ${Date.now()}
          WHERE id = ${recordId}`
        return {
          forkId: fileFork.id as ForkId,
          recordId,
          source: payload.source,
          chatId: payload.chatId as ChatId,
          complete: row.status === "complete",
          binned: row.deleted_at !== null,
          stateJson: payload.state ?? "null",
          notes: (payload.notes ?? {}) as Record<string, EntityId>,
          end: (payload.end ?? null) as SlotId | null,
          merged: payload.merged ?? false,
          firstAdded: (payload.firstAdded ?? null) as SlotId | null
        }
      }).pipe(transaction(sql, "StImportClaim"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
