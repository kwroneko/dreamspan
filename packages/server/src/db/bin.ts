// The recycle bin (DESIGN §6.2), used by the writer. Deleting marks rows (deleted_at,
// bin_item_id) instead of removing them, so restoring puts things back exactly where
// they were. Two sections with independent capacities: deleted items and recovered text.
import { BinItem, type BinLimits, RecoveredText } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { type DraftKey, excerpt } from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { NotFound } from "./ops.ts"

interface BinRow {
  readonly id: string
  readonly kind: BinItem["kind"]
  readonly target_id: string
  readonly chat_id: string | null
  readonly title: string
  readonly excerpt: string
  readonly origin_json: string
  readonly byte_size: number
  readonly deleted_at: number
}

export const toBinItem = (row: BinRow) =>
  new BinItem({
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    title: row.title,
    excerpt: row.excerpt,
    origin: JSON.parse(row.origin_json) as Record<string, unknown>,
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

const chatName = (title: string | null | undefined) => (title ? `"${title}"` : "an untitled chat")

/** Columns emptied when a version's content is deleted for good. */
const purgeVersionsSql = `UPDATE versions SET purged_at = ?, content = '', reasoning = NULL, display_form = NULL,
  context_form = NULL, direction = NULL, frozen_macros = NULL`

export const makeBin = (sql: SqlClient.SqlClient, limits: BinLimits) => {
  const notFound = (entity: string, id: string) => Effect.fail(new NotFound({ entity, id }))

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
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : notFound("bin item", itemId)))
    )

  /**
   * If the chat's active leaf was deleted, moves it to the nearest ancestor that wasn't,
   * and takes the composer there with it (unless that tip has text of its own).
   */
  const relocateLeaf = (chatId: string) =>
    Effect.gen(function* () {
      const [chat] = yield* sql<{ active_leaf_slot_id: string | null }>`
        SELECT active_leaf_slot_id FROM chats WHERE id = ${chatId}`
      const leaf = chat?.active_leaf_slot_id
      if (!leaf) return
      const [target] = yield* sql<{ id: string | null; deleted: number }>`
        WITH RECURSIVE up(id, parent, deleted, n) AS (
          SELECT id, parent_slot_id, deleted_at IS NOT NULL, 0 FROM slots WHERE id = ${leaf}
          UNION ALL
          SELECT s.id, s.parent_slot_id, s.deleted_at IS NOT NULL, up.n + 1 FROM slots s JOIN up ON s.id = up.parent
          WHERE up.deleted
        )
        SELECT (SELECT id FROM up WHERE NOT deleted ORDER BY n LIMIT 1) AS id,
               (SELECT deleted FROM up WHERE n = 0) AS deleted`
      if (!target?.deleted) return
      yield* sql`UPDATE chats SET active_leaf_slot_id = ${target.id}, row_version = row_version + 1 WHERE id = ${chatId}`
      const [existing] = yield* sql<{ n: number }>`
        SELECT count(*) AS n FROM drafts WHERE target_kind = 'composer' AND target_id = ${chatId}
          AND field = ${target.id ?? ""} AND status = 'active' AND content <> ''`
      if (existing?.n === 0) {
        yield* sql`DELETE FROM drafts WHERE target_kind = 'composer' AND target_id = ${chatId} AND field = ${target.id ?? ""}`
        yield* sql`UPDATE drafts SET field = ${target.id ?? ""}, row_version = row_version + 1
                   WHERE target_kind = 'composer' AND target_id = ${chatId} AND field = ${leaf}`
      }
    })

  // --- Deleting -----------------------------------------------------------------------

  const ownedLiveSlot = (userId: UserId, slotId: string) =>
    sql<{ id: string; chat_id: string; depth: number; parent_slot_id: string | null; title: string; content: string }>`
      SELECT s.id, s.chat_id, s.depth, s.parent_slot_id, c.title, v.content
      FROM slots s JOIN chats c ON c.id = s.chat_id JOIN versions v ON v.id = s.selected_version_id
      WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) => (row ? Effect.succeed(row) : notFound("slot", slotId)))
    )

  const deleteMessage = (userId: UserId, slotId: string) =>
    Effect.gen(function* () {
      const slot = yield* ownedLiveSlot(userId, slotId)
      const [size] = yield* sql<{
        n: number
      }>`SELECT coalesce(sum(length(content)), 0) AS n FROM versions WHERE slot_id = ${slotId}`
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
      return itemId
    })

  const deleteBranch = (userId: UserId, slotId: string) =>
    Effect.gen(function* () {
      const slot = yield* ownedLiveSlot(userId, slotId)
      const [stats] = yield* sql<{ slots: number; bytes: number }>`
        WITH RECURSIVE sub(id) AS (SELECT ${slotId} UNION ALL SELECT s.id FROM slots s JOIN sub ON s.parent_slot_id = sub.id)
        SELECT (SELECT count(*) FROM slots WHERE id IN sub AND deleted_at IS NULL) AS slots,
               (SELECT coalesce(sum(length(v.content)), 0) FROM versions v WHERE v.slot_id IN sub) AS bytes`
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
      yield* relocateLeaf(slot.chat_id)
      return itemId
    })

  /** Deletes one swipe. The only remaining version of a message takes the message with it. */
  const deleteVersion = (userId: UserId, versionId: string) =>
    Effect.gen(function* () {
      const [version] = yield* sql<{ id: string; slot_id: string; ordinal: number; content: string; selected: number }>`
        SELECT v.id, v.slot_id, v.ordinal, v.content, s.selected_version_id = v.id AS selected
        FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
        WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
          AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!version) return yield* notFound("version", versionId)
      const others = yield* sql<{ id: string; ordinal: number }>`
        SELECT id, ordinal FROM versions WHERE slot_id = ${version.slot_id} AND deleted_at IS NULL AND id <> ${versionId}
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
        byteSize: version.content.length
      })
      yield* sql`UPDATE versions SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${versionId}`
      if (version.selected) {
        // Like ST: show the previous swipe, or the next one if this was the first.
        const previous = others.filter((o) => o.ordinal < version.ordinal).at(-1) ?? others[0]!
        yield* sql`UPDATE slots SET selected_version_id = ${previous.id}, row_version = row_version + 1 WHERE id = ${version.slot_id}`
      }
      return itemId
    })

  const deleteChat = (userId: UserId, chatId: string) =>
    Effect.gen(function* () {
      const [chat] = yield* sql<{ id: string; title: string }>`
        SELECT id, title FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
      if (!chat) return yield* notFound("chat", chatId)
      const [stats] = yield* sql<{ bytes: number; last: string | null; messages: number }>`
        SELECT coalesce(sum(length(v.content)), 0) AS bytes, count(DISTINCT s.id) AS messages,
          (SELECT v2.content FROM chats c2 JOIN slots s2 ON s2.id = c2.active_leaf_slot_id
             JOIN versions v2 ON v2.id = s2.selected_version_id WHERE c2.id = ${chatId}) AS last
        FROM slots s JOIN versions v ON v.slot_id = s.id WHERE s.chat_id = ${chatId}`
      const itemId = yield* insertItem({
        userId,
        kind: "chat",
        targetId: chatId,
        chatId,
        title: chat.title || "Untitled chat",
        excerpt: stats?.last ?? "",
        origin: { chatId, messages: stats?.messages ?? 0 },
        byteSize: stats?.bytes ?? 0
      })
      yield* sql`UPDATE chats SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${chatId}`
      return itemId
    })

  const deleteEntity = (userId: UserId, entityId: string) =>
    Effect.gen(function* () {
      const [entity] = yield* sql<{ id: string; kind: string; label: string | null; bytes: number }>`
        SELECT e.id, e.kind,
          (SELECT label FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1) AS label,
          (SELECT coalesce(sum(length(doc_json)), 0) FROM entity_revisions WHERE entity_id = e.id) AS bytes
        FROM entities e WHERE e.id = ${entityId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`
      if (!entity) return yield* notFound("entity", entityId)
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
      if (!connection) return yield* notFound("connection", connectionId)
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
      const table = {
        chat: "chats",
        message: "slots",
        branch: "slots",
        version: "versions",
        entity: "entities",
        connection: "connections"
      }[item.kind]
      yield* sql.unsafe(`UPDATE ${table} SET deleted_at = NULL, bin_item_id = NULL WHERE bin_item_id = ?`, [itemId])
      yield* sql`DELETE FROM bin_items WHERE id = ${itemId}`
      return toBinItem(item)
    })

  /** Empties versions' content for good and drops what refers to it. */
  const purgeVersions = (whereVersions: string, params: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* sql.unsafe(`${purgeVersionsSql} WHERE ${whereVersions}`, [now, ...params])
      yield* sql.unsafe(
        `DELETE FROM version_history WHERE version_id IN (SELECT id FROM versions WHERE ${whereVersions})`,
        params
      )
      yield* sql.unsafe(
        `DELETE FROM version_attachments WHERE version_id IN (SELECT id FROM versions WHERE ${whereVersions})`,
        params
      )
      // Swipes deleted separately inside what was just emptied have nothing left to restore.
      yield* sql.unsafe(
        `DELETE FROM bin_items WHERE kind = 'version' AND target_id IN (SELECT id FROM versions WHERE ${whereVersions})`,
        params
      )
    })

  const purgeItem = (item: BinRow) =>
    Effect.gen(function* () {
      switch (item.kind) {
        case "chat":
          yield* sql`DELETE FROM bin_items WHERE chat_id = ${item.target_id}`
          yield* sql`DELETE FROM chats WHERE id = ${item.target_id}`
          return
        case "message":
        case "branch":
          // The slots stay as empty placeholders, so the conversation's structure and any
          // summaries over it remain valid.
          yield* sql`UPDATE slots SET purged_at = ${Date.now()} WHERE bin_item_id = ${item.id}`
          yield* purgeVersions("slot_id IN (SELECT id FROM slots WHERE bin_item_id = ?)", [item.id])
          break
        case "version":
          yield* purgeVersions("bin_item_id = ?", [item.id])
          break
        case "entity": {
          const id = item.target_id
          yield* sql`UPDATE connections SET preset_override_ref_id = NULL
                     WHERE preset_override_ref_id IN (SELECT id FROM entity_refs WHERE entity_id = ${id})`
          yield* sql`DELETE FROM entity_refs WHERE entity_id = ${id}`
          yield* sql`DELETE FROM entity_tags WHERE entity_id = ${id}`
          yield* sql`DELETE FROM entity_revisions WHERE entity_id = ${id}`
          // The row stays, so messages that named it as their speaker still point somewhere.
          yield* sql`UPDATE entities SET purged_at = ${Date.now()} WHERE id = ${id}`
          break
        }
        case "connection":
          // A tombstone without secrets: old messages and ledger rows still name their
          // model (PROVIDERS §10).
          yield* sql`UPDATE connections SET purged_at = ${Date.now()}, api_key_enc = NULL, key_hint = NULL,
                       headers_enc = NULL, header_names_json = '[]', proxy_mode = 'inherit', proxy_url_enc = NULL,
                       base_url = NULL
                     WHERE id = ${item.target_id}`
          break
      }
      yield* sql`DELETE FROM bin_items WHERE id = ${item.id}`
    })

  const purge = (userId: UserId, itemId: string) => Effect.flatMap(loadItem(userId, itemId), purgeItem)

  const emptyBin = (userId: UserId) =>
    Effect.gen(function* () {
      const items = yield* sql<BinRow>`SELECT * FROM bin_items WHERE user_id = ${userId} ORDER BY deleted_at`
      for (const item of items) {
        // An earlier purge (a chat) may already have taken this one.
        const [still] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM bin_items WHERE id = ${item.id}`
        if (still?.n) yield* purgeItem(item)
      }
      return items.length
    })

  /** Keeps the deleted-items section within its limits, deleting the oldest for good. */
  const evictDeleted = (userId: UserId) =>
    Effect.gen(function* () {
      for (;;) {
        const [usage] = yield* sql<{ n: number; bytes: number }>`
          SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS bytes FROM bin_items WHERE user_id = ${userId}`
        if (usage!.n <= limits.deletedItems && usage!.bytes <= limits.deletedBytes) return
        const [oldest] =
          yield* sql<BinRow>`SELECT * FROM bin_items WHERE user_id = ${userId} ORDER BY deleted_at, id LIMIT 1`
        yield* purgeItem(oldest!)
      }
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
          byte_size: content.length,
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

  return {
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
    recover
  }
}

export type Bin = ReturnType<typeof makeBin>
