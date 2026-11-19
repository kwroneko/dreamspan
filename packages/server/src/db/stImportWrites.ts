import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { readSetting, putUserSetting } from "./settings.ts"
import type { StImportPrefix } from "./stImportPrefix.ts"
import { insertStMessageBatch, prepareStMessageBatch } from "./stMessageBatch.ts"
import { recordCardArrival, recordChatArrival } from "./stArrival.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { recordHistoryReduction } from "./historyChanges.ts"
import { refreshChatSummaries } from "./forkSummaries.ts"
import {
  inFork,
  viewAt,
  writeOverride,
  writeSelect,
  nextSeq,
  insertFork,
  slotDeletedIn,
  eventApplies
} from "./forkState.ts"
import { pathEvents, pathSegments } from "./pathSegments.ts"
import { forkImportSlot } from "./stImportFork.ts"
import {
  placeStMessages,
  type RecordPayload,
  StPlacedMessages,
  type StPlacedMessage,
  type StPlacedVersion
} from "./stImportPlace.ts"
import { type ForkRow, recordedColumns } from "./rows.ts"
// Write handlers for the ST data folder import (ARCHITECTURE.md §13). Each is one
// transaction in the writer, and a chat goes in over several: its start, its messages in
// batches, its state. Nothing here reads a file: the format worker parsed them, and the main
// thread resolved what the messages name.
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { NOTE_SCHEMA_VERSION, type NoteDoc } from "@dreamspan/shared/docs/note.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { validateDoc } from "@dreamspan/shared/editing.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { unfinishedTitle } from "@dreamspan/shared/stImportApi.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { docHash, searchText } from "./documents.ts"
import { ImportLeaseLost, NotFound, ST_CHAT_RECORD, ST_IMPORT_RUN, type StImportNote, WriteOps } from "./ops.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { transaction } from "./tx.ts"
import { toStorageError } from "./connection.ts"
import { stImportChatStamp } from "./stImportPlanStamp.ts"
import { addCounts, emptyCounts, emptyDigest, planCounter, sameCounts } from "./stImportPlanCount.ts"
import {
  emptyWriteProgress,
  resolveStNote,
  stepWriteProgress,
  stFinishAt,
  stImportedCast,
  type StStagedBatch,
  stStateHash
} from "./stImportProgress.ts"
import { newEvent, type PlaceEvent } from "./stImportPlace.ts"
import { planTipRef, type StPlanTip, stepPlanTip } from "./stImportPlanOps.ts"
import { StImportPlanChanged, ST_UNPLANNED_CHAT_MESSAGE } from "@dreamspan/shared/stReimportPlan.ts"
import {
  DEFAULT_PERSONA,
  DEFAULT_PRESET,
  GLOBAL_REGEX,
  newChatLcmSettings,
  ownedPersona,
  ownedPreset
} from "./generationSettings.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]
type Payload<K extends keyof Handlers> = Parameters<Handlers[K]>[0]

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

export const makeStImportWriteHandlers = Effect.fnUntraced(function* (prefix: StImportPrefix) {
  const sql = yield* SqlClient.SqlClient

  const ownedChat = (userId: UserId, chatId: ChatId) =>
    sql<{ id: string; kind: string; active_leaf_slot_id: string | null }>`
      SELECT id, kind, active_leaf_slot_id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) =>
        row && chatKinds.get(row.kind)?.allowsStImport
          ? Effect.succeed(row)
          : Effect.fail(new NotFound({ entity: row ? "importable chat" : "chat", id: chatId }))
      )
    )

  const ownedSlot = (chatId: string, slotId: string) =>
    sql<{ id: string; depth: number; deleted_at: number | null }>`
      SELECT id, depth, deleted_at FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`.pipe(
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

  /** Staging cannot resume after a job ended, including a late in-flight part after Finish. */
  const stagingCurrent = (userId: UserId, lease: string, path: string) =>
    Effect.gen(function* () {
      yield* current(userId, lease, path)
      const [ended] = yield* sql`SELECT id FROM st_import_jobs WHERE owner_user_id = ${userId}
      AND id = ${lease} AND status <> 'running'
        AND NOT (status = 'complete' AND EXISTS (
          SELECT 1 FROM json_each(report_json, '$.links') choice WHERE choice.value ->> '$.path' = ${path}
        ))`
      if (ended !== undefined) return yield* new ImportLeaseLost({ recordId: path })
    })

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

  /** The record and, unless it goes into `into`, the chat of a chat file's first import. */
  /** `once`: refused (`ImportLeaseLost`) if the file has a record already, as a confirmed write is. */
  const startChat = (
    {
      userId,
      source,
      title,
      createdAt,
      chatId: into,
      lease,
      parentRecordId,
      arrival,
      groupId
    }: Payload<"StImportStartChat">,
    once = false
  ) =>
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
      // One record a file: a confirmed write that found none takes the file only if none was made since.
      if (once) {
        const [taken] = yield* sql<{ id: string }>`SELECT id FROM jobs WHERE owner_user_id = ${userId}
          AND kind = ${ST_CHAT_RECORD} AND json_extract(payload_json, '$.source') = ${source} LIMIT 1`
        if (taken !== undefined) return yield* new ImportLeaseLost({ recordId: taken.id })
      }
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
    })

  /** When the batch's cards, and the chat, first showed up: from its messages' dates. */
  const arrivalsOf = (
    messages: ReadonlyArray<StPlacedMessage>,
    arrivalRefs: Readonly<Record<string, string>> | undefined
  ) => {
    const arrivals = new Map<string, number>()
    for (const message of messages) {
      if (message.arrivalAt == null) continue
      const ref = message.speaker === null ? undefined : arrivalRefs?.[message.speaker]
      if (ref !== undefined) arrivals.set(ref, Math.min(arrivals.get(ref) ?? Infinity, message.arrivalAt))
    }
    const firstAt = messages.reduce<number | null>(
      (first, message) => (message.arrivalAt == null ? first : Math.min(first ?? Infinity, message.arrivalAt)),
      null
    )
    return { arrivals, firstAt }
  }

  /**
   * One batch of a chat file into its chat, inside the caller's transaction: `cached`, the
   * prefix the trie already matched; `prepared`, the batch's slots made ready for a bulk
   * insert; `inserted`, all of it inserted so (`matching` off). `observe` hears what the matcher
   * did with each message, as the re-import preview counts it.
   */
  const placeBatch = (
    input: Omit<Payload<"StImportMessages">, "messagesJson" | "hashes">,
    messages: ReadonlyArray<StPlacedMessage>,
    cached: ReadonlyArray<SlotId>,
    prepared: ReturnType<typeof prepareStMessageBatch> | null,
    observe: (event: PlaceEvent) => void,
    onInvalidate: () => void
  ) =>
    Effect.gen(function* () {
      const batch = input.matching ? null : prepared
      const { arrivals, firstAt } = arrivalsOf(messages, input.arrivalRefs)
      const { userId, chatId, speakers } = input
      yield* ownedChat(userId, chatId)
      const payload = yield* leased(userId, input.recordId, chatId, input.lease)
      const fileFork = yield* recordFork(payload)
      const previousTip = yield* relocatedEnd(fileFork, payload.advanced ?? payload.end ?? payload.last ?? null)
      // Every speaker must be one of the user's live cards.
      const named = [...new Set(Object.values(speakers).filter((id): id is EntityId => id !== null))]
      for (const entity of named) {
        const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entities
        WHERE id = ${entity} AND owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL`
        if (row?.n !== 1) return yield* new NotFound({ entity: "entity", id: entity })
      }
      let parent: { id: string; depth: number } | null =
        input.parentSlotId === null ? null : yield* ownedSlot(chatId, input.parentSlotId)
      if (input.groupId !== undefined)
        yield* sql`UPDATE chats SET st_group_id = ${input.groupId} WHERE id = ${chatId} AND owner_user_id = ${userId}`
      if (input.groupArrival !== undefined) yield* recordChatArrival(sql, userId, chatId, input.groupArrival)
      for (const [ref, at] of arrivals) yield* recordCardArrival(sql, userId, ref, { at, basis: 1 })
      if (firstAt !== null) yield* recordChatArrival(sql, userId, chatId, { at: firstAt, basis: 1 })
      let firstAdded: string | null = null
      let added = 0
      const slotIds: Array<SlotId> = [...cached]
      if (cached.length > 0) parent = yield* ownedSlot(chatId, cached.at(-1)!)
      if (batch !== null) {
        yield* insertStMessageBatch(sql, batch, {
          chatId,
          forkId: fileFork.id,
          parentId: parent?.id ?? null,
          depth: parent === null ? 0 : parent.depth + 1
        })
        firstAdded = batch.slotIds[0] ?? null
        slotIds.push(...batch.slotIds)
        added = batch.slotIds.length
        for (const index of batch.slotIds.keys()) observe(newEvent(index, false))
      }
      // The matcher (stImportPlace.ts), with writes that store. The re-import preview
      // runs the same matcher with writes that only count.
      const insertVersion = (slotId: string, ordinal: number, version: StPlacedVersion, message: StPlacedMessage) =>
        sql<{ id: string }>`INSERT INTO version_records ${sql.insert({
          id: uuidv7(),
          slot_id: slotId,
          authoring_fork_id: fileFork.id,
          ordinal,
          status: "complete",
          speaker_entity_id: message.speaker === null ? null : (speakers[message.speaker] ?? null),
          writer: message.user ? "human" : "model",
          content: version.content,
          macro_mode: "verbatim",
          origin: "imported",
          reasoning: version.reasoning,
          reply_sections: version.sections ? JSON.stringify(version.sections) : null,
          ...recordedColumns(version.generation),
          created_at: version.at,
          updated_at: version.at
        })} RETURNING id`.pipe(Effect.map(([row]) => row!.id))
      const rest = batch === null ? messages.slice(cached.length) : []
      const placed = yield* placeStMessages(
        sql,
        {
          chatId,
          fileFork,
          payload,
          parent,
          messages: rest,
          matching: input.matching,
          strict: input.strict
        },
        {
          copy: (source, parentId) => forkImportSlot(sql, source, parentId, fileFork.id),
          addVersion: insertVersion,
          select: (slotId, versionId, shown) =>
            Effect.andThen(
              recordHistoryReduction(sql, slotId, shown.content, null, fileFork.id),
              writeSelect(sql, { id: fileFork.id, chatId }, slotId, versionId, "import")
            ),
          newSlot: (message, chosen, under, depth) =>
            Effect.gen(function* () {
              const slotId = uuidv7()
              let selected = ""
              for (const [ordinal, version] of message.versions.entries()) {
                const id = yield* insertVersion(slotId, ordinal, version, message)
                if (ordinal === chosen) selected = id
              }
              yield* sql`INSERT INTO slots ${sql.insert({
                id: slotId,
                chat_id: chatId,
                fork_id: fileFork.id,
                parent_slot_id: under?.id ?? null,
                depth,
                selected_version_id: selected,
                context_excluded: message.hidden ? 1 : 0,
                created_at: message.versions[chosen]!.at
              })}`
              return slotId
            }),
          bulk:
            prepared === null
              ? null
              : (under) =>
                  Effect.as(
                    insertStMessageBatch(sql, prepared, {
                      chatId,
                      forkId: fileFork.id,
                      parentId: under?.id ?? null,
                      depth: under === null ? 0 : under.depth + 1
                    }),
                    prepared.slotIds
                  )
        },
        // Indices among the messages given: the trie's matched prefix comes first.
        (event) => observe({ ...event, index: event.index + cached.length })
      ).pipe(
        // A batch that fails part way rolls back; its cached prefix is dropped all the same.
        Effect.onError(() => Effect.sync(onInvalidate))
      )
      if (placed.invalidatesPrefix) onInvalidate()
      firstAdded ??= placed.firstAdded
      added += placed.added
      slotIds.push(...placed.slotIds)
      const { branchDeleted, keepTip, matching, updated, differing } = placed
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
        forkPrior: payload.forkPrior ?? null,
        last: slotIds.at(-1) ?? payload.last ?? null
      }
      yield* sql`UPDATE jobs SET updated_at = ${Date.now()}, payload_json = ${JSON.stringify(progress)}
        WHERE id = ${input.recordId}`
      return { slotIds, matching, added, updated, differing, keepTip }
    })

  /**
   * A chat file's finish (`StImportFinishChat`), inside the caller's transaction. `planned`: a
   * confirmed write's, whose plan named the versions the cast goes on (`cast`: those still
   * without one, and how many more were written with it, each a shell stamp the update would
   * have moved), and whose shell summaries are computed after it, in a reader.
   */
  const finishChat = (
    input: Payload<"StImportFinishChat">,
    planned: { readonly cast: ReadonlyArray<string>; readonly castWritten: number } | null = null
  ) =>
    Effect.gen(function* () {
      const { userId, chatId } = input
      yield* ownedChat(userId, chatId)
      const payload = yield* leased(userId, input.recordId, chatId, input.lease)
      const fileFork = yield* recordFork(payload)
      const at = input.position === null ? null : yield* ownedSlot(chatId, input.position)
      // Where the file's first import's state applies from, which a branch of it forking
      // earlier doesn't inherit (StImports.ts `inheritedState`).
      const stateAt = payload.stateAt ?? (payload.state === undefined ? (at?.depth ?? 0) : undefined)
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
          WHERE r.entity_id = e.id AND h.origin <> 'import'
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
            SELECT head_revision_id FROM entity_refs WHERE entity_id = ${replaced}`
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
      const importedCast = stImportedCast(input.events)
      if (planned === null)
        yield* sql`${pathSegments(sql, chatId, input.end, null)}
          UPDATE version_records SET cast_json = ${JSON.stringify(importedCast)}
          WHERE origin = 'imported' AND cast_json IS NULL AND slot_id IN (
            SELECT s.id FROM segments g CROSS JOIN slots s
            WHERE s.chat_id = ${chatId} AND s.chain_id = g.chain_id AND s.depth BETWEEN g.lo AND g.hi
          )`
      else {
        if (planned.cast.length > 0)
          yield* sql`UPDATE version_records SET cast_json = ${JSON.stringify(importedCast)}
            WHERE id IN (SELECT value FROM json_each(${JSON.stringify(planned.cast)}))
              AND origin = 'imported' AND cast_json IS NULL`
        if (planned.castWritten > 0)
          yield* sql`UPDATE chats SET shell_stamp = shell_stamp + ${planned.castWritten} WHERE id = ${chatId}`
      }
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
        ...(stateAt === undefined ? {} : { stateAt }),
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
      if (planned === null) yield* refreshChatSummaries(sql, userId, chatId)
      return { notes, ...(stateAt === undefined ? {} : { stateAt }) }
    })

  /** Makes `lease` the run that may write a recorded file's chat (`StImportClaim`). */
  const claim = ({ userId, recordId, lease, parentRecordId }: Payload<"StImportClaim">) =>
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
        firstAdded: (payload.firstAdded ?? null) as SlotId | null,
        ...(parentId === undefined ? {} : { parentRecordId: parentId }),
        ...(payload.stateAt === undefined ? {} : { stateAt: payload.stateAt })
      }
    })

  /**
   * A confirmed write of a file into a chat already here, as the reader planned it batch by
   * batch (stImportPlanOps.ts). Everything that isn't confirming and writing happens before the
   * transaction: the plan's matching, its counts against the check's, the rows with their ids,
   * the record's and fork's progress. The transaction confirms the chat is as the plans read it
   * (its stamp, which every plan carries) and that this run still holds the file, then applies
   * the rows: a statement per kind of row, not per message.
   */
  const commitPlanned = (
    input: Payload<"StImportCommitChat">,
    decoded: ReadonlyArray<{ readonly batch: StStagedBatch; readonly messages: ReadonlyArray<StPlacedMessage> }>
  ) =>
    Effect.gen(function* () {
      const { userId, lease, path, finish } = input
      const changed = () => new StImportPlanChanged({ message: "Changed since the check. Not imported." })
      const plans = decoded.map(({ batch }) => batch.plan!)
      if (decoded.length !== input.batches || plans.some((plan) => plan.stamp !== input.stamp)) return yield* changed()
      const progress = emptyWriteProgress(input.matching)
      const slotIds: Array<SlotId> = []
      const counts = emptyCounts()
      for (const plan of plans) {
        stepWriteProgress(progress, plan, finish.prevEnd, finish.hiddenRun, [])
        slotIds.push(...plan.slotIds)
        addCounts(counts, plan.counts)
      }
      const last = plans.at(-1)!
      // Placed as the check showed, message by message, or not at all.
      if (
        input.expect !== null &&
        (!sameCounts(counts, input.expect.counts) ||
          last.digest !== input.expect.digest ||
          last.keepTip !== input.expect.keepsTip)
      )
        return yield* changed()
      const { position, applies, leaf } = stFinishAt({ ...finish, ...progress })
      const events = applies ? finish.events : []
      const castJson = JSON.stringify(stImportedCast(events))
      // The rows, with the ids the plan gave them.
      const versionRows: Array<Record<string, unknown>> = []
      const selects: Array<{ slot: string; version: string; content: string }> = []
      const tails: Array<{
        prepared: ReturnType<typeof prepareStMessageBatch>
        under: { readonly id: string; readonly depth: number } | null
      }> = []
      const cast: Array<string> = []
      let castWritten = 0
      const named = new Set<EntityId>()
      const cardArrivals = new Map<string, number>()
      let firstAt: number | null = null
      for (const [index, { batch, messages }] of decoded.entries()) {
        const plan = plans[index]!
        for (const op of plan.ops) {
          const message = messages[op.m]!
          const version = message.versions[op.v]!
          if (op.k === "s") {
            selects.push({ slot: op.slot, version: op.version, content: version.content })
            continue
          }
          versionRows.push({
            id: op.id,
            slot_id: op.slot,
            ordinal: op.ordinal,
            speaker_entity_id: message.speaker === null ? null : (batch.speakers[message.speaker] ?? null),
            writer: message.user ? "human" : "model",
            content: version.content,
            reasoning: version.reasoning,
            reply_sections: version.sections ? JSON.stringify(version.sections) : null,
            ...recordedColumns(version.generation),
            created_at: version.at,
            updated_at: version.at
          })
          cast.push(op.id)
        }
        cast.push(...plan.uncast)
        if (plan.tail !== null) {
          const prepared = prepareStMessageBatch(
            messages.slice(plan.tail.from),
            batch.speakers,
            plan.tail.ids,
            castJson
          )
          castWritten += prepared.versions
          tails.push({ prepared, under: plan.tail.parent })
        }
        for (const id of Object.values(batch.speakers)) if (id !== null) named.add(id)
        const arrived = arrivalsOf(messages, batch.arrivalRefs)
        for (const [ref, at] of arrived.arrivals) cardArrivals.set(ref, Math.min(cardArrivals.get(ref) ?? Infinity, at))
        if (arrived.firstAt !== null) firstAt = Math.min(firstAt ?? Infinity, arrived.firstAt)
      }
      const versionsJson = JSON.stringify(versionRows)
      // The state, with the summary named by the slots its messages go to.
      const state = JSON.parse(finish.stateJson) as Record<string, unknown> | null
      const prevState = JSON.parse(finish.prevStateJson) as Record<string, unknown> | null
      const notes: Array<StImportNote> = []
      for (const note of finish.notes) {
        if (note.kind !== "imported_summary") {
          notes.push(note)
          continue
        }
        const resolved = resolveStNote(note, slotIds)
        const { modifiedAt: _dated, ...mapped } = resolved
        const summary = stStateHash(mapped)
        if (state !== null) state.summary = summary
        if (summary !== (finish.baseSummary === undefined ? prevState?.summary : finish.baseSummary))
          notes.push(resolved)
      }
      const stateJson = applies ? JSON.stringify(state) : finish.prevStateJson
      return yield* Effect.gen(function* () {
        yield* stagingCurrent(userId, lease, path)
        if ((yield* stImportChatStamp(sql, userId, input.chatId!)) !== input.stamp) return yield* changed()
        const target =
          input.claim !== null
            ? yield* claim({ userId, lease, ...input.claim })
            : input.start !== null
              ? yield* startChat({ userId, lease, source: path, chatId: input.chatId, ...input.start }, true)
              : yield* Effect.die(new Error("a commit names neither a record nor a start"))
        const { chatId, recordId } = target
        if (chatId !== input.chatId) return yield* changed()
        const payload = yield* leased(userId, recordId, chatId, lease)
        const fileFork = yield* recordFork(payload)
        // Every speaker must be one of the user's live cards.
        for (const entity of named) {
          const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM entities
            WHERE id = ${entity} AND owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL`
          if (row?.n !== 1) return yield* new NotFound({ entity: "entity", id: entity })
        }
        if (input.groupId !== undefined)
          yield* sql`UPDATE chats SET st_group_id = ${input.groupId} WHERE id = ${chatId} AND owner_user_id = ${userId}`
        if (input.groupArrival !== undefined) yield* recordChatArrival(sql, userId, chatId, input.groupArrival)
        for (const [ref, at] of cardArrivals) yield* recordCardArrival(sql, userId, ref, { at, basis: 1 })
        if (firstAt !== null) yield* recordChatArrival(sql, userId, chatId, { at: firstAt, basis: 1 })
        if (versionRows.length > 0)
          yield* sql`INSERT INTO version_records (id, slot_id, ordinal, status, speaker_entity_id, writer, content,
            macro_mode, origin, authoring_fork_id, reasoning, reply_sections, recorded_model_json,
            recorded_generation_json, created_at, updated_at)
            SELECT value ->> '$.id', value ->> '$.slot_id', value ->> '$.ordinal', 'complete',
              value ->> '$.speaker_entity_id', value ->> '$.writer', value ->> '$.content', 'verbatim', 'imported',
              ${fileFork.id}, value ->> '$.reasoning', value ->> '$.reply_sections', value ->> '$.recorded_model_json',
              value ->> '$.recorded_generation_json', value ->> '$.created_at', value ->> '$.updated_at'
            FROM json_each(${versionsJson}) ORDER BY key`
        for (const select of selects) {
          yield* recordHistoryReduction(sql, select.slot, select.content, null, fileFork.id)
          yield* writeSelect(sql, { id: fileFork.id, chatId }, select.slot, select.version, "import")
        }
        for (const { prepared, under } of tails)
          yield* insertStMessageBatch(sql, prepared, {
            chatId,
            forkId: fileFork.id,
            parentId: under?.id ?? null,
            depth: under === null ? 0 : under.depth + 1
          })
        // The fork's tip and the record as the batches would have left them one by one.
        const ref = planTipRef(payload)
        const tip: StPlanTip = {
          tip: fileFork.tip_slot_id,
          moves: 0,
          payload,
          ref,
          relocated: yield* relocatedEnd(fileFork, ref)
        }
        for (const plan of plans)
          stepPlanTip(tip, plan, {
            advanceLeaf: input.advanceLeaf,
            forkId: fileFork.id,
            forkLive: fileFork.deleted_at === null
          })
        if (tip.moves > 0) {
          yield* sql`UPDATE forks SET tip_slot_id = ${tip.tip}, row_version = row_version + ${tip.moves}
            WHERE id = ${fileFork.id}`
          // Each move was a write of the fork, which moves the shell stamp.
          if (tip.moves > 1)
            yield* sql`UPDATE chats SET shell_stamp = shell_stamp + ${tip.moves - 1} WHERE id = ${chatId}`
        }
        yield* sql`UPDATE jobs SET updated_at = ${Date.now()}, payload_json = ${JSON.stringify(tip.payload)}
          WHERE id = ${recordId}`
        const finished = yield* finishChat(
          {
            userId,
            chatId,
            recordId,
            lease,
            position,
            events,
            notes: applies ? notes : [],
            removedNotes: applies ? finish.removedNotes : [],
            previousNotes: finish.previousNotes,
            leaf,
            end: progress.cursor,
            lastMessageAt: finish.lastMessageAt,
            sha256: finish.sha256,
            stateJson,
            fork: finish.fork,
            stCurrent: finish.stCurrent
          },
          { cast, castWritten }
        )
        yield* sql`DELETE FROM st_import_stage WHERE import_id = ${lease} AND path = ${path}`
        const stamp = yield* stImportChatStamp(sql, userId, chatId)
        const slots: Record<string, SlotId> = {}
        for (const index of input.slotsAt) {
          const slot = slotIds[index]
          if (slot !== undefined) slots[index] = slot
        }
        return {
          chatId,
          recordId,
          stamp: stamp!,
          progress: { ...progress },
          slots,
          notes: finished.notes,
          // As the unplanned path's: the run's later branches of this file walk up through it.
          ...(finished.stateAt === undefined ? {} : { stateAt: finished.stateAt })
        }
      }).pipe(transaction(sql, "StImportCommitChat"))
    })

  const handlers = {
    StImportDefaultPersona: ({ userId, importId, entityId }) =>
      Effect.gen(function* () {
        yield* current(userId, importId, importId)
        if (!(yield* ownedPersona(sql, userId, entityId)))
          return yield* new NotFound({ entity: "persona", id: entityId })
        const previous = yield* readSetting(sql, "user", userId, DEFAULT_PERSONA)
        if (previous.value !== null) return false
        yield* putUserSetting(sql, userId, DEFAULT_PERSONA, entityId)
        return true
      }).pipe(transaction(sql, "StImportDefaultPersona")),
    StImportDefaultPreset: ({ userId, importId, refId }) =>
      Effect.gen(function* () {
        yield* current(userId, importId, importId)
        if (!(yield* ownedPreset(sql, userId, refId))) return yield* new NotFound({ entity: "preset", id: refId })
        const previous = yield* readSetting(sql, "user", userId, DEFAULT_PRESET)
        if (previous.value !== null) return false
        yield* putUserSetting(sql, userId, DEFAULT_PRESET, refId)
        return true
      }).pipe(transaction(sql, "StImportDefaultPreset")),
    StImportGlobalRegex: ({ userId, importId, scripts }) =>
      Effect.gen(function* () {
        yield* current(userId, importId, importId)
        if (scripts.length === 0) return false
        const previous = yield* readSetting(sql, "user", userId, GLOBAL_REGEX)
        if (Array.isArray(previous.value) && previous.value.length > 0) return false
        yield* putUserSetting(sql, userId, GLOBAL_REGEX, scripts)
        return true
      }).pipe(transaction(sql, "StImportGlobalRegex")),
    StImportSummarySettings: ({ userId, importId, prompt, settings }) =>
      Effect.gen(function* () {
        yield* current(userId, importId, importId)
        yield* putUserSetting(sql, userId, "import.st.memory", JSON.parse(settings))
        if (prompt === null) return
        // Re-importing keeps an instruction the user has chosen since the import.
        const { value } = yield* readSetting(sql, "user", userId, "generation.lcm")
        const stored = (value ?? {}) as Record<string, unknown>
        if (stored.tail === undefined) yield* putUserSetting(sql, userId, "generation.lcm", { ...stored, tail: prompt })
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
        // What the runs before held for a confirmed re-import goes with them.
        yield* sql`DELETE FROM st_import_stage WHERE owner_user_id = ${userId}`
      }).pipe(transaction(sql, "StImportBegin")),

    StImportStartChat: (input) =>
      Effect.gen(function* () {
        // A confirmed import starts a new chat only while its run goes on: a Stop before then
        // leaves nothing. Once started, the chat's batches go in whatever comes.
        if (input.once === true) yield* stagingCurrent(input.userId, input.lease, input.source)
        return yield* startChat(input, input.once === true)
      }).pipe(
        transaction(sql, "StImportStartChat"),
        Effect.tap((target) =>
          Effect.sync(() => {
            if (input.chatId === null) prefix.created(target.chatId)
          })
        )
      ),

    StImportMessages: (input) =>
      // Decoded before the transaction, which holds only database work.
      Effect.gen(function* () {
        const messages = yield* Schema.decodeEffect(StPlacedMessages)(input.messagesJson).pipe(Effect.orDie)
        const cached = input.matching
          ? prefix.match(input.chatId, input.parentSlotId, messages, input.hashes, input.speakers)
          : []
        // Preparing a possible divergent suffix is outside the transaction. The common
        // prefix needs neither version decoding from SQLite nor swipe comparisons.
        const prepared =
          !input.matching || (input.hashes !== undefined && prefix.fresh(input.chatId))
            ? prepareStMessageBatch(messages.slice(cached.length), input.speakers)
            : null
        let invalidatesPrefix = false
        const result = yield* placeBatch(
          input,
          messages,
          cached,
          prepared,
          () => {},
          () => {
            invalidatesPrefix = true
          }
        ).pipe(
          transaction(sql, "StImportMessages"),
          // Keep cache work outside the transaction, including when the request is
          // interrupted after committing or a later statement rolls the batch back.
          Effect.ensuring(
            Effect.sync(() => {
              if (invalidatesPrefix) prefix.forget(input.chatId)
            })
          )
        )
        prefix.remember(input.chatId, input.parentSlotId, messages, input.hashes, input.speakers, result.slotIds)
        const { slotIds, matching, added, updated, differing } = result
        return { slotIds, matching, added, updated, differing }
      }),

    StImportFinishChat: ({ castWritten, ...input }) =>
      Effect.gen(function* () {
        if (castWritten === undefined) return yield* finishChat(input)
        const finished = yield* finishChat(input, { cast: [], castWritten })
        const payload = yield* record(input.userId, input.recordId)
        yield* sql`DELETE FROM st_import_stage WHERE import_id = ${input.lease} AND path = ${payload.source}`
        const stamp = yield* stImportChatStamp(sql, input.userId, input.chatId)
        return { ...finished, stamp: stamp! }
      }).pipe(transaction(sql, "StImportFinishChat")),

    StImportCommitBatch: (input) =>
      // Read and decoded before the transaction, which holds only database work.
      Effect.gen(function* () {
        const { userId, lease, path, seq, chatId, recordId } = input
        const [row] = yield* sql<{ batch_json: string }>`SELECT batch_json FROM st_import_stage
          WHERE owner_user_id = ${userId} AND import_id = ${lease} AND path = ${path} AND seq = ${seq}`.pipe(
          Effect.mapError(toStorageError("StImportCommitBatch"))
        )
        if (row === undefined) return yield* new ImportLeaseLost({ recordId })
        const batch = JSON.parse(row.batch_json) as StStagedBatch
        const messages = yield* Schema.decodeEffect(StPlacedMessages)(batch.messagesJson).pipe(Effect.orDie)
        const prepared = prepareStMessageBatch(messages, batch.speakers, undefined, input.castJson)
        const written = yield* Effect.gen(function* () {
          const placed = yield* placeBatch(
            {
              userId,
              chatId,
              recordId,
              lease,
              advanceLeaf: input.advanceLeaf,
              strict: false,
              parentSlotId: input.parentSlotId,
              matching: false,
              speakers: batch.speakers,
              ...(batch.arrivalRefs === undefined ? {} : { arrivalRefs: batch.arrivalRefs }),
              ...(input.groupArrival === undefined ? {} : { groupArrival: input.groupArrival }),
              ...(input.groupId === undefined ? {} : { groupId: input.groupId })
            },
            messages,
            [],
            prepared,
            () => {},
            () => {}
          )
          yield* sql`DELETE FROM st_import_stage WHERE import_id = ${lease} AND path = ${path} AND seq = ${seq}`
          return placed
        }).pipe(transaction(sql, "StImportCommitBatch"))
        const { slotIds, matching, added, updated, differing } = written
        return { slotIds, matching, added, updated, differing, versions: prepared.versions }
      }),

    StImportStage: ({ userId, lease, path, seq, batchJson }) =>
      Effect.gen(function* () {
        if (batchJson === null) yield* current(userId, lease, path)
        else yield* stagingCurrent(userId, lease, path)
        if (batchJson === null || seq === 0)
          yield* sql`DELETE FROM st_import_stage WHERE import_id = ${lease} AND path = ${path}`
        if (batchJson !== null)
          yield* sql`INSERT INTO st_import_stage ${sql.insert({
            owner_user_id: userId,
            import_id: lease,
            path,
            seq,
            batch_json: batchJson
          })}`
      }).pipe(transaction(sql, "StImportStage")),

    StImportCommitChat: (input) =>
      Effect.gen(function* () {
        const { userId, lease, path, finish } = input
        const staged = yield* sql<{ batch_json: string }>`SELECT batch_json FROM st_import_stage
          WHERE owner_user_id = ${userId} AND import_id = ${lease} AND path = ${path} ORDER BY seq`.pipe(
          Effect.mapError(toStorageError("StImportCommitChat"))
        )
        const decoded: Array<{ batch: StStagedBatch; messages: ReadonlyArray<StPlacedMessage> }> = []
        for (const row of staged) {
          const batch = JSON.parse(row.batch_json) as StStagedBatch
          const messages = yield* Schema.decodeEffect(StPlacedMessages)(batch.messagesJson).pipe(Effect.orDie)
          decoded.push({ batch, messages })
        }
        // A file the reader planned whole goes in as its plan says.
        if (input.chatId !== null && decoded.length > 0 && decoded.every(({ batch }) => batch.plan !== undefined))
          return yield* commitPlanned(input, decoded)
        // The public confirmed importer refuses these before staging. Fence direct or
        // delayed internal calls too: matching a legacy suffix copy here can hold the
        // sole writer for minutes. Refusal preserves the entire existing file's state.
        if (input.chatId !== null && decoded.some(({ batch }) => batch.plan === undefined))
          return yield* Effect.gen(function* () {
            yield* stagingCurrent(userId, lease, path)
            return yield* new StImportPlanChanged({ message: ST_UNPLANNED_CHAT_MESSAGE })
          }).pipe(transaction(sql, "StImportCommitChat"))
        const batches = decoded.map(({ batch, messages }) => ({
          batch,
          messages,
          prepared: prepareStMessageBatch(messages.slice(batch.cached?.length ?? 0), batch.speakers)
        }))
        return yield* Effect.gen(function* () {
          const changed = () => new StImportPlanChanged({ message: "Changed since the check. Not imported." })
          yield* stagingCurrent(userId, lease, path)
          // A new chat is claimed and created in this transaction too.
          if (input.chatId !== null && (yield* stImportChatStamp(sql, userId, input.chatId)) !== input.stamp)
            return yield* changed()
          const target =
            input.claim !== null
              ? yield* claim({ userId, lease, ...input.claim })
              : input.start !== null
                ? yield* startChat({ userId, lease, source: path, chatId: input.chatId, ...input.start }, true)
                : yield* Effect.die(new Error("a commit names neither a record nor a start"))
          const { chatId, recordId } = target
          if (input.chatId !== null && chatId !== input.chatId) return yield* changed()
          if (batches.length !== input.batches) return yield* changed()
          const progress = emptyWriteProgress(input.matching)
          const slotIds: Array<SlotId> = []
          const counts = emptyCounts()
          let digest = emptyDigest
          let keepsTip = false
          for (const { batch, messages, prepared } of batches) {
            const counter = planCounter(messages, progress.written, 0, digest)
            const cached = progress.matching ? (batch.cached ?? []) : []
            for (const index of cached.keys())
              counter.observe({
                index,
                outcome: "matched",
                addedVersions: 0,
                selected: false,
                differs: false,
                locallyChanged: false,
                deleted: false,
                hiddenDiffers: false,
                placeholder: false,
                branchFrom: false
              })
            const written = yield* placeBatch(
              {
                userId,
                chatId,
                recordId,
                lease,
                advanceLeaf: input.advanceLeaf,
                strict: input.strict,
                parentSlotId: progress.cursor,
                matching: progress.matching,
                speakers: batch.speakers,
                ...(batch.arrivalRefs === undefined ? {} : { arrivalRefs: batch.arrivalRefs }),
                ...(input.groupArrival === undefined ? {} : { groupArrival: input.groupArrival }),
                ...(input.groupId === undefined ? {} : { groupId: input.groupId })
              },
              messages,
              cached,
              prepared,
              counter.observe,
              () => {}
            )
            stepWriteProgress(progress, written, finish.prevEnd, finish.hiddenRun, [])
            slotIds.push(...written.slotIds)
            addCounts(counts, counter.counts)
            digest = counter.digest()
            keepsTip = written.keepTip
          }
          // Placed as the check showed, message by message, or not at all.
          if (
            input.expect !== null &&
            (!sameCounts(counts, input.expect.counts) ||
              digest !== input.expect.digest ||
              keepsTip !== input.expect.keepsTip)
          )
            return yield* changed()
          const { position, applies, leaf } = stFinishAt({ ...finish, ...progress })
          // The state, with the summary named by the slots its messages went to.
          const state = JSON.parse(finish.stateJson) as Record<string, unknown> | null
          const prevState = JSON.parse(finish.prevStateJson) as Record<string, unknown> | null
          const notes: Array<StImportNote> = []
          for (const note of finish.notes) {
            if (note.kind !== "imported_summary") {
              notes.push(note)
              continue
            }
            const resolved = resolveStNote(note, slotIds)
            const { modifiedAt: _dated, ...mapped } = resolved
            const summary = stStateHash(mapped)
            if (state !== null) state.summary = summary
            if (summary !== (finish.baseSummary === undefined ? prevState?.summary : finish.baseSummary))
              notes.push(resolved)
          }
          const finished = yield* finishChat({
            userId,
            chatId,
            recordId,
            lease,
            position,
            events: applies ? finish.events : [],
            notes: applies ? notes : [],
            removedNotes: applies ? finish.removedNotes : [],
            previousNotes: finish.previousNotes,
            leaf,
            end: progress.cursor,
            lastMessageAt: finish.lastMessageAt,
            sha256: finish.sha256,
            stateJson: applies ? JSON.stringify(state) : finish.prevStateJson,
            fork: finish.fork,
            stCurrent: finish.stCurrent
          })
          yield* sql`DELETE FROM st_import_stage WHERE import_id = ${lease} AND path = ${path}`
          const stamp = yield* stImportChatStamp(sql, userId, chatId)
          const slots: Record<string, SlotId> = {}
          for (const index of input.slotsAt) {
            const slot = slotIds[index]
            if (slot !== undefined) slots[index] = slot
          }
          return {
            chatId,
            recordId,
            stamp: stamp!,
            progress: { ...progress },
            slots,
            notes: finished.notes,
            ...(finished.stateAt === undefined ? {} : { stateAt: finished.stateAt })
          }
        }).pipe(transaction(sql, "StImportCommitChat"))
      }),

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

    StImportClaim: (input) => claim(input).pipe(transaction(sql, "StImportClaim"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
})
