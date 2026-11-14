import { splitChatMarkers, splitGroups } from "./splitChats.ts"
// The recycle bin (DESIGN §6.2), used by the writer. Deleting marks rows (deleted_at,
// bin_item_id) instead of removing them, so restoring puts things back exactly where
// they were. Two sections with independent capacities: deleted items and recovered text.
import { readBinLimits } from "./binLimits.ts"
import { Buffer } from "node:buffer"
import { BinChanged, BinItem, type BinLimits, CannotDeleteLastFork, RecoveredText } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { composerKey, type DraftKey, excerpt, parseDraftTarget } from "@rp/shared/drafts.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Data, Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import { reachableSlot } from "./graphReachability.ts"
import { forkRecency, forksShowing, lastShown, onForkPath, sharedDepth } from "./forks.ts"
import {
  displayThrough,
  onDisplayPath,
  pathPieces,
  placedInsertions,
  positionOf,
  type SlotPlace
} from "./displayPath.ts"
import {
  effectiveOverride,
  forkAt,
  insertFork,
  originalSql,
  selectedIn,
  shownInSql,
  shownIn,
  slotDeletedIn,
  versionDeletedIn,
  writeOverride,
  writeSelect
} from "./forkState.ts"
import { recordReduction } from "./historyChanges.ts"
import { pathSegments } from "./pathSegments.ts"
import type { ForkRow } from "./rows.ts"
import { binItemForks } from "./binForks.ts"
import { makeDraftStore } from "./drafts.ts"
import { NotFound } from "./ops.ts"
import { setSplitApplied } from "./threads.ts"
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
const versionBytes = (v: string, text = v) =>
  [
    ...[
      "content",
      "reasoning",
      "raw_content",
      "raw_reasoning",
      "raw_sections",
      "rewrite_json",
      "reply_sections",
      "display_form",
      "context_form",
      "direction",
      "frozen_macros"
    ].map((column) => bytes(`${text}.${column}`)),
    `(SELECT coalesce(sum(${bytes("h.content")}), 0) FROM version_history h WHERE h.version_id = ${v}.id)`,
    `(SELECT coalesce(sum(${bytes("a.alt_text")}), 0) FROM version_attachments a WHERE a.version_id = ${v}.id)`
  ].join(" + ")

/** What deleting a chat for good frees besides its versions, each part selected by chat id. */
const chatRecordBytes = [
  `SELECT ${bytes("p.response")} AS n FROM summary_responses p JOIN rollouts r ON r.id=p.rollout_id WHERE r.chat_id = ?`,
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

/**
 * The slots whose gap still holds an inserted message fork `forkId` shows: each slot it places
 * and doesn't delete, and every anchor above it up to a structural one (a deleted inserted slot's
 * own gap stays shown, as a deleted message's replies do). Empty, after one lookup, when the fork
 * places nothing.
 */
const liveGaps = (sql: SqlClient.SqlClient, chatId: string, forkId: string) =>
  Effect.gen(function* () {
    const placed = yield* placedInsertions(sql, chatId, forkId)
    const kept = new Set<string>()
    if (placed.length === 0) return kept
    const anchorOf = new Map(placed.map((x) => [x.id, x.anchorId]))
    const live = yield* sql<{ id: string }>`
      SELECT s.id FROM slots s WHERE ${sql.in(
        "s.id",
        placed.map((x) => x.id)
      )} AND NOT ${slotDeletedIn(sql, forkId, "s")}`
    for (const { id } of live) {
      let anchor = anchorOf.get(id) ?? null
      while (anchor !== null && !kept.has(anchor)) {
        kept.add(anchor)
        anchor = anchorOf.get(anchor) ?? null
      }
    }
    return kept
  })

export const makeBin = (sql: SqlClient.SqlClient, defaults: BinLimits, now: () => number = Date.now) => {
  const assetRestorers = new Map<
    string,
    (userId: UserId, origin: Record<string, unknown>) => Effect.Effect<void, NotFound | SqlError.SqlError>
  >()
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
      const [chat] =
        item.chatId === null
          ? []
          : yield* sql<{ kind: string }>`
        SELECT kind FROM chats WHERE id = ${item.chatId} AND owner_user_id = ${item.userId}`
      yield* sql`INSERT INTO bin_items ${sql.insert({
        id,
        user_id: item.userId,
        kind: item.kind,
        target_id: item.targetId,
        chat_id: item.chatId,
        title: item.title,
        excerpt: excerpt(item.excerpt, 200),
        origin_json: JSON.stringify({ ...item.origin, ...(chat ? { chatKind: chat.kind } : {}) }),
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

  const loadItems = (userId: UserId, itemIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql<BinRow>`SELECT b.* FROM json_each(${JSON.stringify(itemIds)}) asked
      CROSS JOIN bin_items b ON b.id = asked.value AND b.user_id = ${userId} ORDER BY cast(asked.key AS INTEGER)`
      if (rows.length !== itemIds.length) return yield* new NotFound({ entity: "bin item", id: itemIds[0] ?? "" })
      return rows
    })

  /**
   * Every live fork of the chat whose tip is deleted in its own view moves it to the nearest
   * ancestor that isn't (each fork's composer is its own, so nothing moves with it). It stops
   * at a deleted one whose gap still holds an inserted message the fork shows (`liveGaps`), so
   * that message stays on its display path; appends go below it (spec/MESSAGE-INSERT.md §2.4).
   */
  const relocateLeaf = (chatId: string) =>
    Effect.gen(function* () {
      const forks = yield* sql<{ id: string; tip_slot_id: string }>`
        SELECT f.id, f.tip_slot_id FROM forks f JOIN slots t ON t.id = f.tip_slot_id
        WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND ${slotDeletedIn(sql, sql.literal("f.id"), "t")}`
      for (const fork of forks) {
        const kept = yield* liveGaps(sql, chatId, fork.id)
        const up = yield* sql<{ id: string; deleted: number }>`
          WITH RECURSIVE up(id, parent, deleted, n) AS (
            SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, fork.id, "s")}, 0 FROM slots s WHERE s.id = ${fork.tip_slot_id}
            UNION ALL
            SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, fork.id, "s")}, up.n + 1 FROM slots s JOIN up ON s.id = up.parent
            WHERE up.deleted
          )
          SELECT id, deleted FROM up ORDER BY n`
        const target = up.find((slot) => !slot.deleted || kept.has(slot.id))?.id ?? null
        if (target !== fork.tip_slot_id)
          yield* sql`UPDATE forks SET tip_slot_id = ${target}, row_version = row_version + 1 WHERE id = ${fork.id}`
      }
    })

  /**
   * The message fork `forkId` shows nearest above `slotId`, itself if shown: where its tip went
   * when it deleted the messages from there down (`relocateLeaf`'s walk). Null for none.
   */
  const shownAbove = (chatId: string, forkId: string, slotId: string | null) =>
    Effect.gen(function* () {
      if (slotId === null) return null
      const kept = yield* liveGaps(sql, chatId, forkId)
      const up = yield* sql<{ id: string; deleted: number }>`
        WITH RECURSIVE up(id, parent, deleted, n) AS (
          SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, forkId, "s")}, 0 FROM slots s WHERE s.id = ${slotId}
          UNION ALL
          SELECT s.id, s.parent_slot_id, ${slotDeletedIn(sql, forkId, "s")}, up.n + 1 FROM slots s JOIN up ON s.id = up.parent
          WHERE up.deleted
        )
        SELECT id, deleted FROM up ORDER BY n`
      return up.find((slot) => !slot.deleted || kept.has(slot.id))?.id ?? null
    })

  /**
   * The live forks of the chat whose tip nothing continues below: no child that's live, or
   * deleted alone with replies left (what a path follows). Includes one before the first
   * message, which a restored first message continues. For restoring what was deleted
   * before forks kept their own deletions.
   */
  const tipForks = (chatId: string) =>
    sql<{ id: string; tip_slot_id: string | null }>`
      SELECT f.id, f.tip_slot_id FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM slots x WHERE x.chat_id = f.chat_id AND x.parent_slot_id IS f.tip_slot_id
          AND ${sql.literal(reachableSlot("x"))})`

  /** The end of the line below `slotId` (itself if nothing continues it): its newest reply at each step. */
  const latestBelow = (chatId: string, slotId: string | null) =>
    Effect.map(
      sql<{ id: string }>`
        WITH RECURSIVE down(id, n) AS (
          SELECT ${slotId}, 0
          UNION ALL
          SELECT (SELECT c.id FROM slots c WHERE c.chat_id = ${chatId} AND c.parent_slot_id IS d.id
              AND ${sql.literal(reachableSlot("c"))}
              ORDER BY c.id DESC LIMIT 1),
            d.n + 1
          FROM down d WHERE d.id IS NOT NULL OR d.n = 0
        )
        SELECT id FROM down WHERE id IS NOT NULL ORDER BY n DESC LIMIT 1`,
      ([row]) => row?.id ?? null
    )

  /**
   * After a restore: a fork whose tip was a tip follows what came back below it, on the
   * newest reply at each step, so a message deleted from the end of a fork is at its end again.
   */
  const followRestored = (chatId: string, fork: { id: string; tip_slot_id: string | null }) =>
    Effect.gen(function* () {
      const tip = yield* latestBelow(chatId, fork.tip_slot_id)
      if (tip !== null && tip !== fork.tip_slot_id)
        yield* sql`UPDATE forks SET tip_slot_id = ${tip}, row_version = row_version + 1 WHERE id = ${fork.id}`
    })

  /** A current fork that's in the bin is replaced by the live one most recently current. */
  const replaceCurrentFork = (chatId: string) =>
    Effect.gen(function* () {
      const [next] = yield* sql<{ id: string }>`
        SELECT f.id FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE c.id = ${chatId} AND f.deleted_at IS NULL
          AND (SELECT deleted_at FROM forks WHERE id = c.current_fork_id) IS NOT NULL
        ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC LIMIT 1`
      if (next) yield* sql`UPDATE chats SET current_fork_id = ${next.id} WHERE id = ${chatId}`
    })

  // --- Deleting -----------------------------------------------------------------------
  // What a user deletes is deleted in a fork: an override of that fork's own (spec/FORK-INDEPENDENCE-
  // DELTA.md §2.4), so another fork still shows it. Only when no live fork shows it does the
  // slot or version carry the mark too (`slots.deleted_at` under the item), which keeps what reads
  // the marks (alternates in the switcher, tips following restores) as it was before forks.

  /** The fork a delete is in: `forkId`, else the one through the slot; a live fork of the chat. */
  const deletingFork = (chatId: string, slotId: string, forkId: string | null | undefined) =>
    Effect.gen(function* () {
      const id = forkId ?? (yield* forkAt(sql, chatId, slotId))
      const [fork] = yield* sql<ForkRow>`
        SELECT * FROM forks WHERE id = ${id} AND chat_id = ${chatId} AND deleted_at IS NULL`
      if (!fork) return yield* new NotFound({ entity: "fork", id: id ?? chatId })
      return fork
    })

  const ownedLiveSlot = (userId: UserId, slotId: string, forkId: string | null | undefined) =>
    Effect.gen(function* () {
      const [owned] = yield* sql<{ chat_id: string }>`
        SELECT s.chat_id FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${slotId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND s.purged_at IS NULL
          AND c.deleted_at IS NULL`
      if (!owned) return yield* new NotFound({ entity: "slot", id: slotId })
      const fork = yield* deletingFork(owned.chat_id, slotId, forkId)
      const [row] = yield* sql<{
        id: string
        chat_id: string
        depth: number
        parent_slot_id: string | null
        title: string
        content: string
      }>`
        SELECT s.id, s.chat_id, s.depth, s.parent_slot_id, c.title, v.content
        FROM slots s JOIN chats c ON c.id = s.chat_id JOIN version_records v ON v.id = ${shownIn(sql, fork.id, "s")}
        WHERE s.id = ${slotId} AND NOT ${slotDeletedIn(sql, fork.id, "s")}`
      if (!row) return yield* new NotFound({ entity: "slot", id: slotId })
      // Where the fork shows it, as the chat numbers it: its depth unless insertions move it.
      const position = (yield* displayThrough(sql, row.chat_id, fork.id, slotId))?.end ?? row.depth
      return { ...row, position, fork }
    })

  /** How many slots of `ids` aren't marked yet, and the bytes their versions hold (as `deleteFork` counts them). */
  const sizeOf = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed({ slots: 0, bytes: 0 })
      : Effect.map(
          sql<{ slots: number; bytes: number }>`
            SELECT count(DISTINCT s.id) AS slots, coalesce(sum(${sql.literal(versionBytes("v", "vt"))}), 0) AS bytes
            FROM slots s LEFT JOIN versions v ON v.slot_id = s.id AND v.deleted_at IS NULL
              LEFT JOIN version_texts vt ON vt.version_seq = v.seq
            WHERE ${sql.in("s.id", ids)} AND s.deleted_at IS NULL`,
          ([row]) => row!
        )

  /**
   * The inserted messages that change what deleting `fork` marks (spec/MESSAGE-INSERT.md §3.1):
   * `marked`, those it shows by an `insert` row that no other fork shows (`others`, in the bin
   * or not, as `sharedDepth` reads them); `kept`, those on its structural path at `below` or
   * deeper (it was made at or below them) that another fork shows by its own row. Costs one
   * lookup when the fork places none and has none of its own on that stretch.
   */
  const insertedUnseen = (fork: ForkRow, others: ReadonlyArray<ForkRow>, below: number) =>
    Effect.gen(function* () {
      const structural =
        fork.tip_slot_id === null
          ? []
          : yield* sql<{ id: string; chain_id: string; depth: number }>`
              ${pathSegments(sql, fork.chat_id, fork.tip_slot_id, null)}
              SELECT s.id, s.chain_id, s.depth FROM segments g JOIN slots s ON s.chain_id = g.chain_id
                AND s.depth BETWEEN max(g.lo, ${below}) AND g.hi
              WHERE s.inserted = 1 AND s.deleted_at IS NULL`
      const placed = yield* placedInsertions(sql, fork.chat_id, fork.id)
      const shown =
        placed.length === 0
          ? []
          : (yield* pathPieces(sql, fork.chat_id, fork.id, fork.tip_slot_id)).flatMap((piece) =>
              piece.kind === "inserted" ? [{ id: piece.slotId, chainId: piece.chainId, depth: piece.depth }] : []
            )
      if (structural.length === 0 && shown.length === 0) return { marked: [], kept: [] }
      const views = yield* Effect.forEach(others, (other) => pathPieces(sql, fork.chat_id, other.id, other.tip_slot_id))
      const elsewhere = (slot: SlotPlace) => views.some((pieces) => onDisplayPath(pieces, slot))
      const unmarked =
        shown.length === 0
          ? new Set<string>()
          : new Set(
              (yield* sql<{ id: string }>`SELECT id FROM slots WHERE ${sql.in(
                "id",
                shown.map((slot) => slot.id)
              )} AND deleted_at IS NULL`).map((row) => row.id)
            )
      return {
        marked: shown.filter((slot) => unmarked.has(slot.id) && !elsewhere(slot)).map((slot) => slot.id),
        kept: structural
          .filter((row) => elsewhere({ id: row.id, chainId: row.chain_id, depth: row.depth }))
          .map((row) => row.id)
      }
    })

  const forkOrigin = (fork: ForkRow) => ({ forkId: fork.id, forkName: fork.name })

  /**
   * One message deleted in its fork, with its bin item; the fork tips and the chat's row version
   * are the caller's (`deleteMessage`, `deleteMessages`). `group`: the multi-delete it's part of.
   */
  const deleteOne = (
    userId: UserId,
    slotId: string,
    forkId: string | null | undefined,
    group?: { readonly id: string; readonly size: number }
  ) =>
    Effect.gen(function* () {
      const slot = yield* ownedLiveSlot(userId, slotId, forkId)
      const [size] = yield* sql<{ n: number }>`
        SELECT coalesce(sum(${sql.literal(versionBytes("v"))}), 0) AS n FROM version_records v
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
          position: slot.position,
          parentSlotId: slot.parent_slot_id,
          ...forkOrigin(slot.fork),
          ...(group ? { group: group.id, groupSize: group.size } : {})
        },
        byteSize: size!.n
      })
      yield* writeOverride(
        sql,
        { id: slot.fork.id, chatId: slot.chat_id },
        { kind: "delete_slot", targetId: slotId, slotId, valueId: null, flag: 1, binItemId: itemId }
      )
      yield* recordReduction(sql, slotId, slot.fork.id)
      const shown = yield* forksShowing(sql, slot.chat_id, slotId, null, slot.fork.id, false, true)
      if (shown.length === 0)
        yield* sql`UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${slotId}`
      return { itemId, chatId: slot.chat_id, forkId: slot.fork.id }
    })

  const deleteMessage = (userId: UserId, slotId: string, forkId?: string | null) =>
    Effect.gen(function* () {
      const { itemId, chatId } = yield* deleteOne(userId, slotId, forkId)
      yield* relocateLeaf(chatId)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${chatId}`
      return itemId
    })

  /**
   * Several messages deleted in fork `forkId` as one change (job msgactions1): each exactly as
   * `deleteMessage` deletes it, with a bin item of its own that names the group, so the bin keeps
   * each one and Undo restores them together (`restoreMany`). The fork's tip moves once, after.
   * In the order given (the client's: the path's, top down), which restoring follows.
   */
  const deleteMessages = (userId: UserId, forkId: string, slotIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const [fork] = yield* sql<ForkRow & { title: string; kind: string }>`
        SELECT f.*, c.title, c.kind FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
          AND f.deleted_at IS NULL AND f.purged_at IS NULL`
      if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
      const chatId = fork.chat_id
      const pieces = yield* pathPieces(sql, chatId, forkId, fork.tip_slot_id)
      const requested = JSON.stringify(slotIds)
      // Drive every join from the requested ids, never from the chat's version payloads.
      const rows = yield* sql<{
        id: string
        chain_id: string
        depth: number
        inserted: number
        parent_slot_id: string | null
        content: string
      }>`SELECT s.id, s.chain_id, s.depth, s.inserted, s.parent_slot_id, t.content
        FROM json_each(${requested}) asked CROSS JOIN slots s ON s.id = asked.value
          CROSS JOIN versions v ON v.id = ${shownIn(sql, forkId, "s")}
          CROSS JOIN version_texts t ON t.version_seq = v.seq
        WHERE s.chat_id = ${chatId} AND v.status <> 'generating' AND NOT ${slotDeletedIn(sql, forkId, "s")}`
      const slots = new Map(
        rows.map(
          (row) =>
            [
              row.id,
              { ...row, position: positionOf(pieces, { id: row.id, chainId: row.chain_id, depth: row.depth }) }
            ] as const
        )
      )
      for (const id of slotIds) if (slots.get(id)?.position == null) return yield* new NotFound({ entity: "slot", id })
      const sizes = new Map(
        (yield* sql<{ slot_id: string; n: number }>`
        SELECT v.slot_id, sum(${sql.literal(versionBytes("v", "t"))}) AS n
        FROM json_each(${requested}) asked CROSS JOIN versions v ON v.slot_id = asked.value
          CROSS JOIN version_texts t ON t.version_seq = v.seq
        WHERE v.deleted_at IS NULL GROUP BY v.slot_id`).map((row) => [row.slot_id, row.n])
      )
      // A structural slot belongs to exactly its chain intervals. Insertions additionally
      // need display placement, so those few use the existing single-delete path probe.
      const retained = new Set(
        (yield* sql<{ id: string }>`WITH RECURSIVE
        segments(fork_id, chain_id, lo, hi) AS MATERIALIZED (
          SELECT f.id, t.chain_id, h.depth, t.depth FROM forks f
            CROSS JOIN slots t ON t.id = f.tip_slot_id CROSS JOIN slots h ON h.id = t.chain_id
          WHERE f.chat_id = ${chatId} AND f.id <> ${forkId} AND f.purged_at IS NULL
          UNION ALL SELECT g.fork_id, p.chain_id, h.depth, p.depth FROM segments g
            JOIN slots head ON head.id = g.chain_id JOIN slots p ON p.id = head.parent_slot_id
            JOIN slots h ON h.id = p.chain_id WHERE p.depth < g.lo AND h.depth <= p.depth
        ) SELECT s.id FROM json_each(${requested}) asked CROSS JOIN slots s ON s.id = asked.value
          WHERE s.inserted = 0 AND EXISTS (SELECT 1 FROM segments g WHERE g.chain_id = s.chain_id
            AND s.depth BETWEEN g.lo AND g.hi AND NOT ${slotDeletedIn(sql, sql.literal("g.fork_id"), "s")})`).map(
          (row) => row.id
        )
      )
      for (const slot of rows)
        if (slot.inserted === 1 && (yield* forksShowing(sql, chatId, slot.id, null, forkId, false, true)).length > 0)
          retained.add(slot.id)
      const own = new Map<string, { id: string; seq: number }>()
      for (const row of yield* sql<{ id: string; target_id: string; seq: number }>`
        SELECT id, target_id, seq FROM fork_overrides WHERE fork_id = ${forkId} AND kind = 'delete_slot'
          AND ${sql.in("target_id", slotIds)} ORDER BY seq DESC`)
        if (!own.has(row.target_id)) own.set(row.target_id, row)
      const [cutoff] = yield* sql<{ seq: number | null }>`
        SELECT max(branched_at) AS seq FROM forks WHERE parent_fork_id = ${forkId}`
      const [sequence] = yield* sql<{ seq: number }>`UPDATE chats SET state_seq = state_seq + ${2 * slotIds.length}
        WHERE id = ${chatId} RETURNING state_seq AS seq`
      const base = sequence!.seq - 2 * slotIds.length
      const group = uuidv7()
      const at = Date.now()
      const ordered = [...slotIds].sort((a, b) => slots.get(a)!.position! - slots.get(b)!.position!)
      const changes = ordered.map((slotId, index) => ({
        slot: slots.get(slotId)!,
        itemId: uuidv7(),
        seq: base + 2 * index + 1
      }))
      yield* sql`INSERT INTO bin_items ${sql.insert(
        changes.map(({ slot, itemId }) => ({
          id: itemId,
          user_id: userId,
          kind: "message",
          target_id: slot.id,
          chat_id: chatId,
          title: `Message in ${chatName(fork.title)}`,
          excerpt: excerpt(slot.content, 200),
          origin_json: JSON.stringify({
            chatId,
            chatTitle: fork.title,
            chatKind: fork.kind,
            slotId: slot.id,
            depth: slot.depth,
            position: slot.position,
            parentSlotId: slot.parent_slot_id,
            ...forkOrigin(fork),
            group,
            groupSize: slotIds.length
          }),
          byte_size: sizes.get(slot.id) ?? 0,
          deleted_at: at
        }))
      )}`
      // Exactly writeOverride's reuse rule: preserve a row any child froze. Reserve the
      // same alternating override/reduction seqs as deleteOne, then publish in bulk.
      yield* sql`INSERT INTO fork_overrides ${sql.insert(
        changes.map(({ slot, itemId, seq }) => {
          const previous = own.get(slot.id)
          return {
            id: previous && (cutoff!.seq === null || cutoff!.seq < previous.seq) ? previous.id : uuidv7(),
            chat_id: chatId,
            fork_id: forkId,
            seq,
            kind: "delete_slot",
            target_id: slot.id,
            slot_id: slot.id,
            slot_depth: slot.depth,
            value_id: null,
            flag: 1,
            bin_item_id: itemId,
            summaries_done: 0,
            changeset_id: null,
            origin: "user"
          }
        })
      )} ON CONFLICT(id) DO UPDATE SET value_id = excluded.value_id, flag = excluded.flag, seq = excluded.seq,
        bin_item_id = excluded.bin_item_id, summaries_done = excluded.summaries_done, origin = excluded.origin`
      yield* sql`INSERT INTO history_changes ${sql.insert(
        changes.map(({ slot, seq }) => ({
          slot_id: slot.id,
          fork_id: forkId,
          chat_id: chatId,
          depth: slot.depth,
          revision: 1,
          seq: seq + 1
        }))
      )}`
      const marked = changes.filter(({ slot }) => !retained.has(slot.id))
      if (marked.length > 0)
        yield* sql`UPDATE slots SET deleted_at = ${at}, bin_item_id = mark.value ->> 1
        FROM json_each(${JSON.stringify(marked.map(({ slot, itemId }) => [slot.id, itemId]))}) mark
        WHERE slots.id = mark.value ->> 0`
      yield* relocateLeaf(chatId)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${chatId}`
      return changes.map((change) => change.itemId)
    })

  /**
   * Deletes one fork (owner, 2026-10-27): only that fork goes, and forks made from it keep
   * their shared history. The fork is marked and its bin item names it. The messages of its
   * path that no other live fork shows are marked under the item (so they leave the
   * switcher and a purge can empty them); the rest stay, shown by the forks that have them.
   * That includes the inserted messages it shows, which another fork may show by its own
   * `insert` row (`insertedUnseen`).
   */
  const removeFork = (
    userId: UserId,
    forkId: string,
    group?: { readonly itemId: string; readonly forkIds: ReadonlyArray<string> }
  ) =>
    Effect.gen(function* () {
      const [fork] = yield* sql<ForkRow & { chat_title: string }>`
        SELECT f.*, c.title AS chat_title FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND f.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
      const others = yield* sql<ForkRow>`
        SELECT * FROM forks WHERE chat_id = ${fork.chat_id} AND purged_at IS NULL AND id NOT IN ${sql.in(group?.forkIds ?? [forkId])}`
      const below =
        fork.tip_slot_id === null
          ? Number.MAX_SAFE_INTEGER
          : (yield* sharedDepth(
              sql,
              fork.chat_id,
              fork.tip_slot_id,
              others.flatMap((other) => (other.tip_slot_id === null ? [] : [other.tip_slot_id]))
            )) + 1
      const unseen = (statement: "count" | "mark", itemId = "") =>
        fork.tip_slot_id === null
          ? Effect.succeed([{ slots: 0, bytes: 0 }])
          : statement === "count"
            ? sql<{ slots: number; bytes: number }>`
                ${pathSegments(sql, fork.chat_id, fork.tip_slot_id, null)}
                SELECT count(DISTINCT s.id) AS slots, coalesce(sum(${sql.literal(versionBytes("v", "vt"))}), 0) AS bytes
                FROM segments g JOIN slots s ON s.chain_id = g.chain_id AND s.depth BETWEEN max(g.lo, ${below}) AND g.hi
                  LEFT JOIN versions v ON v.slot_id = s.id AND v.deleted_at IS NULL
              LEFT JOIN version_texts vt ON vt.version_seq = v.seq
                WHERE s.deleted_at IS NULL`
            : sql<{ slots: number; bytes: number }>`
                ${pathSegments(sql, fork.chat_id, fork.tip_slot_id, null)}
                UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}
                WHERE deleted_at IS NULL AND id IN (SELECT s.id FROM segments g JOIN slots s ON s.chain_id = g.chain_id
                  AND s.depth BETWEEN max(g.lo, ${below}) AND g.hi)
                RETURNING 0 AS slots, 0 AS bytes`
      const [counted] = yield* unseen("count")
      const inserted = yield* insertedUnseen(fork, others, below)
      const added = yield* sizeOf(inserted.marked)
      const kept = yield* sizeOf(inserted.kept)
      const stats = {
        slots: counted!.slots + added.slots - kept.slots,
        bytes: counted!.bytes + added.bytes - kept.bytes
      }
      const end = yield* lastShown(sql, fork.chat_id, fork)
      const [tip] = yield* sql<{ content: string }>`
        SELECT v.content FROM slots t JOIN version_records v ON v.id = ${shownIn(sql, forkId, "t")} WHERE t.id = ${end}`
      const itemId = group
        ? group.itemId
        : yield* insertItem({
            userId,
            kind: "branch",
            targetId: forkId,
            chatId: fork.chat_id,
            title: `Fork of ${stats.slots} message${stats.slots === 1 ? "" : "s"} in ${chatName(fork.chat_title)}`,
            excerpt: tip?.content ?? "",
            origin: {
              chatId: fork.chat_id,
              chatTitle: fork.chat_title,
              slotId: fork.tip_slot_id,
              parentSlotId: fork.base_slot_id,
              messages: stats.slots,
              ...forkOrigin(fork)
            },
            byteSize: stats.bytes
          })
      if (group) yield* sql`UPDATE bin_items SET byte_size = byte_size + ${stats.bytes} WHERE id = ${itemId}`
      yield* unseen("mark", itemId)
      if (inserted.kept.length > 0)
        yield* sql`UPDATE slots SET deleted_at = NULL, bin_item_id = NULL
          WHERE bin_item_id = ${itemId} AND ${sql.in("id", inserted.kept)}`
      if (inserted.marked.length > 0)
        yield* sql`UPDATE slots SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}
          WHERE deleted_at IS NULL AND ${sql.in("id", inserted.marked)}`
      // The head of what it marked is a barrier, as a deleted branch's root always was: a message
      // deleted on its own below it that's restored later doesn't bring the fork's slots back.
      yield* sql`UPDATE slots SET branch_deleted = 1 WHERE bin_item_id = ${itemId}
        AND NOT EXISTS (SELECT 1 FROM slots p WHERE p.id = slots.parent_slot_id AND p.bin_item_id = slots.bin_item_id)`
      yield* sql`UPDATE forks SET deleted_at = ${Date.now()}, bin_item_id = ${itemId}, row_version = row_version + 1
        WHERE id = ${forkId}`
      yield* replaceCurrentFork(fork.chat_id)
      yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${fork.chat_id}`
      return itemId
    })

  const deleteFork = (userId: UserId, forkId: string) =>
    Effect.gen(function* () {
      const [fork] = yield* sql<{ chat_id: string }>`SELECT f.chat_id FROM forks f JOIN chats c ON c.id = f.chat_id
      WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND f.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
      const [other] =
        yield* sql`SELECT id FROM forks WHERE chat_id = ${fork.chat_id} AND id <> ${forkId} AND deleted_at IS NULL LIMIT 1`
      if (!other) return yield* new CannotDeleteLastFork()
      return yield* removeFork(userId, forkId)
    })

  const loadChatGroup = (userId: UserId, chatId: string, forkId: string | null) =>
    Effect.gen(function* () {
      const [chat] = yield* sql`SELECT id FROM chats WHERE id = ${chatId}
        AND owner_user_id = ${userId} AND deleted_at IS NULL`
      if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
      const forks = yield* sql<ForkRow>`SELECT * FROM forks WHERE chat_id = ${chatId}`
      const groups = splitGroups(forks, yield* splitChatMarkers(sql, userId))
      const shown = forks.find(
        (f) => f.deleted_at === null && (forkId === null ? groups.get(f.id) === chatId : f.id === forkId)
      )
      if (!shown) return yield* new NotFound({ entity: "chat group", id: forkId ?? chatId })
      const groupId = groups.get(shown.id)!
      return { groupId, members: forks.filter((f) => f.deleted_at === null && groups.get(f.id) === groupId) }
    })

  const removeChatGroup = (
    userId: UserId,
    chatId: string,
    groupId: string,
    members: ReadonlyArray<ForkRow>,
    title: string
  ) =>
    Effect.gen(function* () {
      const itemId = yield* insertItem({
        userId,
        kind: "branch",
        targetId: groupId,
        chatId,
        title,
        excerpt: `${members.length} branch${members.length === 1 ? "" : "es"}`,
        origin: { chatId, chatTitle: title, forkId: members[0]!.id, forkIds: members.map((f) => f.id), groupId },
        byteSize: 0
      })
      const group = { itemId, forkIds: members.map((f) => f.id) }
      for (const member of members) yield* removeFork(userId, member.id, group)
      return itemId
    })

  /**
   * Undo of starting threads (spec/THREADS.md §5.2): one bin item of kind `threads` naming the
   * split, which takes the threads' own forks as `deleteFork` takes a branch (forks made from
   * them later stay), and in the branch they were started in, suppresses the split's away marks
   * and its corrections of the played stretch (`setSplitApplied`). Restoring reverses both.
   */
  const removeThreads = (userId: UserId, chatId: string, splitId: string) =>
    Effect.gen(function* () {
      const [split] = yield* sql<{
        id: string
        fork_id: string
        slot_id: string
        bin_item_id: string | null
        chat_title: string | null
        depth: number
      }>`SELECT x.id, x.fork_id, x.slot_id, x.bin_item_id, c.title AS chat_title, s.depth FROM thread_splits x
        JOIN chats c ON c.id = x.chat_id JOIN slots s ON s.id = x.slot_id
        WHERE x.id = ${splitId} AND x.chat_id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
      if (!split || split.bin_item_id !== null) return yield* new NotFound({ entity: "threads", id: splitId })
      // S as the branch it was started in numbers it.
      const position = (yield* displayThrough(sql, chatId, split.fork_id, split.slot_id))?.end ?? split.depth
      const members = yield* sql<{ fork_id: string; name: string | null }>`
        SELECT m.fork_id, m.name FROM thread_members m JOIN forks f ON f.id = m.fork_id
        WHERE m.split_id = ${splitId} AND m.starts = 1 AND f.deleted_at IS NULL ORDER BY m.ordinal`
      if (members.length === 0) return yield* new NotFound({ entity: "threads", id: splitId })
      const forkIds = members.map((m) => m.fork_id)
      const named = members.flatMap((m) => (m.name === null ? [] : [m.name]))
      const itemId = yield* insertItem({
        userId,
        kind: "threads",
        targetId: splitId,
        chatId,
        title: `${members.length === 1 ? "A thread" : `${members.length} threads`} in ${chatName(split.chat_title)}`,
        excerpt: named.join(", "),
        origin: {
          chatId,
          chatTitle: split.chat_title,
          splitId,
          slotId: split.slot_id,
          position,
          parentForkId: split.fork_id,
          forkId: forkIds[0]!,
          forkIds
        },
        byteSize: 0
      })
      for (const forkId of forkIds) yield* removeFork(userId, forkId, { itemId, forkIds })
      yield* setSplitApplied(sql, { id: splitId, chatId, forkId: split.fork_id }, false, itemId)
      return itemId
    })

  /** One visible chat group, in one bin item; deeper split groups keep their shared path. */
  const deleteChatGroup = (
    userId: UserId,
    chatId: string,
    forkId: string,
    expected: ReadonlyArray<string>,
    title: string
  ) =>
    Effect.gen(function* () {
      const { groupId, members } = yield* loadChatGroup(userId, chatId, forkId)
      const confirmed = new Set(expected)
      if (confirmed.size !== members.length || !members.every((f) => confirmed.has(f.id)))
        return yield* new BinChanged()
      return yield* removeChatGroup(userId, chatId, groupId, members, title)
    })

  /**
   * Deletes one swipe in a fork. The only remaining version of a message in the fork takes the
   * message with it. A fork's copy standing in for a version (schema/forkVersions.ts) is deleted
   * as that version.
   */
  const deleteVersion = (userId: UserId, shownId: string, forkId?: string | null) =>
    Effect.gen(function* () {
      const [version] = yield* sql<{
        id: string
        slot_id: string
        chat_id: string
        ordinal: number
        content: string
        bytes: number
      }>`
        SELECT o.id, o.slot_id, s.chat_id, o.ordinal, x.content,
          ${sql.literal(versionBytes("o"))} + (SELECT coalesce(sum(${sql.literal(versionBytes("c"))}), 0)
            FROM version_records c WHERE c.source_version_id = o.id AND c.fork_id IS NOT NULL) AS bytes
        FROM version_records x JOIN version_records o ON o.id = ${sql.literal(originalSql("x"))}
          JOIN slots s ON s.id = o.slot_id JOIN chats c ON c.id = s.chat_id
        WHERE x.id = ${shownId} AND c.owner_user_id = ${userId}
          AND o.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`
      if (!version) return yield* new NotFound({ entity: "version", id: shownId })
      const versionId = version.id
      const fork = yield* deletingFork(version.chat_id, version.slot_id, forkId)
      const others = yield* sql<{ id: string; ordinal: number }>`
        SELECT o.id, o.ordinal FROM versions o WHERE o.slot_id = ${version.slot_id} AND o.id <> ${versionId}
          AND o.fork_id IS NULL AND NOT ${versionDeletedIn(sql, fork.id, "o")}
        ORDER BY o.ordinal`
      const [here] = yield* sql<{ gone: number }>`
        SELECT (${versionDeletedIn(sql, fork.id, "o")} OR ${slotDeletedIn(sql, fork.id, "s")}) AS gone
        FROM versions o JOIN slots s ON s.id = o.slot_id WHERE o.id = ${versionId}`
      if (here!.gone) return yield* new NotFound({ entity: "version", id: shownId })
      if (others.length === 0) return yield* deleteMessage(userId, version.slot_id, fork.id)
      const slot = yield* ownedLiveSlot(userId, version.slot_id, fork.id)
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
          position: slot.position,
          ordinal: version.ordinal,
          ...forkOrigin(fork)
        },
        byteSize: version.bytes
      })
      yield* writeOverride(
        sql,
        { id: fork.id, chatId: slot.chat_id },
        { kind: "delete_version", targetId: versionId, slotId: slot.id, valueId: null, flag: 1, binItemId: itemId }
      )
      // Like ST, the fork shows the previous swipe if it showed this one, or the next one if
      // this was the first.
      const [selected] = yield* sql<{
        id: string
      }>`SELECT ${selectedIn(sql, fork.id, "s")} AS id FROM slots s WHERE s.id = ${slot.id}`
      if (selected!.id === versionId) {
        const previous = others.filter((o) => o.ordinal < version.ordinal).at(-1) ?? others[0]!
        yield* writeSelect(sql, { id: fork.id, chatId: slot.chat_id }, slot.id, previous.id)
        yield* recordReduction(sql, slot.id, fork.id)
      }
      const shown = yield* forksShowing(sql, slot.chat_id, slot.id, versionId, fork.id, false)
      if (shown.length === 0) {
        yield* sql`UPDATE versions SET deleted_at = ${Date.now()}, bin_item_id = ${itemId} WHERE id = ${versionId}`
      }
      return itemId
    })

  const deleteChat = (userId: UserId, chatId: string) =>
    Effect.gen(function* () {
      const [chat] = yield* sql<{ id: string; title: string }>`
        SELECT id, title FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
      if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
      // The legacy physical-chat operation must not erase its split-off groups either.
      const [split] = yield* sql`SELECT 1 FROM forks f WHERE f.chat_id = ${chatId} AND f.split_chat = 1 LIMIT 1`
      if (split) {
        const { groupId, members } = yield* loadChatGroup(userId, chatId, null)
        return yield* removeChatGroup(userId, chatId, groupId, members, chat.title || "Untitled chat")
      }
      // Messages and swipes already in the bin count under their own items.
      const [stats] = yield* sql<{ bytes: number; last: string | null; messages: number }>`
        SELECT coalesce(sum(CASE WHEN s.deleted_at IS NULL AND v.deleted_at IS NULL
                 THEN ${sql.literal(versionBytes("v"))} END), 0) AS bytes,
          count(DISTINCT s.id) AS messages,
          (SELECT v2.content FROM chats c2 JOIN slots s2 ON s2.id = c2.active_leaf_slot_id
             JOIN version_records v2 ON v2.id = ${sql.literal(shownInSql("c2.current_fork_id", "s2"))}
             WHERE c2.id = ${chatId}) AS last
        FROM slots s JOIN version_records v ON v.slot_id = s.id WHERE s.chat_id = ${chatId}`
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
          (SELECT label FROM entity_refs WHERE entity_id = e.id LIMIT 1) AS label,
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

  /** SQL: bin items that name the fork a deletion was in (`origin_json.forkId`). */
  const forkItems = `SELECT id FROM bin_items WHERE origin_json ->> '$.forkId' IS NOT NULL`

  /**
   * Restores what was deleted in a fork (`deleteMessage`, `deleteVersion`, `deleteFork`): the
   * fork's own row says it's back, and a mark the writer put on the slot or version under a
   * fork's item (it was shown by no live fork) is cleared, since a fork may show it again. The
   * other forks never lost anything.
   */
  const restoreInFork = (item: BinRow, forkId: string, recovered?: Map<string, string>) =>
    Effect.gen(function* () {
      const chatId = item.chat_id!
      const [fork] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${forkId} AND purged_at IS NULL`
      // Everything marked under the item, an ST import's copies of it included (§13).
      yield* sql`UPDATE slots SET deleted_at = NULL, bin_item_id = NULL, branch_deleted = 0 WHERE bin_item_id = ${item.id}
        AND purged_at IS NULL`
      yield* sql`UPDATE versions SET deleted_at = NULL, bin_item_id = NULL WHERE bin_item_id = ${item.id}
        AND purged_at IS NULL`
      if (item.kind === "branch" || item.kind === "threads") {
        yield* sql`UPDATE forks SET deleted_at = NULL, bin_item_id = NULL, row_version = row_version + 1
          WHERE id = ${forkId}`
        // Every message on its path is shown by it again, whoever's deletion marked it.
        if (fork?.tip_slot_id) {
          const onItsPath = sql`SELECT s.id FROM segments g JOIN slots s ON s.chain_id = g.chain_id
            AND s.depth BETWEEN g.lo AND g.hi`
          yield* sql`${pathSegments(sql, chatId, fork.tip_slot_id, null)}
            UPDATE slots SET deleted_at = NULL, bin_item_id = NULL, branch_deleted = 0 WHERE id IN (${onItsPath}) AND deleted_at IS NOT NULL
              AND purged_at IS NULL AND bin_item_id IN (${sql.literal(forkItems)})`
          yield* sql`${pathSegments(sql, chatId, fork.tip_slot_id, null)}
            UPDATE versions SET deleted_at = NULL, bin_item_id = NULL
            WHERE slot_id IN (${onItsPath}) AND deleted_at IS NOT NULL AND purged_at IS NULL
              AND bin_item_id IN (${sql.literal(forkItems)})`
        }
        // And every inserted message it shows by an `insert` row (spec/MESSAGE-INSERT.md §3.1).
        const placed = fork ? yield* placedInsertions(sql, chatId, fork.id) : []
        const insertedIds =
          placed.length === 0
            ? []
            : (yield* pathPieces(sql, chatId, fork!.id, fork!.tip_slot_id)).flatMap((piece) =>
                piece.kind === "inserted" ? [piece.slotId] : []
              )
        if (insertedIds.length > 0) {
          yield* sql`UPDATE slots SET deleted_at = NULL, bin_item_id = NULL, branch_deleted = 0
            WHERE ${sql.in("id", insertedIds)} AND deleted_at IS NOT NULL AND purged_at IS NULL
              AND bin_item_id IN (${sql.literal(forkItems)})`
          yield* sql`UPDATE versions SET deleted_at = NULL, bin_item_id = NULL
            WHERE ${sql.in("slot_id", insertedIds)} AND deleted_at IS NOT NULL AND purged_at IS NULL
              AND bin_item_id IN (${sql.literal(forkItems)})`
        }
      } else if (item.kind === "message" || item.kind === "version") {
        const slotId = JSON.parse(item.origin_json).slotId as string
        const target = item.target_id
        if (fork)
          yield* writeOverride(
            sql,
            { id: fork.id, chatId },
            {
              kind: item.kind === "message" ? "delete_slot" : "delete_version",
              targetId: target,
              slotId,
              valueId: null,
              flag: 0
            }
          )
        const table = item.kind === "message" ? "slots" : "versions"
        yield* sql.unsafe(
          `UPDATE ${table} SET deleted_at = NULL, bin_item_id = NULL WHERE id = ? AND deleted_at IS NOT NULL
             AND purged_at IS NULL AND bin_item_id IN (${forkItems})`,
          [target]
        )
        let restoredMessage = item.kind === "message"
        if (item.kind === "version" && fork) {
          // A global purge can remove this fork's last available alternative. Its automatic
          // slot deletion records the purged selection in value_id, unlike a user's deletion.
          const [automatic] = yield* sql`SELECT 1 FROM slots s JOIN fork_overrides o
            ON o.id = ${effectiveOverride(sql, "delete_slot", fork.id, "s.id")}
            WHERE s.id = ${slotId} AND o.flag = 1 AND o.value_id IS NOT NULL`
          if (automatic) {
            yield* writeOverride(
              sql,
              { id: fork.id, chatId },
              {
                kind: "delete_slot",
                targetId: slotId,
                slotId,
                valueId: null,
                flag: 0
              }
            )
            yield* writeSelect(sql, { id: fork.id, chatId }, slotId, target)
            restoredMessage = true
          }
        }
        if (restoredMessage && fork && fork.deleted_at === null) {
          // The fork's tip followed the delete up. If it's still where it went, it follows the
          // message back down. If the fork went on, the message isn't on its path any more, and
          // comes back as a fork of its own, from the fork, at its parent (§2.4).
          const [slot] = yield* sql<{
            parent_slot_id: string | null
          }>`SELECT parent_slot_id FROM slots WHERE id = ${slotId}`
          if (!(yield* onForkPath(sql, chatId, fork, slotId))) {
            const tip = slotId
            const parent = slot?.parent_slot_id ?? null
            // The tip went up past messages the fork had deleted before: it comes back from there too.
            if (fork.tip_slot_id === parent || fork.tip_slot_id === (yield* shownAbove(chatId, fork.id, parent))) {
              yield* sql`UPDATE forks SET tip_slot_id = ${tip}, row_version = row_version + 1 WHERE id = ${fork.id}`
            } else {
              const branch = yield* insertFork(sql, {
                chatId,
                parent: fork,
                baseSlotId: slot?.parent_slot_id ?? null,
                tipSlotId: tip,
                at: Date.now()
              })
              recovered?.set(forkId, branch.id)
            }
          }
        }
      }
    })

  const restore = (userId: UserId, itemId: string, recovered?: Map<string, string>) =>
    Effect.gen(function* () {
      const item = yield* loadItem(userId, itemId)
      if (item.kind === "card_asset") {
        const restoreAsset = assetRestorers.get("card_asset")
        if (!restoreAsset) return yield* new NotFound({ entity: "gallery", id: itemId })
        yield* restoreAsset(userId, JSON.parse(item.origin_json) as Record<string, unknown>)
        yield* sql`DELETE FROM bin_items WHERE id = ${itemId}`
        return toBinItem(item)
      }
      const origin = JSON.parse(item.origin_json) as { forkId?: string; forkIds?: ReadonlyArray<string> }
      const forkId = origin.forkId
      if (forkId !== undefined && item.chat_id !== null) {
        yield* discardDeletedQueue(item.chat_id)
        for (const restored of origin.forkIds ?? [forkId])
          yield* restoreInFork(item, recovered?.get(restored) ?? restored, recovered)
        // Undone threads apply in their branch again: its away marks and played-stretch corrections.
        if (item.kind === "threads") {
          const [split] = yield* sql<{ id: string; chat_id: string; fork_id: string }>`
            SELECT id, chat_id, fork_id FROM thread_splits WHERE id = ${item.target_id} AND bin_item_id = ${itemId}`
          if (split)
            yield* setSplitApplied(sql, { id: split.id, chatId: split.chat_id, forkId: split.fork_id }, true, null)
        }
        yield* replaceCurrentFork(item.chat_id)
        yield* sql`DELETE FROM bin_items WHERE id = ${itemId}`
        yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${item.chat_id}`
        return toBinItem(item)
      }
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
        threads: "slots",
        version: "versions",
        entity: "entities",
        connection: "connections",
        card_asset: "entities"
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
   * Undo of a multi-delete (`deleteMessages`): each item restored as `restore` restores it, in
   * the order given (the delete's, top down, so a fork's tip follows each message back down).
   * One already restored or deleted for good from the bin is skipped; NotFound when none is left.
   */
  const restoreMany = (userId: UserId, itemIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const requested = yield* sql<{ id: string; user_id: string }>`
        SELECT id, user_id FROM bin_items WHERE ${sql.in("id", itemIds)}`
      for (const item of requested)
        if (item.user_id !== userId) return yield* new NotFound({ entity: "bin item", id: item.id })
      const present = new Set(requested.map((item) => item.id))
      const restored: Array<BinItem> = []
      const groups = new Map<string, Map<string, string>>()
      for (const itemId of itemIds) {
        if (!present.has(itemId)) continue
        const item = yield* loadItem(userId, itemId)
        const group = (JSON.parse(item.origin_json) as { group?: string }).group
        let recovered = group === undefined ? undefined : groups.get(group)
        if (group !== undefined && recovered === undefined) {
          recovered = new Map()
          groups.set(group, recovered)
        }
        restored.push(yield* restore(userId, itemId, recovered))
      }
      if (restored.length === 0) return yield* new NotFound({ entity: "bin item", id: itemIds[0] ?? "" })
      return restored
    })

  /**
   * `versionId` is going for good: every fork of the chat that selects it selects another swipe of
   * the message that it still shows, or, with none left, deletes the message in its own view.
   */
  const dropSelections = (chatId: string, slotId: string, versionId: string) =>
    Effect.gen(function* () {
      const [gone] = yield* sql<{ ordinal: number }>`SELECT ordinal FROM versions WHERE id = ${versionId}`
      const forks = yield* sql<{ id: string }>`
        SELECT f.id FROM forks f JOIN slots s ON s.id = ${slotId}
        WHERE f.chat_id = ${chatId} AND ${selectedIn(sql, sql.literal("f.id"), "s")} = ${versionId}`
      for (const fork of forks) {
        const left = yield* sql<{ id: string; ordinal: number }>`
          SELECT o.id, o.ordinal FROM versions o WHERE o.slot_id = ${slotId} AND o.id <> ${versionId}
            AND o.fork_id IS NULL AND NOT ${versionDeletedIn(sql, fork.id, "o")} ORDER BY o.ordinal`
        const next = left.filter((o) => o.ordinal < gone!.ordinal).at(-1) ?? left[0]
        if (next) yield* writeSelect(sql, { id: fork.id, chatId }, slotId, next.id)
        else
          yield* writeOverride(
            sql,
            { id: fork.id, chatId },
            { kind: "delete_slot", targetId: slotId, slotId, valueId: versionId, flag: 1 }
          )
      }
      yield* relocateLeaf(chatId)
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
            `UPDATE version_records SET purged_at = ?, content = '', reasoning = NULL, raw_content = NULL,
               raw_reasoning = NULL, raw_sections = NULL, rewrite_json = NULL, reply_sections = NULL, display_form = NULL,
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

      // What was deleted in a fork is erased everywhere (owner, 2026-10-27, Q3 (b)): the client
      // warned which forks show it first (`BinItemForks`). The message or swipe is marked under
      // the item, so the purge below empties it; forks that showed a swipe select another, or
      // delete the message in their own view when it was its last.
      const forkOwned = (kind: "message" | "version") =>
        sql.unsafe<{ id: string; chat_id: string; target_id: string; slot_id: string }>(
          `SELECT id, chat_id, target_id, origin_json ->> '$.slotId' AS slot_id FROM bin_items
           WHERE kind = '${kind}' AND origin_json ->> '$.forkId' IS NOT NULL AND chat_id IS NOT NULL AND (${where})`,
          params
        )
      const erasedMessages = yield* forkOwned("message")
      for (const item of erasedMessages) {
        yield* recordReduction(sql, item.target_id, null)
        yield* sql`UPDATE slots SET deleted_at = coalesce(deleted_at, ${now}), bin_item_id = ${item.id}
          WHERE id = ${item.target_id} AND purged_at IS NULL`
      }
      for (const item of yield* forkOwned("version")) {
        yield* recordReduction(sql, item.slot_id, null)
        yield* sql`UPDATE versions SET deleted_at = coalesce(deleted_at, ${now}), bin_item_id = ${item.id}
          WHERE id = ${item.target_id} AND purged_at IS NULL`
        yield* dropSelections(item.chat_id, item.slot_id, item.target_id)
      }

      // A chat goes with everything in it, its other bin items included.
      yield* run(`DELETE FROM bin_items WHERE kind <> 'chat' AND chat_id IN (${targets("chat")})`)
      yield* run(`DELETE FROM chats WHERE id IN (${targets("chat")})`)

      // Messages and branches keep their slots as empty placeholders, so the
      // conversation's structure and any summaries over it remain valid. A branch's forks
      // keep their rows, losing their names and tips.
      yield* run(`UPDATE slots SET purged_at = ? WHERE bin_item_id IN (${items("'message', 'branch', 'threads'")})`, [
        now
      ])
      // The head of a purged fork's slots stays a barrier, as a purged branch's root always did.
      yield* run(
        `UPDATE slots SET branch_deleted = 1 WHERE bin_item_id IN (${items("'branch', 'threads'")})
           AND NOT EXISTS (SELECT 1 FROM slots p WHERE p.id = slots.parent_slot_id AND p.bin_item_id = slots.bin_item_id)`
      )
      yield* run(
        `UPDATE forks SET purged_at = ?, name = NULL, tip_slot_id = NULL, bin_item_id = NULL, row_version = row_version + 1
         WHERE bin_item_id IN (${items("'branch', 'threads'")})`,
        [now]
      )
      yield* purgeVersions(
        `slot_id IN (SELECT id FROM slots WHERE bin_item_id IN (${items("'message', 'branch', 'threads'")}))`
      )
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

      yield* run(
        `DELETE FROM bin_items WHERE kind = 'card_asset' AND origin_json ->> '$.entityId' IN (${targets("entity")})`
      )
      yield* run(`DELETE FROM bin_items WHERE ${where}`)
      // A message erased everywhere has no other deletion left to restore, and a fork whose tip it
      // was goes up out of it.
      for (const item of erasedMessages)
        yield* sql`DELETE FROM bin_items WHERE kind = 'message' AND target_id = ${item.target_id}`
      for (const chatId of new Set(erasedMessages.map((item) => item.chat_id))) yield* relocateLeaf(chatId)
    })

  const confirmForks = (
    userId: UserId,
    itemIds: ReadonlyArray<string>,
    expectedForkIds: ReadonlyArray<string> | undefined
  ) =>
    Effect.gen(function* () {
      if (expectedForkIds === undefined) return
      const actual = new Set((yield* binItemForks(sql, userId, itemIds)).map((fork) => fork.forkId))
      const expected = new Set(expectedForkIds)
      if (actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) return yield* new BinChanged()
    })

  const purge = (userId: UserId, itemId: string, expectedForkIds?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const item = yield* loadItem(userId, itemId)
      yield* confirmForks(userId, [itemId], expectedForkIds)
      yield* purgeWhere("id = ?", [item.id])
      return item.chat_id === null ? [] : [item.chat_id]
    })

  const emptyBin = (userId: UserId, itemIds: ReadonlyArray<string>, expectedForkIds?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        id: string
        chat_id: string | null
      }>`SELECT id, chat_id FROM bin_items WHERE user_id = ${userId}`
      const confirmed = new Set(itemIds)
      if (rows.length !== confirmed.size || !rows.every((row) => confirmed.has(row.id))) {
        return yield* new BinChanged()
      }
      yield* confirmForks(userId, itemIds, expectedForkIds)
      // The comparison and purge share this writer transaction: every current item was confirmed.
      yield* purgeWhere("user_id = ?", [userId])
      return {
        purged: rows.length,
        chatIds: [...new Set(rows.flatMap((row) => (row.chat_id === null ? [] : [row.chat_id])))]
      }
    })

  /**
   * Keeps the deleted-items section within its limits by deleting the oldest items for
   * good, never `created`, the item the delete just made. Each purge runs in its own
   * savepoint: one that fails is rolled back, logged and skipped. If the items that can
   * go can't make room, nothing goes: the bin stays over its limits rather than losing
   * everything else to one delete, and later deletes or emptying it bring it back.
   */
  const evictDeleted = (userId: UserId, created: string | ReadonlyArray<string>) =>
    Effect.gen(function* () {
      // A multi-delete's items are all just made: none of them makes room for the others.
      const made = typeof created === "string" ? [created] : created
      const limits = yield* readBinLimits(sql, userId, defaults)
      const fits = sql<{ n: number; bytes: number }>`
        SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS bytes FROM bin_items WHERE user_id = ${userId}`.pipe(
        Effect.map(([usage]) => usage!.n <= limits.deletedItems && usage!.bytes <= limits.deletedBytes)
      )
      if (yield* fits) return
      const [newest] = yield* sql<{ n: number; bytes: number }>`
        SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS bytes FROM bin_items WHERE ${sql.in("id", made)}`
      // Not even evicting everything else would make room.
      if (limits.deletedItems < newest!.n || newest!.bytes > limits.deletedBytes) return
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            let after = { deleted_at: -1, id: "" }
            while (!(yield* fits)) {
              const [oldest] = yield* sql<BinRow>`
                SELECT * FROM bin_items
                WHERE user_id = ${userId} AND NOT ${sql.in("id", made)} AND (deleted_at, id) > (${after.deleted_at}, ${after.id})
                ORDER BY deleted_at, id LIMIT 1`
              if (!oldest) return yield* new NoRoom()
              after = oldest
              // Another deletion of the same content must remain restorable.
              const [protectedItem] = yield* sql`SELECT 1 FROM bin_items
                WHERE id <> ${oldest.id} AND chat_id = ${oldest.chat_id} AND (
                  (kind = ${oldest.kind} AND target_id = ${oldest.target_id}) OR
                  (kind IN ('message', 'version') AND origin_json ->> '$.slotId' = ${JSON.parse(oldest.origin_json).slotId ?? null}
                    AND (${oldest.kind} = 'message' OR kind = 'message')))`
              if (protectedItem && (oldest.kind === "message" || oldest.kind === "version")) continue
              // Making room never erases what another fork still shows: its deletion in its own
              // fork becomes permanent, and the item goes.
              const origin = JSON.parse(oldest.origin_json) as { forkId?: string; slotId?: string }
              if (
                origin.forkId !== undefined &&
                (oldest.kind === "message" || oldest.kind === "version") &&
                oldest.chat_id !== null
              ) {
                // A deleted fork, or a locally deleted message, can become visible again. Its
                // path still retains the content even when forksShowing quite correctly omits it.
                const others = yield* sql<ForkRow>`SELECT * FROM forks
                  WHERE chat_id = ${oldest.chat_id} AND id <> ${origin.forkId} AND purged_at IS NULL`
                let retained = false
                for (const other of others) {
                  // An inserted message is retained by a fork that inherits it (its display path).
                  if (yield* onForkPath(sql, oldest.chat_id, other, origin.slotId!)) {
                    retained = true
                    break
                  }
                }
                if (retained) {
                  const [marked] = yield* sql`SELECT 1 FROM slots WHERE bin_item_id = ${oldest.id}
                    UNION ALL SELECT 1 FROM versions WHERE bin_item_id = ${oldest.id} LIMIT 1`
                  if (!marked) yield* sql`DELETE FROM bin_items WHERE id = ${oldest.id}`
                  continue
                }
              }
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
        case "user_field":
          return `${key.targetId} › ${key.field}`
        case "queue_edit":
          return `Queued text in ${yield* chatTitle(`SELECT title FROM chats WHERE id = ?`)}`
        case "insert":
          return `Inserted message in ${yield* chatTitle(`SELECT title FROM chats WHERE id = ?`)}`
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
          const [ref] = yield* sql<{
            label: string
          }>`SELECT label FROM entity_refs WHERE id = ${parseDraftTarget(key.targetId).refId}`
          return [ref?.label ?? "A library entry", key.field].filter(Boolean).join(" › ")
        }
        case "remote_card":
          return `A card not in your cards › ${key.field}`
      }
    })

  /** Saves draft text that a commit or discard would otherwise lose. Never shown as a toast. */
  const recover = (userId: UserId, key: DraftKey, texts: ReadonlyArray<string>, reason: "commit" | "discard") =>
    Effect.gen(function* () {
      // `texts` come newest first; inserting oldest first keeps "newest first" listings right.
      // A value draft of `null` removed a list element (a lorebook entry, say): it holds no text.
      const removal = (t: string) => key.field.startsWith("=") && t === "null"
      const unique = [...new Set(texts)].filter((t) => t.trim().length > 0 && !removal(t)).reverse()
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
      const limits = yield* readBinLimits(sql, userId, defaults)
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
    insertItem,
    assetRestorers,
    deleteChat,
    deleteChatGroup,
    deleteMessage,
    deleteMessages,
    deleteFork,
    removeThreads,
    deleteVersion,
    deleteEntity,
    deleteConnection,
    restore,
    restoreMany,
    purge,
    emptyBin,
    evictDeleted,
    loadItem,
    loadItems,
    recover,
    recoverQueued
  }
}

export type Bin = ReturnType<typeof makeBin>
