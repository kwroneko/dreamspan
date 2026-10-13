// Write handlers for the ST data folder import (ARCHITECTURE.md §13). Each is one
// transaction in the writer, and a chat goes in over several: its start, its messages in
// batches, its state. Nothing here reads a file: the format worker parsed them, and the main
// thread resolved what the messages name.
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { NOTE_SCHEMA_VERSION, type NoteDoc } from "@rp/shared/docs/note.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { validateDoc } from "@rp/shared/editing.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { unfinishedTitle } from "@rp/shared/stImportApi.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { makeBin } from "./bin.ts"
import { docHash, searchText } from "./documents.ts"
import { ImportLeaseLost, NotFound, ST_CHAT_RECORD, ST_IMPORT_RUN, type StImportNote, WriteOps } from "./ops.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { transaction } from "./tx.ts"

/** A message as the format worker wrote it (formats/stChat.ts). */
const Message = Schema.Struct({
  user: Schema.Boolean,
  hidden: Schema.Boolean,
  speaker: Schema.NullOr(Schema.String),
  selected: Schema.Int,
  versions: Schema.NonEmptyArray(
    Schema.Struct({ content: Schema.String, reasoning: Schema.NullOr(Schema.String), at: Schema.Number })
  )
})
const Messages = Schema.fromJsonString(Schema.Array(Message))

/** What a record's payload holds. */
interface RecordPayload {
  readonly source: string
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
  /** This pass matched a deleted subtree root; later live additions remain behind it. */
  readonly branchDeleted?: boolean
}

export const makeStImportWriteHandlers = Effect.fnUntraced(function* (bin: ReturnType<typeof makeBin>) {
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

  /** An imported state event, after checking everything it names belongs to the user. */
  const insertEvent = (userId: UserId, chatId: string, slotId: string | null, data: StateEventData) =>
    Effect.gen(function* () {
      yield* checkStateReferences(sql, userId, chatId, data, null)
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
        origin: "import",
        origin_ref: null,
        created_at: Date.now()
      })}`
    })

  /** A chat-owned note: an entity with a revision per text, oldest first, and its upstream ref. */
  const insertNote = (userId: UserId, chatId: string, source: string, note: StImportNote) =>
    Effect.gen(function* () {
      const at = Date.now()
      const entityId = uuidv7()
      yield* sql`INSERT INTO entities ${sql.insert({ id: entityId, owner_user_id: userId, kind: "note", created_at: at })}`
      let parent: string | null = null
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
          kind: note.kind,
          ...(note.interval === undefined || !current ? {} : { interval: note.interval }),
          ...(note.template === undefined || !current ? {} : { template: note.template }),
          ...(note.covers === undefined || !current ? {} : { covers: note.covers }),
          ...(note.sources?.[index] ? { source_slot_id: note.sources[index] } : {})
        }
        const check = validateDoc("note", doc)
        if (!check.ok)
          return yield* Effect.die(new Error(`refusing to store an invalid note: ${check.problems.join("; ")}`))
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
          created_at: at
        })}`
        parent = id
      }
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
        updated_at: at
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

    StImportStartChat: ({ userId, source, title, createdAt, chatId: into, lease }) =>
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
            value_json: JSON.stringify({ enabled: false }),
            origin: "import",
            created_at: at
          })}`
        }
        // An earlier record of this file whose chat was deleted for good names nothing now.
        yield* sql`DELETE FROM jobs WHERE owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD}
          AND json_extract(payload_json, '$.source') = ${source}
          AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = json_extract(payload_json, '$.chatId'))`
        const payload: RecordPayload = { source, chatId, merged: into !== null, title, lease }
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
      Effect.flatMap(Schema.decodeEffect(Messages)(input.messagesJson).pipe(Effect.orDie), (messages) =>
        Effect.gen(function* () {
          const { userId, chatId, speakers } = input
          const chat = yield* ownedChat(userId, chatId)
          const payload = yield* leased(userId, input.recordId, chatId, input.lease)
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
          const firstDepth = parent === null ? 0 : parent.depth + 1
          const priorAt = (depth: number) =>
            Effect.gen(function* () {
              if (priorPath === null) {
                priorPath = new Map<number, string>()
                if (payload.prior == null) return undefined
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
          let branchDeleted = payload.branchDeleted ?? false
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
                created_at: version.at,
                updated_at: version.at
              })} RETURNING id`.pipe(Effect.map(([row]) => row!.id))
            if (matching) {
              // Messages in the bin match too: a re-import doesn't bring back what was deleted here.
              // A version the user amended matches by the text it had before (`original`, its
              // oldest history entry), so it isn't imported again beside the amended one.
              const children = yield* sql<{
                slot_id: string
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
              }>`
                SELECT s.id AS slot_id, s.depth, s.context_excluded AS hidden, v.id = s.selected_version_id AS selected,
                  v.content, v.created_at, v.writer, v.ordinal,
                  s.purged_at IS NOT NULL AS slot_purged, v.purged_at IS NOT NULL AS version_purged,
                  s.branch_deleted,
                  coalesce((SELECT h.content FROM version_history h WHERE h.version_id = v.id ORDER BY h.id LIMIT 1),
                    v.content) AS original
                FROM slots s JOIN versions v ON v.slot_id = s.id
                WHERE ${parent === null ? sql`s.chat_id = ${chatId} AND s.depth = 0` : sql`s.parent_slot_id = ${parent.id}`}
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
                (exact !== undefined && purged.length === 0) || (candidates.length === 0 && purged.length === 0)
                  ? undefined
                  : yield* priorAt(parent === null ? 0 : parent.depth + 1)
              const earlier = mine === undefined ? undefined : candidates.find((slot) => slot[0]!.slot_id === mine)
              const placeholder = mine === undefined ? undefined : purged.find((row) => row.slot_id === mine)
              // A branch merged into another file's chat is that file's only where it reads
              // the same: a branch from another swipe, or with messages hidden only in it,
              // diverges there, so its own path keeps what ST had on it.
              const own = exact ?? earlier ?? (input.strict ? undefined : candidates[0])
              const match = placeholder ?? own?.[0]
              if (match !== undefined) {
                branchDeleted ||= match.branch_deleted === 1
                if (exact === undefined && placeholder === undefined) differing++
                if (own !== undefined && match.slot_purged === 0) {
                  let next = Math.max(...own.map((row) => row.ordinal)) + 1
                  for (const version of message.versions) {
                    if (!own.some((row) => same(row, version))) yield* insertVersion(match.slot_id, next++, version)
                  }
                }
                parent = { id: match.slot_id, depth: match.depth, lane_id: laneId }
                slotIds.push(match.slot_id as SlotId)
                continue
              }
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
          if (input.advanceLeaf && !branchDeleted && slotIds.length > 0) {
            const moved = yield* sql<{ id: string }>`UPDATE chats SET active_leaf_slot_id = ${slotIds.at(-1)!}
              WHERE id = ${chatId} AND (active_leaf_slot_id IS NULL OR active_leaf_slot_id = ${advanced ?? ""})
              AND EXISTS (SELECT 1 FROM slots WHERE id = ${slotIds.at(-1)!} AND deleted_at IS NULL)
              RETURNING id`
            if (moved.length > 0) {
              yield* bin.drafts.moveComposer(userId, chatId, chat.active_leaf_slot_id, slotIds.at(-1)!)
              advanced = slotIds.at(-1)!
            }
          }
          const progress: RecordPayload = {
            ...payload,
            firstAdded: payload.firstAdded ?? firstAdded,
            advanced,
            branchDeleted,
            last: slotIds.at(-1) ?? payload.last ?? null
          }
          yield* sql`UPDATE jobs SET updated_at = ${Date.now()}, payload_json = ${JSON.stringify(progress)}
            WHERE id = ${input.recordId}`
          return { slotIds, matching, added, differing }
        }).pipe(transaction(sql, "StImportMessages"))
      ),

    StImportFinishChat: (input) =>
      Effect.gen(function* () {
        const { userId, chatId } = input
        const chat = yield* ownedChat(userId, chatId)
        const payload = yield* leased(userId, input.recordId, chatId, input.lease)
        if (input.position !== null) yield* ownedSlot(chatId, input.position)
        const target = input.leaf === null ? null : yield* ownedSlot(chatId, input.leaf)
        if (input.end !== null) yield* ownedSlot(chatId, input.end)
        const notes: Record<string, EntityId> = {
          ...input.previousNotes,
          ...(payload.notes as Record<string, EntityId> | undefined)
        }
        for (const note of input.notes) {
          const replaced = notes[note.kind]
          const entity = yield* insertNote(userId, chatId, payload.source, note)
          if (replaced !== undefined) {
            yield* insertEvent(userId, chatId, input.position, { key: "note.deactivate", value: { note: replaced } })
          }
          if (note.activate) {
            yield* insertEvent(userId, chatId, input.position, { key: "note.activate", value: { note: entity } })
          }
          // Which note is the chat's ST author's note (DATA-MODEL §5.3), sent or not.
          if (note.kind === "author_note") {
            yield* insertEvent(userId, chatId, input.position, { key: "author_note.set", value: { note: entity } })
          }
          notes[note.kind] = entity
        }
        // A note the file no longer has (an emptied author's note) stops applying.
        for (const kind of input.removedNotes) {
          const gone = notes[kind]
          if (gone === undefined) continue
          yield* insertEvent(userId, chatId, input.position, { key: "note.deactivate", value: { note: gone } })
          delete notes[kind]
        }
        for (const event of input.events) yield* insertEvent(userId, chatId, input.position, event)
        // Deleting the file's end moves the leaf to its nearest live ancestor. An import
        // continues from there too, walking individual deletions without restoring them.
        // A whole deleted branch stays a barrier, including when its root was purged.
        let previousLeaf = payload.end ?? payload.advanced ?? null
        let blocked = payload.branchDeleted ?? false
        if (previousLeaf !== null) {
          const [previous] = yield* sql<{ leaf: string | null; blocked: number }>`
            WITH RECURSIVE up(id, parent, deleted, barrier, n) AS (
              SELECT id, parent_slot_id, deleted_at IS NOT NULL, branch_deleted, 0
              FROM slots WHERE id = ${previousLeaf} AND chat_id = ${chatId}
              UNION ALL
              SELECT s.id, s.parent_slot_id, s.deleted_at IS NOT NULL, s.branch_deleted, up.n + 1
              FROM slots s JOIN up ON s.id = up.parent WHERE up.deleted AND NOT up.barrier
            )
            SELECT (SELECT id FROM up WHERE NOT deleted ORDER BY n LIMIT 1) AS leaf,
              EXISTS (SELECT 1 FROM up WHERE barrier) AS blocked`
          previousLeaf = previous?.leaf ?? null
          blocked ||= previous?.blocked === 1
        }
        // Only from where this file left it (or deletion relocated it). A chat continued
        // here keeps its own leaf and composer; an unchanged file has no leaf to move to.
        const leaf = chat.active_leaf_slot_id
        const moveLeaf =
          !blocked &&
          target?.deleted_at === null &&
          (leaf === null || leaf === previousLeaf || leaf === (payload.advanced ?? null))
        // A chat of the import's own loses its unfinished mark, unless the user renamed it.
        if (!payload.merged && payload.title !== undefined) {
          yield* sql`UPDATE chats SET title = ${payload.title}
            WHERE id = ${chatId} AND title = ${unfinishedTitle(payload.title)}`
        }
        yield* sql`UPDATE chats SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            active_leaf_slot_id = ${moveLeaf ? input.leaf : leaf},
            last_message_at = max(coalesce(last_message_at, 0), coalesce(${input.lastMessageAt}, 0)),
            row_version = row_version + 1
          WHERE id = ${chatId}`
        if (moveLeaf) yield* bin.drafts.moveComposer(userId, chatId, leaf, input.leaf)
        const updated: RecordPayload = {
          ...payload,
          sha256: input.sha256,
          state: input.stateJson,
          notes,
          end: input.end,
          firstAdded: null,
          advanced: null,
          lease: null
        }
        yield* sql`UPDATE jobs SET status = 'complete', payload_json = ${JSON.stringify(updated)}, updated_at = ${Date.now()}
          WHERE id = ${input.recordId}`
        return { notes }
      }).pipe(transaction(sql, "StImportFinishChat")),

    StImportUnhide: ({ userId, chatId, throughSlotId }) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        yield* ownedSlot(chatId, throughSlotId)
        const rows = yield* sql<{ id: string }>`
          WITH RECURSIVE path(id, parent) AS (
            SELECT id, parent_slot_id FROM slots WHERE id = ${throughSlotId}
            UNION ALL
            SELECT s.id, s.parent_slot_id FROM slots s JOIN path p ON s.id = p.parent
          )
          UPDATE slots SET context_excluded = 0, row_version = row_version + 1
          WHERE id IN (SELECT id FROM path) AND context_excluded = 1 RETURNING id`
        return { unhidden: rows.length }
      }).pipe(transaction(sql, "StImportUnhide")),

    StImportClaim: ({ userId, recordId, lease }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ status: string; payload_json: string; deleted_at: number | null }>`
          SELECT j.status, j.payload_json, c.deleted_at FROM jobs j
          JOIN chats c ON c.id = json_extract(j.payload_json, '$.chatId') AND c.owner_user_id = ${userId}
          WHERE j.id = ${recordId} AND j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD}`
        if (!row) return yield* new NotFound({ entity: "import record", id: recordId })
        // A run that's over takes nothing; the current one takes its own lease, or one of a
        // run that's over, whatever the record's state.
        yield* current(userId, lease, recordId)
        const payload = JSON.parse(row.payload_json) as RecordPayload
        const prior = payload.last ?? payload.end ?? null
        yield* sql`UPDATE jobs SET payload_json = ${JSON.stringify({ ...payload, lease, prior, branchDeleted: false })}, updated_at = ${Date.now()}
          WHERE id = ${recordId}`
        return {
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
