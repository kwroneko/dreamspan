import { contextExcludedIn } from "./lcmVisibility.ts"
import { recordHistoryReduction } from "./historyChanges.ts"
import { currentForkSql, inFork, viewAt, reselectEverywhere, selectedInSql, writeOverride } from "./forkState.ts"
import { forkImportSlot } from "./stImportFork.ts"
import { onPath } from "./forks.ts"
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
import { docHash, searchText } from "./documents.ts"
import { ImportLeaseLost, NotFound, ST_CHAT_RECORD, ST_IMPORT_RUN, type StImportNote, WriteOps } from "./ops.ts"
import { checkStateReferences } from "./stateRefs.ts"
import { transaction } from "./tx.ts"
import { DEFAULT_PRESET, newChatLcmSettings, ownedPreset } from "./generationSettings.ts"

/** What a slot `s` shows in its chat's current fork: what an import matches against (unit 9 makes it per file's fork). */
const shownSql = selectedInSql(currentForkSql("s.chat_id"), "s")

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
  /** Original suffix while a shared selection is being forked, including across interrupted batches. */
  readonly forkPrior?: string | null
  /** This pass matched a deleted subtree root; later live additions remain behind it. */
  readonly branchDeleted?: boolean
  /** A branch whose ST name the import has placed (or found a name where it would go). */
  readonly named?: boolean
  /** Where that naming choice belongs; resolved again when a reimport forks earlier. */
  readonly nameSlot?: string | null
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
          ...(note.scanLore ? { scan_lore: true } : {}),
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
            // The account default copied, off until the user turns it on (DESIGN §8.1).
            value_json: JSON.stringify(yield* newChatLcmSettings(sql, userId, false)),
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
          yield* ownedChat(userId, chatId)
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
          let forkPrior = payload.forkPrior ?? null
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
          // A slot can be on several imported files' paths. Its selection is global,
          // so advancing it for one file would silently change the others. Walk the
          // other records only when the imported selection differs from the slot's.
          let sharedPath: Set<string> | null = null
          const shared = (slotId: string) =>
            Effect.gen(function* () {
              if (sharedPath === null) {
                const rows = yield* sql<{ id: string }>`
                  WITH RECURSIVE paths(id, parent) AS (
                    SELECT s.id, s.parent_slot_id FROM jobs j JOIN slots s
                      ON s.id IN (json_extract(j.payload_json, '$.last'), json_extract(j.payload_json, '$.end'),
                        json_extract(j.payload_json, '$.prior'), json_extract(j.payload_json, '$.forkPrior'))
                    WHERE j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD}
                      AND j.id <> ${input.recordId} AND s.chat_id = ${chatId}
                    UNION
                    SELECT s.id, s.parent_slot_id FROM slots s JOIN paths p ON s.id = p.parent
                  ) SELECT id FROM paths`
                sharedPath = new Set(rows.map((row) => row.id))
              }
              return sharedPath.has(slotId)
            })
          // This file's remembered naming choice, and whether it's on the path down to
          // `parent`. Matching only walks down, so the path is walked once per batch and
          // then follows each adopted slot: a long run of matches costs no ancestry scans.
          let choice: { branch_name: string | null; branch_name_user: number; above: boolean } | null | undefined
          const remembered = Effect.gen(function* () {
            if (choice === undefined) {
              const [row] = yield* sql<{ branch_name: string | null; branch_name_user: number; above: number }>`
                WITH RECURSIVE prefix(id, parent) AS (
                  SELECT id, parent_slot_id FROM slots WHERE id = ${parent?.id ?? null} AND chat_id = ${chatId}
                  UNION ALL
                  SELECT s.id, s.parent_slot_id FROM slots s JOIN prefix p ON s.id = p.parent
                )
                SELECT branch_name, branch_name_user, EXISTS (SELECT 1 FROM prefix WHERE id = choice.id) AS above
                FROM slots choice WHERE choice.id = ${payload.nameSlot ?? null} AND choice.chat_id = ${chatId}`
              choice = row === undefined ? null : { ...row, above: row.above === 1 }
            }
            return choice
          })
          let matching = input.matching
          let added = 0
          let differing = 0
          let updated = 0
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
                branch_name: string | null
                branch_name_user: number
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
                SELECT s.id AS slot_id, v.id AS version_id, s.depth, s.branch_name, s.branch_name_user,
                  ${contextExcludedIn(sql, sql.literal(currentForkSql("s.chat_id")))} AS hidden,
                  v.id = ${sql.literal(shownSql)} AS selected,
                  v.content, v.created_at, v.writer, v.ordinal,
                  s.purged_at IS NOT NULL AS slot_purged, v.purged_at IS NOT NULL AS version_purged,
                  s.branch_deleted,
                  s.deleted_at IS NOT NULL AS deleted, v.deleted_at IS NOT NULL AS version_deleted,
                  s.row_version <> s.st_import_row_version OR EXISTS (
                    SELECT 1 FROM version_history h WHERE h.version_id = ${sql.literal(shownSql)}
                  ) OR EXISTS (
                    SELECT 1 FROM fork_overrides o WHERE o.target_id = s.id AND o.kind = 'select' AND o.origin = 'user'
                  ) OR EXISTS (
                    SELECT 1 FROM versions r JOIN fork_overrides o ON o.target_id = r.id AND o.kind = 'replace'
                    WHERE r.slot_id = s.id
                  ) OR EXISTS (
                    -- A hide or a deletion in a fork is the user's too (§2.4).
                    SELECT 1 FROM fork_overrides o WHERE o.slot_id = s.id AND o.origin = 'user'
                      AND o.kind IN ('hide', 'delete_slot', 'delete_version')
                  ) AS locally_changed,
                  coalesce((SELECT h.content FROM version_history h WHERE h.version_id = v.id ORDER BY h.id LIMIT 1),
                    v.content) AS original
                FROM slots s JOIN versions v ON v.slot_id = s.id AND v.fork_id IS NULL
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
              let own = recorded ?? exact ?? (input.strict ? undefined : candidates[0])
              let match = placeholder ?? own?.[0]
              // A replacement may match another fork's path, including an unnamed one. If our old naming
              // choice is no longer on that prefix, adopting its slot would strand our
              // choice or overwrite theirs. Start an independent path at the collision.
              // A parent extending after its own remembered slot may still share a
              // child's named continuation; its existing placement remains reachable.
              if (
                match !== undefined &&
                copied === null &&
                placeholder === undefined &&
                payload.nameSlot != null &&
                match.slot_id !== payload.nameSlot &&
                match.slot_id !== (yield* priorAt(match.depth))
              ) {
                const mine = yield* remembered
                if (
                  mine !== null &&
                  !mine.above &&
                  (mine.branch_name !== match.branch_name || mine.branch_name_user !== match.branch_name_user)
                ) {
                  own = undefined
                  match = undefined
                }
              }
              // A real change in one file's shared selection needs its own immutable
              // path, as when the branch was first imported from a different swipe.
              // Copy the recorded suffix one position at a time, keeping local choices,
              // histories, deleted placeholders and state instead of replaying ST over them.
              if (
                own !== undefined &&
                match !== undefined &&
                !own.some((row) => row.selected === 1 && same(row, shown)) &&
                match.locally_changed === 0 &&
                match.deleted === 0 &&
                match.slot_purged === 0 &&
                !branchDeleted &&
                (yield* shared(match.slot_id))
              ) {
                forkPrior ??= payload.prior ?? payload.end ?? payload.last ?? null
                if (forkPrior !== null) {
                  const original = own
                  copied = yield* forkImportSlot(sql, match.slot_id, parent?.id ?? null)
                  priorPath ??= new Map()
                  priorPath.set(match.depth, copied)
                  const ids = yield* sql<{
                    id: string
                    ordinal: number
                  }>`SELECT id, ordinal FROM versions WHERE slot_id = ${copied}`
                  own = original.map((row) => ({
                    ...row,
                    slot_id: copied!,
                    version_id: ids.find((v) => v.ordinal === row.ordinal)!.id
                  }))
                  match = own[0]!
                }
              }
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
                  if (
                    !showsSelected &&
                    selected !== undefined &&
                    match.locally_changed === 0 &&
                    match.deleted === 0 &&
                    !(yield* shared(match.slot_id))
                  ) {
                    yield* recordHistoryReduction(sql, match.slot_id, shown.content)
                    // No fork chose here (locally_changed), so every fork shows what the
                    // import chose last: each moves to the file's choice, as the import's.
                    const before = own.find((row) => row.selected === 1)?.version_id
                    if (before !== undefined)
                      yield* reselectEverywhere(sql, chatId, match.slot_id, before, selected, "import")
                    yield* sql`UPDATE slots SET row_version = row_version + 1,
                      st_import_row_version = row_version + 1 WHERE id = ${match.slot_id}`
                    showsSelected = true
                    changed = true
                  }
                  if (changed) updated++
                }
                if (placeholder === undefined && (!showsSelected || match.hidden !== (message.hidden ? 1 : 0)))
                  differing++
                parent = { id: match.slot_id, depth: match.depth, lane_id: laneId }
                if (choice != null && match.slot_id === payload.nameSlot) choice.above = true
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
            const moved = yield* sql<{
              id: string
            }>`UPDATE chats SET active_leaf_slot_id = ${slotIds.at(-1)!}
              WHERE id = ${chatId} AND (active_leaf_slot_id IS NULL OR active_leaf_slot_id = ${advanced ?? ""})
              AND EXISTS (SELECT 1 FROM slots WHERE id = ${slotIds.at(-1)!} AND deleted_at IS NULL)
              RETURNING id`
            // The leaf is the current fork's tip (schema/forks.ts), which takes the fork's
            // composer along.
            if (moved.length > 0) advanced = slotIds.at(-1)!
          }
          const progress: RecordPayload = {
            ...payload,
            firstAdded: payload.firstAdded ?? firstAdded,
            advanced,
            branchDeleted,
            forkPrior,
            last: slotIds.at(-1) ?? payload.last ?? null
          }
          yield* sql`UPDATE jobs SET updated_at = ${Date.now()}, payload_json = ${JSON.stringify(progress)}
            WHERE id = ${input.recordId}`
          return { slotIds, matching, added, updated, differing }
        }).pipe(transaction(sql, "StImportMessages"))
      ),

    StImportFinishChat: (input) =>
      Effect.gen(function* () {
        const { userId, chatId } = input
        const chat = yield* ownedChat(userId, chatId)
        const payload = yield* leased(userId, input.recordId, chatId, input.lease)
        if (input.position !== null) yield* ownedSlot(chatId, input.position)
        const target = input.leaf === null ? null : yield* ownedSlot(chatId, input.leaf)
        const end = input.end === null ? null : yield* ownedSlot(chatId, input.end)
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
        // Other forks that ended where this file did follow what it appended, as the current
        // fork's tip does above: otherwise those messages would be on no fork's path, where
        // the switcher used to open the branch on them. A fork the user went on in has
        // another tip, and a file that went another way leaves its forks where they were.
        if (
          !blocked &&
          end !== null &&
          end.deleted_at === null &&
          previousLeaf !== null &&
          end.id !== previousLeaf &&
          (yield* onPath(sql, chatId, end.id, previousLeaf))
        )
          yield* sql`UPDATE forks SET tip_slot_id = ${end.id}, row_version = row_version + 1
            WHERE chat_id = ${chatId} AND deleted_at IS NULL AND tip_slot_id = ${previousLeaf}`
        // Naming invariant (also ARCHITECTURE.md §13): a recorded fork owns one naming
        // choice (branch_name, branch_name_user), including (null, 1) for a local clear.
        // Keep its remembered slot while reachable on this file's path, even if its
        // parent adopts that slot or moves away. Otherwise place the choice at the new
        // first divergence, respecting an existing local choice there. Remove only the
        // redundant copy of this choice on a newly copied suffix. Relocation never
        // clears or renames original choices on other recorded/abandoned paths; matching
        // isolates a replacement that would collide with another choice (above).
        // Automatic filenames need the same bookkeeping, with an initial (null, 0).
        // If no divergence exists, retain the remembered slot for a later regrowth.
        let fork: "named" | "kept" | "same" | null = null
        let named = payload.named ?? false
        let nameSlot = payload.nameSlot ?? null
        if ((input.fork !== null || payload.merged) && input.end !== null) {
          const [parentRow] = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM jobs WHERE id = ${input.fork?.parentRecordId ?? payload.parentRecordId ?? ""} AND owner_user_id = ${userId}
              AND kind = ${ST_CHAT_RECORD}`
          const parent = parentRow === undefined ? null : (JSON.parse(parentRow.payload_json) as RecordPayload)
          const parentEnd = parent?.chatId === chatId ? (parent.end ?? parent.last ?? null) : null
          // A renamed main file may now have a record in a different chat. It has
          // no shared slots here, so use an empty parent path instead of skipping
          // transfer of this file's remembered naming choice.
          {
            type NameSlot = { id: string; depth: number; branch_name: string | null; branch_name_user: number }
            const divergence = (end: string | null, placement: string | null = null) => sql<
              NameSlot & { keeps_placement: number }
            >`
              WITH RECURSIVE theirs(id, parent) AS (
                SELECT id, parent_slot_id FROM slots WHERE id = ${parentEnd} AND chat_id = ${chatId}
                UNION ALL
                SELECT s.id, s.parent_slot_id FROM slots s JOIN theirs t ON s.id = t.parent
              ), mine(id, parent, depth) AS (
                SELECT id, parent_slot_id, depth FROM slots WHERE id = ${end} AND chat_id = ${chatId}
                UNION ALL
                SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN mine m ON s.id = m.parent
              )
              SELECT s.id, s.depth, s.branch_name, s.branch_name_user,
                EXISTS (SELECT 1 FROM mine WHERE id = ${placement}) AS keeps_placement
              FROM mine m JOIN slots s ON s.id = m.id
              WHERE m.id NOT IN (SELECT id FROM theirs)
                -- A transferred choice must start on this run's independent suffix,
                -- never on an older shared prefix outside the parent's current path.
                AND (${placement} IS NULL OR EXISTS (SELECT 1 FROM mine WHERE id = ${placement})
                  OR s.depth >= (SELECT depth FROM slots WHERE id = ${payload.firstAdded ?? null}))
              ORDER BY m.depth LIMIT 1`
            // Claim recovered older records' placement (StImportClaim, below); one it
            // couldn't (an automatic name without a parent) falls back to the divergence
            // of its prior path. `nameSlot` also survives an interrupted, batched suffix copy.
            const [previous] =
              nameSlot === null
                ? yield* divergence(payload.end ?? null)
                : yield* sql<NameSlot>`SELECT id, depth, branch_name, branch_name_user FROM slots
                  WHERE id = ${nameSlot} AND chat_id = ${chatId}`
            const [current] = yield* divergence(input.end, previous?.id ?? null)
            if (current === undefined) fork = "same"
            else {
              // Parent-only changes cannot relocate a reachable naming choice. A
              // replacement path (with or without a suffix copy) needs a new placement.
              const own = current.keeps_placement === 1 && previous !== undefined ? previous : current
              const moving = previous !== undefined && previous.id !== own.id
              const canName =
                own.branch_name_user === 0 &&
                ((own.branch_name === null && !(named && previous?.id === own.id)) ||
                  // A copied import label at the new divergence may belong to the parent.
                  (moving && payload.forkPrior != null))
              const name = moving ? previous.branch_name : (input.fork?.name ?? null)
              const local = moving ? previous.branch_name_user : 0
              fork = canName && name !== null ? "named" : "kept"
              if (canName) {
                // Import-only naming keeps the selection baseline aligned. Carrying a
                // local naming choice keeps it local at its new switch point too.
                if (own.branch_name !== name || own.branch_name_user !== local) {
                  yield* sql`UPDATE slots SET branch_name = ${name}, branch_name_user = ${local}, row_version = row_version + 1,
                    st_import_row_version = CASE WHEN ${local} = 0 AND st_import_row_version = row_version
                      THEN row_version + 1 ELSE st_import_row_version END
                    WHERE id = ${own.id}`
                }
                if (moving && payload.forkPrior != null && previous.depth > own.depth) {
                  // Remove only this label's copy farther down the new suffix. The original
                  // path and unrelated names on the copied suffix retain their choices.
                  yield* sql`
                    WITH RECURSIVE mine(id, parent, depth) AS (
                      SELECT id, parent_slot_id, depth FROM slots WHERE id = ${input.end} AND chat_id = ${chatId}
                      UNION ALL
                      SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN mine m ON s.id = m.parent
                        WHERE m.depth > ${previous.depth}
                    )
                    UPDATE slots SET branch_name = NULL, branch_name_user = 0, row_version = row_version + 1,
                      st_import_row_version = CASE WHEN st_import_row_version = row_version
                        THEN row_version + 1 ELSE st_import_row_version END
                    WHERE id IN (SELECT id FROM mine WHERE depth = ${previous.depth}) AND id <> ${previous.id}
                      AND branch_name IS ${previous.branch_name} AND branch_name_user = ${previous.branch_name_user}`
                }
              }
              named = true
              nameSlot = own.id
            }
          }
        }
        const updated: RecordPayload = {
          ...payload,
          named,
          nameSlot,
          ...(input.fork === null ? {} : { parentRecordId: input.fork.parentRecordId }),
          sha256: input.sha256,
          state: input.stateJson,
          notes,
          end: input.end,
          firstAdded: null,
          advanced: null,
          lease: null,
          forkPrior: null,
          prior: null
        }
        yield* sql`UPDATE jobs SET status = 'complete', payload_json = ${JSON.stringify(updated)}, updated_at = ${Date.now()}
          WHERE id = ${input.recordId}`
        return { notes, fork }
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
          SELECT j.status, j.payload_json, c.deleted_at FROM jobs j
          JOIN chats c ON c.id = json_extract(j.payload_json, '$.chatId') AND c.owner_user_id = ${userId}
          WHERE j.id = ${recordId} AND j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD}`
        if (!row) return yield* new NotFound({ entity: "import record", id: recordId })
        // A run that's over takes nothing; the current one takes its own lease, or one of a
        // run that's over, whatever the record's state.
        yield* current(userId, lease, recordId)
        const payload = JSON.parse(row.payload_json) as RecordPayload
        const prior = payload.last ?? payload.end ?? null
        let nameSlot = payload.nameSlot ?? null
        const parentId = parentRecordId ?? payload.parentRecordId
        let parentPayload: RecordPayload | undefined
        if (parentId !== undefined) {
          const [parent] = yield* sql<{ payload_json: string }>`SELECT payload_json FROM jobs
            WHERE id = ${parentId} AND owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD}`
          if (!parent) return yield* new NotFound({ entity: "import record", id: parentId })
          parentPayload = JSON.parse(parent.payload_json) as RecordPayload
        }
        // Legacy records must recover their choice before message matching can
        // adopt another fork's occupied placement. Keep placeholders in the walk.
        if (payload.merged && nameSlot === null && prior !== null && parentPayload !== undefined) {
          // Automatic-name records have neither field, and their own choice is
          // usually (null, 0): only the parent's path tells it from an ancestor's.
          const parentEnd =
            parentPayload.chatId === payload.chatId ? (parentPayload.end ?? parentPayload.last ?? null) : null
          const [placement] = yield* sql<{ id: string; chosen: number }>`
            WITH RECURSIVE theirs(id, parent) AS (
              SELECT id, parent_slot_id FROM slots WHERE id = ${parentEnd} AND chat_id = ${payload.chatId}
              UNION ALL
              SELECT s.id, s.parent_slot_id FROM slots s JOIN theirs t ON s.id = t.parent
            ), mine(id, parent, depth) AS (
              SELECT id, parent_slot_id, depth FROM slots WHERE id = ${prior} AND chat_id = ${payload.chatId}
              UNION ALL
              SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN mine m ON s.id = m.parent
            ) SELECT s.id, s.branch_name IS NOT NULL OR s.branch_name_user = 1 AS chosen
            FROM mine m JOIN slots s ON s.id = m.id
            WHERE m.id NOT IN (SELECT id FROM theirs) ORDER BY m.depth LIMIT 1`
          // A custom-name record's divergence carries its choice, unless the parent's
          // path has moved off the old shared prefix since (handled below).
          if (placement !== undefined && (!payload.named || placement.chosen === 1)) nameSlot = placement.id
        }
        if (payload.merged && nameSlot === null && prior !== null && payload.named) {
          // An older custom-name record put its name at its divergence (or found one
          // there), and only a local choice, (name, 1) or (null, 1), replaced it since.
          // Ancestors' choices lie above it on the path and children's below its end,
          // so without a parent path to go by, the deepest choice no other record
          // remembers is taken as its own: the parent may be gone, or its path may have
          // moved off the old one. A deeper local choice on its path (a renamed fork
          // point, or a revision mismatch migration 0043 marked) is taken instead then.
          const [placement] = yield* sql<{ id: string }>`
            WITH RECURSIVE mine(id, parent, depth) AS (
              SELECT id, parent_slot_id, depth FROM slots WHERE id = ${prior} AND chat_id = ${payload.chatId}
              UNION ALL
              SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN mine m ON s.id = m.parent
            ) SELECT s.id FROM mine m JOIN slots s ON s.id = m.id
            WHERE (s.branch_name IS NOT NULL OR s.branch_name_user = 1)
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.owner_user_id = ${userId} AND j.kind = ${ST_CHAT_RECORD}
                AND j.id <> ${recordId} AND json_extract(j.payload_json, '$.nameSlot') = s.id)
            ORDER BY m.depth DESC LIMIT 1`
          nameSlot = placement?.id ?? null
        }
        yield* sql`UPDATE jobs SET payload_json = ${JSON.stringify({
          ...payload,
          lease,
          prior,
          nameSlot,
          ...(parentId === undefined ? {} : { parentRecordId: parentId }),
          branchDeleted: false
        })}, updated_at = ${Date.now()}
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
