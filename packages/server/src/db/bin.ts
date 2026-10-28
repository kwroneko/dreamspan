// The recycle bin (DESIGN §6.2), used by the writer. Deleting marks rows (deleted_at,
// bin_item_id) instead of removing them, so restoring puts things back exactly where
// they were. Two sections with independent capacities: deleted items and recovered text.
import { Buffer } from "node:buffer"
import { BinChanged, BinItem, type BinLimits, RecoveredText } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { composerKey, type DraftKey, excerpt } from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Data, Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { reachableSlot } from "./graphReachability.ts"
import { forkRecency } from "./forks.ts"
import { originalSql, reselectEverywhere, shownInSql } from "./forkState.ts"
import { makeDraftStore } from "./drafts.ts"
import { NotFound } from "./ops.ts"
import type { QueuedRow } from "./queueRows.ts"

interface BinRow {
  readonly id: string
  readonly kind: BinItem["kind"]
  readonly target_id: string
  readonly chat_id: string | null
  readonly title: string
  readonly excerpt: string
  readonly card_doc_json?: string | null
  readonly origin_json: string
  readonly byte_size: number
  readonly deleted_at: number
}

export const toBinItem = (row: BinRow) =>
  new BinItem({
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    title: row.card_doc_json ? String(JSON.parse(row.card_doc_json).name ?? "") : row.title,
    excerpt: row.excerpt,
    origin: {
      ...(JSON.parse(row.origin_json) as Record<string, unknown>),
      ...(row.card_doc_json ? { subtitle: JSON.parse(row.card_doc_json).character_version ?? "" } : {})
    },
    byteSize: row.byte_size,
    deletedAt: row.deleted_at
  })

interface RecoveredRow {
  readonly id: string
  readonly source_kind: RecoveredText["sourceKind"]
  readonly source_id: string
  readonly source_field: string
  readonly source_label: string
  readonly reason: RecoveredText["reason"]
  readonly content: string
  readonly created_at: number
}

export const toRecoveredText = (row: RecoveredRow, full: boolean) =>
  new RecoveredText({
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceField: row.source_field,
    sourceLabel: row.source_label,
    reason: row.reason,
    content: full ? row.content : excerpt(row.content, 200),
    length: row.content.length,
    createdAt: row.created_at
  })

/** Eviction can't bring the bin within its limits. */
class NoRoom extends Data.TaggedError("NoRoom") {}

const chatName = (title: string | null | undefined) => (title ? `"${title}"` : "an untitled chat")

const bytes = (column: string) => `coalesce(length(CAST(${column} AS BLOB)), 0)`

/** The bytes deleting version `v` for good frees: what purgeVersions empties or deletes. */
const versionBytes = (v: string) =>
  [
    ...["content", "reasoning", "display_form", "context_form", "direction", "frozen_macros"].map((column) =>
      bytes(`${v}.${column}`)
    ),
    `(SELECT coalesce(sum(${bytes("h.content")}), 0) FROM version_history h WHERE h.version_id = ${v}.id)`,
    `(SELECT coalesce(sum(${bytes("a.alt_text")}), 0) FROM version_attachments a WHERE a.version_id = ${v}.id)`
  ].join(" + ")

/** What deleting a chat for good frees besides its versions, each part selected by chat id. */
const chatRecordBytes = [
  `SELECT ${bytes("value_json")} AS n FROM state_events WHERE chat_id = ?`,
  `SELECT ${bytes("error")} + ${bytes("cache_observed_json")} FROM rollouts WHERE chat_id = ?`,
  `SELECT ${bytes("p.context_snapshot_json")} + ${bytes("p.transcript_json")} + ${bytes("p.sent_context_json")}
   FROM rollout_payloads p JOIN rollouts r ON r.id = p.rollout_id WHERE r.chat_id = ?`,
  `SELECT ${bytes("b.messages_json")} FROM rollout_branches b JOIN rollouts r ON r.id = b.rollout_id WHERE r.chat_id = ?`,
  `SELECT ${bytes("v.content")} FROM summary_revisions v JOIN summaries s ON s.id = v.summary_id WHERE s.chat_id = ?`,
  `SELECT ${bytes("best_effort_draft")} + ${bytes("error")} FROM summarization_jobs WHERE chat_id = ?`,
  `SELECT ${bytes("i.before_json")} + ${bytes("i.after_json")}
   FROM changeset_items i JOIN changesets c ON c.id = i.changeset_id WHERE c.chat_id = ?`
]

export const makeBin = (sql: SqlClient.SqlClient, limits: BinLimits, now: () => number = Date.now) => {
  const insertItem = (item: {
    readonly userId: UserId
    readonly kind: BinItem["kind"]
    readonly targetId: string
    readonly chatId: string | null
    readonly title: string
    readonly excerpt: string
    readonly origin: Record<string, unknown>
    readonly byteSize: number
  }) =>
    Effect.gen(function* () {
      const id = uuidv7()
      yield* sql`INSERT INTO bin_items ${sql.insert({
        id,
        user_id: item.userId,
        kind: item.kind,
        target_id: item.targetId,
        chat_id: item.chatId,
        title: item.title,
        excerpt: excerpt(item.excerpt, 200),
        origin_json: JSON.stringify(item.origin),
        byte_size: item.byteSize,
        deleted_at: Date.now()
      })}`
      return id
    })

  const loadItem = (userId: UserId, itemId: string) =>
    sql<BinRow>`SELECT * FROM bin_items WHERE id = ${itemId} AND user_id = ${userId}`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "bin item", id: itemId }))
      )
    )

  /**
   * Every live fork of the chat whose tip was deleted moves it to the nearest ancestor
   * that wasn't (each fork's composer is its own, so nothing moves with it).
   */
  const relocateLeaf = (chatId: string) =>
    Effect.gen(function* () {
      const forks = yield* sql<{ id: string; tip_slot_id: string }>`
        SELECT f.id, f.tip_slot_id FROM forks f JOIN slots t ON t.id = f.tip_slot_id
        WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND t.deleted_at IS NOT NULL`
      for (const fork of forks) {
        const [target] = yield* sql<{ id: string | null }>`
          WITH RECURSIVE up(id, parent, deleted, n) AS (
            SELECT id, parent_slot_id, deleted_at IS NOT NULL, 0 FROM slots WHERE id = ${fork.tip_slot_id}
            UNION ALL
            SELECT s.id, s.parent_slot_id, s.deleted_at IS NOT NULL, up.n + 1 FROM slots s JOIN up ON s.id = up.parent
            WHERE up.deleted
          )
          SELECT (SELECT id FROM up WHERE NOT deleted ORDER BY n LIMIT 1) AS id`
        yield* sql`UPDATE forks SET tip_slot_id = ${target?.id ?? null}, row_version = row_version + 1
          WHERE id = ${fork.id}`
      }
    })

  /**
   * The live forks of the chat whose tip nothing continues below: no child that's live, or
   * deleted alone with replies left (what a path follows). Includes one before the first
   * message, which a restored first message continues.
   */
  const tipForks = (chatId: string) =>
    sql<{ id: string; tip_slot_id: string | null }>`
      SELECT f.id, f.tip_slot_id FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM slots x WHERE x.chat_id = f.chat_id AND x.parent_slot_id IS f.tip_slot_id
          AND ${sql.literal(reachableSlot("x"))})`

  /**
   * After a restore: a fork whose tip was a tip follows what came back below it, on the
   * newest reply at each step, so a message deleted from the end of a fork is at its end again.
   */
  const followRestored = (chatId: string, fork: { id: string; tip_slot_id: string | null }) =>
    Effect.gen(function* () {
      const leaf = fork.tip_slot_id
      const [tip] = yield* sql<{ id: string }>`
        WITH RECURSIVE down(id, n) AS (
          SELECT ${leaf}, 0
          UNION ALL
          SELECT (SELECT c.id FROM slots c WHERE c.chat_id = ${chatId} AND c.parent_slot_id IS d.id
              AND ${sql.literal(reachableSlot("c"))}
              ORDER BY c.id DESC LIMIT 1),
            d.n + 1
          FROM down d WHERE d.id IS NOT NULL OR d.n = 0
        )
        SELECT id FROM down WHERE id IS NOT NULL ORDER BY n DESC LIMIT 1`
      if (tip && tip.id !== leaf)
        yield* sql`UPDATE forks SET tip_slot_id = ${tip.id}, row_version = row_version + 1 WHERE id = ${fork.id}`
    })

  /**
   * The forks whose tip is in a branch that went to the bin go with it, under its item: their
   * tips stay, so Restore brings them back as they were. A current fork that went is
   * replaced by the most recent live one (§2.1). When none would be left, the current fork
   * stays instead, its tip going up out of the branch (`relocateLeaf`), as the chat's leaf
   * did before forks, and Restore brings it back down (`followRestored`).
   */
  const binForks = (chatId: string, itemId: string) =>
    Effect.gen(function* () {
      const inBranch = `chat_id = ? AND deleted_at IS NULL AND tip_slot_id IN (SELECT id FROM slots WHERE bin_item_id = ?)`
      const [row] = yield* sql.unsafe<{ kept: string | null }>(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM forks WHERE chat_id = ? AND deleted_at IS NULL AND NOT (${inBranch}))
           THEN NULL ELSE (SELECT current_fork_id FROM chats WHERE id = ?) END AS kept`,
        [chatId, chatId, itemId, chatId]
      )
      const kept = row?.kept ?? null
      yield* sql.unsafe(
        `UPDATE forks SET deleted_at = ?, bin_item_id = ?, row_version = row_version + 1
         WHERE ${inBranch} AND id IS NOT ?`,
        [Date.now(), itemId, chatId, itemId, kept]
      )
      const [next] = yield* sql<{ id: string }>`
        SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE c.id = ${chatId} AND f.deleted_at IS NULL
          AND (SELECT deleted_at FROM forks WHERE id = c.current_fork_id) IS NOT NULL
        ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC LIMIT 1`
      if (next) yield* sql`UPDATE chats SET current_fork_id = ${next.id} WHERE id = ${chatId}`
    })

  // --- Deleting -----------------------------------------------------------------------

  const ownedLiveSlot = (userId: UserId, slotId: string) =>
    sql<{ id: string; chat_id: string; depth: number; parent_slot_id: string | null; title: string; content: string }>`
      SELECT s.id, s.chat_id, s.depth, s.parent_slot_id, c.title, v.content
      FROM slots s JOIN chats c ON c.id = s.chat_id JOIN versions v ON v.id = ${sql.literal(shownInSql("c.current_fork_id", "s"))}
      WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "slot", id: slotId }))))
    )

  const deleteMessage = (userId: UserId, slotId: string) =>
    Effect.gen(function* () {
      const slot = yield* ownedLiveSlot(userId, slotId)
      const [size] = yield* sql<{ n: number }>`
        SELECT coalesce(sum(${sql.literal(versionBytes("v"))}), 0) AS n FROM versions v
        WHERE v.slot_id = ${slotId} AND v.deleted_at IS NULL`
      const itemId = yield* insertItem({
        userId,
        kind: "message",
        targetId: slotId,
        chatId: slot.chat_id,
        title: `Message in ${chatName(slot.title)}`,
        excerpt: slot.content,
        origin: {
          chatId: slot.chat_id,
          chatTitle: slot.title,
          slotId,
          depth: slot.depth,
          parentSlotId: slot.parent_slot_id
        },
        byteSize: size!.n
      })
      yield* sql`UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${slotId}`
      yield* relocateLeaf(slot.chat_id)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${slot.chat_id}`
      return itemId
    })

  const deleteBranch = (userId: UserId, slotId: string) =>
    Effect.gen(function* () {
      const slot = yield* ownedLiveSlot(userId, slotId)
      const [stats] = yield* sql<{ slots: number; bytes: number }>`
        WITH RECURSIVE sub(id) AS (SELECT ${slotId} UNION ALL SELECT s.id FROM slots s JOIN sub ON s.parent_slot_id = sub.id)
        SELECT (SELECT count(*) FROM slots WHERE id IN sub AND deleted_at IS NULL) AS slots,
               (SELECT coalesce(sum(${sql.literal(versionBytes("v"))}), 0) FROM versions v JOIN slots s ON s.id = v.slot_id
                WHERE s.id IN sub AND s.deleted_at IS NULL AND v.deleted_at IS NULL) AS bytes`
      const itemId = yield* insertItem({
        userId,
        kind: "branch",
        targetId: slotId,
        chatId: slot.chat_id,
        title: `Branch of ${stats!.slots} message${stats!.slots === 1 ? "" : "s"} in ${chatName(slot.title)}`,
        excerpt: slot.content,
        origin: {
          chatId: slot.chat_id,
          chatTitle: slot.title,
          slotId,
          depth: slot.depth,
          parentSlotId: slot.parent_slot_id,
          messages: stats!.slots
        },
        byteSize: stats!.bytes
      })
      yield* sql`
        WITH RECURSIVE sub(id) AS (SELECT ${slotId} UNION ALL SELECT s.id FROM slots s JOIN sub ON s.parent_slot_id = sub.id)
        UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id IN sub AND deleted_at IS NULL`
      yield* sql`UPDATE slots SET branch_deleted = 1 WHERE id = ${slotId}`
      // The forks in it keep their tips and composers for Undo, including late saves.
      yield* binForks(slot.chat_id, itemId)
      // Forks whose tip was a message deleted on its own inside it come up out of it.
      yield* relocateLeaf(slot.chat_id)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${slot.chat_id}`
      return itemId
    })

  /** Deletes one swipe. The only remaining version of a message takes the message with it. */
  // A fork's copy standing in for a version (schema/forkVersions.ts) is deleted as that
  // version: what goes is the swipe, with every fork's copy of it.
  const deleteVersion = (userId: UserId, shownId: string) =>
    Effect.gen(function* () {
      const [version] = yield* sql<{
        id: string
        slot_id: string
        ordinal: number
        content: string
        bytes: number
      }>`
        SELECT o.id, o.slot_id, o.ordinal, x.content,
          ${sql.literal(versionBytes("o"))} + (SELECT coalesce(sum(${sql.literal(versionBytes("c"))}), 0)
            FROM versions c WHERE c.source_version_id = o.id AND c.fork_id IS NOT NULL) AS bytes
        FROM versions x JOIN versions o ON o.id = ${sql.literal(originalSql("x"))}
          JOIN slots s ON s.id = o.slot_id JOIN chats c ON c.id = s.chat_id
        WHERE x.id = ${shownId} AND c.owner_user_id = ${userId}
          AND o.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!version) return yield* new NotFound({ entity: "version", id: shownId })
      const versionId = version.id
      const others = yield* sql<{ id: string; ordinal: number }>`
        SELECT id, ordinal FROM versions WHERE slot_id = ${version.slot_id} AND deleted_at IS NULL AND id <> ${versionId}
          AND fork_id IS NULL
        ORDER BY ordinal`
      if (others.length === 0) return yield* deleteMessage(userId, version.slot_id)
      const slot = yield* ownedLiveSlot(userId, version.slot_id)
      const itemId = yield* insertItem({
        userId,
        kind: "version",
        targetId: versionId,
        chatId: slot.chat_id,
        title: `Version of a message in ${chatName(slot.title)}`,
        excerpt: version.content,
        origin: {
          chatId: slot.chat_id,
          chatTitle: slot.title,
          slotId: slot.id,
          depth: slot.depth,
          ordinal: version.ordinal
        },
        byteSize: version.bytes
      })
      yield* sql`UPDATE versions SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${versionId}`
      // Like ST, every fork that showed it shows the previous swipe, or the next one if this
      // was the first. A swipe still goes from every fork at once until deletion is per fork
      // (spec/FORK-INDEPENDENCE-DELTA.md §2.4), so each fork showing it gets a selection.
      const previous = others.filter((o) => o.ordinal < version.ordinal).at(-1) ?? others[0]!
      yield* reselectEverywhere(sql, slot.chat_id, version.slot_id, versionId, previous.id)
      return itemId
    })

  const deleteChat = (userId: UserId, chatId: string) =>
    Effect.gen(function* () {
      const [chat] = yield* sql<{ id: string; title: string }>`
        SELECT id, title FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
      if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
      // Messages and swipes already in the bin count under their own items.
      const [stats] = yield* sql<{ bytes: number; last: string | null; messages: number }>`
        SELECT coalesce(sum(CASE WHEN s.deleted_at IS NULL AND v.deleted_at IS NULL
                 THEN ${sql.literal(versionBytes("v"))} END), 0) AS bytes,
          count(DISTINCT s.id) AS messages,
          (SELECT v2.content FROM chats c2 JOIN slots s2 ON s2.id = c2.active_leaf_slot_id
             JOIN versions v2 ON v2.id = ${sql.literal(shownInSql("c2.current_fork_id", "s2"))}
             WHERE c2.id = ${chatId}) AS last
        FROM slots s JOIN versions v ON v.slot_id = s.id WHERE s.chat_id = ${chatId}`
      const [records] = yield* sql.unsafe<{ n: number }>(
        `SELECT coalesce(sum(n), 0) AS n FROM (${chatRecordBytes.join(" UNION ALL ")})`,
        chatRecordBytes.map(() => chatId)
      )
      const itemId = yield* insertItem({
        userId,
        kind: "chat",
        targetId: chatId,
        chatId,
        title: chat.title || "Untitled chat",
        excerpt: stats?.last ?? "",
        origin: { chatId, messages: stats?.messages ?? 0 },
        byteSize: (stats?.bytes ?? 0) + records!.n
      })
      yield* sql`UPDATE chats SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}, row_version = row_version + 1 WHERE id = ${chatId}`
      return itemId
    })

  const deleteEntity = (userId: UserId, entityId: string) =>
    Effect.gen(function* () {
      const [entity] = yield* sql<{ id: string; kind: string; label: string | null; bytes: number }>`
        SELECT e.id, e.kind,
          (SELECT label FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1) AS label,
          (SELECT coalesce(sum(${sql.literal(`${bytes("doc_json")} + ${bytes("search_text")}`)}), 0) FROM entity_revisions WHERE entity_id = e.id) AS bytes
        FROM entities e WHERE e.id = ${entityId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`
      if (!entity) return yield* new NotFound({ entity: "entity", id: entityId })
      const itemId = yield* insertItem({
        userId,
        kind: "entity",
        targetId: entityId,
        chatId: null,
        title: entity.label ?? `Untitled ${entity.kind}`,
        excerpt: entity.kind,
        origin: { entityId, kind: entity.kind, label: entity.label },
        byteSize: entity.bytes
      })
      yield* sql`UPDATE entities SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${entityId}`
      return itemId
    })

  const deleteConnection = (userId: UserId, connectionId: string) =>
    Effect.gen(function* () {
      const [connection] = yield* sql<{ name: string; kind: string }>`
        SELECT name, kind FROM connections
        WHERE id = ${connectionId} AND owner_user_id = ${userId} AND deleted_at IS NULL AND purged_at IS NULL`
      if (!connection) return yield* new NotFound({ entity: "connection", id: connectionId })
      const itemId = yield* insertItem({
        userId,
        kind: "connection",
        targetId: connectionId,
        chatId: null,
        title: connection.name,
        excerpt: connection.kind,
        origin: { connectionId, kind: connection.kind },
        byteSize: 0
      })
      yield* sql`UPDATE connections SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${connectionId}`
      return itemId
    })

  // --- Restoring and deleting for good -----------------------------------------------

  const restore = (userId: UserId, itemId: string) =>
    Effect.gen(function* () {
      const item = yield* loadItem(userId, itemId)
      // A deleted message took tips up to its parent (relocateLeaf): they come back down. A
      // restored branch brings back its own forks as they were, and a chat's last fork, kept
      // when its branch went, comes back down too.
      const messages = item.kind === "message" || item.kind === "branch"
      const tips = messages && item.chat_id !== null ? yield* tipForks(item.chat_id) : []
      if (item.chat_id !== null) yield* discardDeletedQueue(item.chat_id)
      const table = {
        chat: "chats",
        message: "slots",
        branch: "slots",
        version: "versions",
        entity: "entities",
        connection: "connections"
      }[item.kind]
      // An import's copy of a deleted branch root carries the item and the root's marker too.
      if (item.kind === "branch") {
        yield* sql`UPDATE slots SET branch_deleted = 0 WHERE bin_item_id = ${itemId} AND branch_deleted = 1`
        yield* sql`UPDATE forks SET deleted_at = NULL, bin_item_id = NULL, row_version = row_version + 1
          WHERE bin_item_id = ${itemId}`
      }
      yield* sql.unsafe(`UPDATE ${table} SET deleted_at = NULL, bin_item_id = NULL WHERE bin_item_id = ?`, [itemId])
      yield* sql`DELETE FROM bin_items WHERE id = ${itemId}`
      if ((messages || item.kind === "chat") && item.chat_id !== null) {
        yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${item.chat_id}`
      }
      for (const fork of tips) yield* followRestored(item.chat_id!, fork)
      return toBinItem(item)
    })

  /**
   * Deletes for good the bin items `where` (a condition on bin_items, with its `params`)
   * selects. Set-based, so emptying a large bin takes a few statements, not a few per item.
   */
  const purgeWhere = (where: string, params: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const chats = yield* sql.unsafe<{ chat_id: string }>(
        `SELECT DISTINCT chat_id FROM bin_items WHERE chat_id IS NOT NULL AND (${where})`,
        params
      )
      for (const chat of chats) yield* discardDeletedQueue(chat.chat_id)
      const now = Date.now()
      const run = (statement: string, leading: ReadonlyArray<unknown> = []) =>
        sql.unsafe(statement, [...leading, ...params])
      const targets = (kind: BinItem["kind"]) => `SELECT target_id FROM bin_items WHERE kind = '${kind}' AND (${where})`
      const items = (kinds: string) => `SELECT id FROM bin_items WHERE kind IN (${kinds}) AND (${where})`

      /** Empties versions and drops what refers to them, including swipes binned separately inside. */
      const purgeVersions = (versions: string) =>
        Effect.gen(function* () {
          yield* run(
            `UPDATE versions SET purged_at = ?, content = '', reasoning = NULL, display_form = NULL,
               context_form = NULL, direction = NULL, frozen_macros = NULL
             WHERE ${versions}`,
            [now]
          )
          yield* run(`DELETE FROM version_history WHERE version_id IN (SELECT id FROM versions WHERE ${versions})`)
          yield* run(`DELETE FROM version_attachments WHERE version_id IN (SELECT id FROM versions WHERE ${versions})`)
          yield* run(
            `DELETE FROM bin_items WHERE kind = 'version' AND target_id IN (SELECT id FROM versions WHERE ${versions})`
          )
        })

      // A chat goes with everything in it, its other bin items included. A connection
      // using one of its overrides as its preset loses that preset.
      yield* run(`UPDATE connections SET preset_override_ref_id = NULL
                  WHERE preset_override_ref_id IN (SELECT id FROM entity_refs WHERE chat_id IN (${targets("chat")}))`)
      yield* run(`DELETE FROM bin_items WHERE kind <> 'chat' AND chat_id IN (${targets("chat")})`)
      yield* run(`DELETE FROM chats WHERE id IN (${targets("chat")})`)

      // Messages and branches keep their slots as empty placeholders, so the
      // conversation's structure and any summaries over it remain valid. A branch's forks
      // keep their rows, losing their names and tips.
      yield* run(`UPDATE slots SET purged_at = ? WHERE bin_item_id IN (${items("'message', 'branch'")})`, [now])
      yield* run(
        `UPDATE forks SET purged_at = ?, name = NULL, tip_slot_id = NULL, bin_item_id = NULL, row_version = row_version + 1
         WHERE bin_item_id IN (${items("'branch'")})`,
        [now]
      )
      yield* purgeVersions(`slot_id IN (SELECT id FROM slots WHERE bin_item_id IN (${items("'message', 'branch'")}))`)
      // A swipe goes with every fork's copy standing in for it (schema/forkVersions.ts), first,
      // while the swipe's bin item still says which it is.
      yield* purgeVersions(
        `fork_id IS NOT NULL AND source_version_id IN (SELECT id FROM versions WHERE bin_item_id IN (${items("'version'")}))`
      )
      yield* purgeVersions(`bin_item_id IN (${items("'version'")})`)

      // An entity row stays, so messages that named it as their speaker still point somewhere.
      const entityRefs = `SELECT id FROM entity_refs WHERE entity_id IN (${targets("entity")})`
      yield* run(`UPDATE connections SET preset_override_ref_id = NULL WHERE preset_override_ref_id IN (${entityRefs})`)
      yield* run(`DELETE FROM entity_refs WHERE entity_id IN (${targets("entity")})`)
      yield* run(`DELETE FROM entity_tags WHERE entity_id IN (${targets("entity")})`)
      yield* run(`DELETE FROM entity_revisions WHERE entity_id IN (${targets("entity")})`)
      yield* run(`UPDATE entities SET purged_at = ? WHERE id IN (${targets("entity")})`, [now])

      // A key typed into a purged connection goes with it, unless another connection
      // (live or in the bin) uses it. Deleting it clears credential_id (ON DELETE SET NULL).
      yield* run(
        `DELETE FROM credentials WHERE connection_owned = 1
           AND id IN (SELECT credential_id FROM connections WHERE id IN (${targets("connection")}))
           AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.credential_id = credentials.id
             AND c.id NOT IN (${targets("connection")}))`,
        params
      )

      // A connection stays as a tombstone without secrets: old messages and ledger rows
      // still name their model (PROVIDERS §10).
      yield* run(
        `UPDATE connections SET purged_at = ?, credential_id = NULL, headers_enc = NULL, header_names_json = '[]',
           proxy_mode = 'inherit', proxy_url_enc = NULL, base_url = NULL
         WHERE id IN (${targets("connection")})`,
        [now]
      )

      yield* run(`DELETE FROM bin_items WHERE ${where}`)
    })

  const purge = (userId: UserId, itemId: string) =>
    Effect.flatMap(loadItem(userId, itemId), (item) => purgeWhere("id = ?", [item.id]))

  const emptyBin = (userId: UserId, itemIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string }>`SELECT id FROM bin_items WHERE user_id = ${userId}`
      const confirmed = new Set(itemIds)
      if (rows.length !== confirmed.size || !rows.every((row) => confirmed.has(row.id))) {
        return yield* new BinChanged()
      }
      // The comparison and purge share this writer transaction: every current item was confirmed.
      yield* purgeWhere("user_id = ?", [userId])
      return rows.length
    })

  /**
   * Keeps the deleted-items section within its limits by deleting the oldest items for
   * good, never `created`, the item the delete just made. Each purge runs in its own
   * savepoint: one that fails is rolled back, logged and skipped. If the items that can
   * go can't make room, nothing goes: the bin stays over its limits rather than losing
   * everything else to one delete, and later deletes or emptying it bring it back.
   */
  const evictDeleted = (userId: UserId, created: string) =>
    Effect.gen(function* () {
      const fits = sql<{ n: number; bytes: number }>`
        SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS bytes FROM bin_items WHERE user_id = ${userId}`.pipe(
        Effect.map(([usage]) => usage!.n <= limits.deletedItems && usage!.bytes <= limits.deletedBytes)
      )
      if (yield* fits) return
      const [newest] = yield* sql<{ byte_size: number }>`SELECT byte_size FROM bin_items WHERE id = ${created}`
      // Not even evicting everything else would make room.
      if (limits.deletedItems < 1 || newest!.byte_size > limits.deletedBytes) return
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            let after = { deleted_at: -1, id: "" }
            while (!(yield* fits)) {
              const [oldest] = yield* sql<BinRow>`
                SELECT * FROM bin_items
                WHERE user_id = ${userId} AND id <> ${created} AND (deleted_at, id) > (${after.deleted_at}, ${after.id})
                ORDER BY deleted_at, id LIMIT 1`
              if (!oldest) return yield* new NoRoom()
              after = oldest
              yield* sql
                .withTransaction(purgeWhere("id = ?", [oldest.id]))
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`bin eviction skipped ${oldest.kind} item ${oldest.id}`, error.reason.cause)
                  )
                )
            }
          })
        )
        .pipe(Effect.catchTag("NoRoom", () => Effect.logWarning(`bin over capacity for ${userId}: nothing can go`)))
    })

  // --- Recovered text ------------------------------------------------------------------

  const sourceLabel = (key: DraftKey) =>
    Effect.gen(function* () {
      const chatTitle = (sqlText: string) =>
        sql.unsafe<{ title: string }>(sqlText, [key.targetId]).pipe(Effect.map(([row]) => chatName(row?.title)))
      switch (key.targetKind) {
        case "composer":
          return `Composer in ${yield* chatTitle(`SELECT title FROM chats WHERE id = ?`)}`
        case "version_edit":
          return `Edit of a message in ${yield* chatTitle(
            `SELECT c.title FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id WHERE v.id = ?`
          )}`
        case "scratchpad":
          return `Scratchpad in ${yield* chatTitle(`SELECT c.title FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ?`)}`
        case "summary_edit":
          return `Summary in ${yield* chatTitle(`SELECT c.title FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.id = ?`)}`
        case "entity_field": {
          const [ref] = yield* sql<{ label: string }>`SELECT label FROM entity_refs WHERE id = ${key.targetId}`
          return [ref?.label ?? "A library entry", key.field].filter(Boolean).join(" › ")
        }
      }
    })

  /** Saves draft text that a commit or discard would otherwise lose. Never shown as a toast. */
  const recover = (userId: UserId, key: DraftKey, texts: ReadonlyArray<string>, reason: "commit" | "discard") =>
    Effect.gen(function* () {
      // `texts` come newest first; inserting oldest first keeps "newest first" listings right.
      const unique = [...new Set(texts)].filter((t) => t.trim().length > 0).reverse()
      if (unique.length === 0) return
      const label = yield* sourceLabel(key)
      const now = Date.now()
      for (const content of unique) {
        yield* sql`INSERT INTO recovered_texts ${sql.insert({
          id: uuidv7(),
          user_id: userId,
          source_kind: key.targetKind,
          source_id: key.targetId,
          source_field: key.field,
          source_label: label,
          reason,
          content,
          byte_size: Buffer.byteLength(content),
          created_at: now
        })}`
      }
      // Its own track: recovered text never evicts deleted items, or the other way round.
      const rows = yield* sql<{ id: string; byte_size: number }>`
        SELECT id, byte_size FROM recovered_texts WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC`
      let bytes = 0
      const cut = rows.findIndex((row, index) => {
        bytes += row.byte_size
        return index >= limits.recoveredTexts || bytes > limits.recoveredBytes
      })
      if (cut >= 0) {
        for (const row of rows.slice(cut)) yield* sql`DELETE FROM recovered_texts WHERE id = ${row.id}`
      }
    })

  /** Keeps every unposted entry's text, including a Generate's one-turn direction. */
  const recoverQueued = (userId: UserId, entries: ReadonlyArray<QueuedRow>) =>
    Effect.gen(function* () {
      for (const entry of entries) {
        yield* recover(
          userId,
          composerKey(entry.chat_id, entry.fork_id),
          [entry.content, entry.direction ?? ""],
          "discard"
        )
      }
    })

  // A restore or purge can precede the generation's cleanup (or follow a crash).
  const discardDeletedQueue = (chatId: string) =>
    Effect.gen(function* () {
      const entries = yield* sql<QueuedRow & { owner_user_id: UserId }>`
        SELECT q.*, c.owner_user_id FROM queued_messages q JOIN chats c ON c.id = q.chat_id
          JOIN slots s ON s.id = q.reply_slot_id
        WHERE q.chat_id = ${chatId} AND (c.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL) ORDER BY q.seq`
      if (entries.length === 0) return
      yield* recoverQueued(entries[0]!.owner_user_id, entries)
      yield* sql`DELETE FROM queued_messages WHERE ${sql.in(
        "id",
        entries.map((entry) => entry.id)
      )}`
    })

  const drafts = makeDraftStore(sql, recover, now)

  return {
    drafts,
    deleteChat,
    deleteMessage,
    deleteBranch,
    deleteVersion,
    deleteEntity,
    deleteConnection,
    restore,
    purge,
    emptyBin,
    evictDeleted,
    loadItem,
    recover,
    recoverQueued
  }
}

export type Bin = ReturnType<typeof makeBin>
