// The warning and the purge use the same fork view; the writer rechecks it before erasing.
import { BinBranch, BinForkShown } from "@rp/shared/bin.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { type PathPiece, displaySlots, pathPieces, positionOf, slotPlace } from "./displayPath.ts"
import { forkRecency, forksShowing, lastShown } from "./forks.ts"
import { slotDeletedIn } from "./forkState.ts"
import { tipPreview } from "./previewTip.ts"
import type { ForkRow } from "./rows.ts"

export const binItemForks = (sql: SqlClient.SqlClient, userId: UserId, itemIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const shown: Array<BinForkShown> = []
    const items =
      itemIds.length === 0
        ? []
        : yield* sql<{ id: string; kind: string; target_id: string; chat_id: string; origin_json: string }>`
                SELECT id, kind, target_id, chat_id, origin_json FROM bin_items
                WHERE user_id = ${userId} AND kind IN ('message', 'version') AND chat_id IS NOT NULL
                  AND ${sql.in("id", itemIds)}`
    for (const item of items) {
      const origin = JSON.parse(item.origin_json) as { forkId?: string; slotId?: string; chatTitle?: string }
      if (origin.forkId === undefined || origin.slotId === undefined) continue
      const forks = yield* forksShowing(
        sql,
        item.chat_id,
        origin.slotId,
        item.kind === "version" ? item.target_id : null,
        origin.forkId,
        false
      )
      for (const fork of forks) {
        const end = yield* lastShown(sql, item.chat_id, fork)
        const tip = yield* tipPreview(sql, userId, item.chat_id, fork.id, end, 80)
        shown.push(
          new BinForkShown({
            itemId: item.id,
            forkId: fork.id,
            chatTitle: origin.chatTitle ?? "",
            name: fork.name,
            tipExcerpt: tip,
            deleted: fork.deleted_at !== null
          })
        )
      }
    }
    return shown
  })

/** How far from a message the nearest one a branch shows is looked for, each way. */
const NEAR = 200

/**
 * Every branch that deleting the items for good affects (`BinBranch`), for the confirmation to
 * list and link. A message or swipe deleted in a fork: the forks that show it (`binItemForks`,
 * so `shows` is exactly the set the purge confirms), then those that hold it only in the bin, the
 * fork that deleted it and any other whose own bin item deleted the same message or swipe (a
 * purge erases what those would restore too). A fork deleted on its own: that fork, as what it
 * takes is what no other fork has. A chat: every fork of it. Most recently current first in each.
 */
export const binItemBranches = (sql: SqlClient.SqlClient, userId: UserId, itemIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (itemIds.length === 0) return []
    const items = yield* sql<{ id: string; kind: string; target_id: string; chat_id: string; origin_json: string }>`
      SELECT id, kind, target_id, chat_id, origin_json FROM bin_items
      WHERE user_id = ${userId} AND kind IN ('message', 'version', 'branch', 'chat') AND chat_id IS NOT NULL
        AND ${sql.in("id", itemIds)}
      ORDER BY deleted_at DESC, id DESC`
    const showing = yield* binItemForks(sql, userId, itemIds)
    const titles = new Map<string, string>()
    for (const chatId of new Set(items.map((item) => item.chat_id))) {
      const [chat] = yield* sql<{ title: string }>`SELECT title FROM chats WHERE id = ${chatId}`
      titles.set(chatId, chat?.title ?? "")
    }
    // Each chat's forks once: the branch list's numbering, and what's current.
    const chats = new Map<string, { forks: ReadonlyArray<ForkRow>; current: string | null }>()
    const forksOf = (chatId: string) =>
      Effect.gen(function* () {
        const known = chats.get(chatId)
        if (known !== undefined) return known
        const forks = yield* sql<ForkRow>`
          SELECT f.* FROM forks f WHERE f.chat_id = ${chatId} AND f.purged_at IS NULL
          ORDER BY ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
        const [chat] = yield* sql<{
          current: string | null
        }>`SELECT current_fork_id AS current FROM chats WHERE id = ${chatId}`
        const read = { forks, current: chat?.current ?? null }
        chats.set(chatId, read)
        return read
      })
    /** "Branch k" as the header numbers it: among the chat's live forks made from another, by when. */
    const numberOf = (forks: ReadonlyArray<ForkRow>, fork: ForkRow) =>
      fork.parent_fork_id === null
        ? null
        : forks.filter(
            (f) =>
              f.id !== fork.id &&
              f.parent_fork_id !== null &&
              f.deleted_at === null &&
              (f.created_at < fork.created_at || (f.created_at === fork.created_at && f.id < fork.id))
          ).length + 1
    const tipOf = (chatId: string, fork: ForkRow) =>
      Effect.gen(function* () {
        const end = yield* lastShown(sql, chatId, fork)
        return yield* tipPreview(sql, userId, chatId, fork.id, end, 80)
      })
    /** The nearest message `fork` shows in positions `first` to `last` of `pieces`, nearest `towards` first. */
    const nearestShown = (
      fork: ForkRow,
      pieces: ReadonlyArray<PathPiece>,
      first: number,
      last: number,
      descending: boolean
    ) =>
      last < Math.max(0, first)
        ? Effect.succeed(null)
        : Effect.map(
            sql<{ id: string; position: number }>`
              ${displaySlots(sql, pieces, Math.max(0, first), last)}
              SELECT d.id, d.position FROM display_slots d JOIN slots s ON s.id = d.id
              WHERE NOT ${slotDeletedIn(sql, fork.id, "s")}
              ORDER BY d.position ${sql.literal(descending ? "DESC" : "ASC")} LIMIT 1`,
            ([row]) => (row === undefined ? null : { slotId: row.id, position: row.position })
          )
    /** Where `slotId` is in `fork` and the message to open it at there. */
    const placeIn = (chatId: string, fork: ForkRow, slotId: string, shown: boolean) =>
      Effect.gen(function* () {
        const place = yield* slotPlace(sql, chatId, slotId)
        if (place === null) return { position: null, link: null }
        const own = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
        const onIt = positionOf(own, place)
        // Off its path (it was its tip, and the fork went on): numbered on the path to it.
        const through = onIt === null ? yield* pathPieces(sql, chatId, fork.id, slotId) : own
        const position = onIt ?? positionOf(through, place)
        if (position === null) return { position: null, link: null }
        if (shown) return { position, link: { slotId, position } }
        // Above it, on the path to it, are messages its path shares; below it only on its own path.
        let link = yield* nearestShown(fork, through, position - NEAR, position - 1, true)
        if (link !== null && onIt === null) {
          const linked = yield* slotPlace(sql, chatId, link.slotId)
          const at = linked === null ? null : positionOf(own, linked)
          link = at === null ? null : { slotId: link.slotId, position: at }
        }
        if (link === null && onIt !== null) link = yield* nearestShown(fork, own, position + 1, position + NEAR, false)
        return { position, link }
      })

    const branches: Array<BinBranch> = []
    for (const item of items) {
      const start = branches.length
      const chatId = item.chat_id
      const chatTitle = titles.get(chatId) ?? ""
      const { forks, current } = yield* forksOf(chatId)
      const byId = new Map(forks.map((fork) => [fork.id, fork]))
      // Where each parts from its parent, as the chat's branch list names it; a binned one has none stored.
      const splits = new Map(
        (yield* sql<{ fork_id: string; split_at: number | null; split_after: number | null }>`
          SELECT fork_id, split_at, split_after FROM fork_summaries WHERE chat_id = ${chatId}`).map((row) => [
          row.fork_id,
          row.split_at === null || row.split_after === null ? null : { at: row.split_at, after: row.split_after }
        ])
      )
      const entry = (
        fork: ForkRow,
        state: BinBranch["state"],
        shows: boolean,
        place: { position: number | null; link: BinBranch["link"] }
      ) =>
        Effect.map(
          tipOf(chatId, fork),
          (tipExcerpt) =>
            new BinBranch({
              itemId: item.id,
              chatId,
              chatTitle,
              forkId: fork.id,
              name: fork.name,
              original: fork.parent_fork_id === null,
              number: numberOf(forks, fork),
              split: splits.get(fork.id) ?? null,
              createdAt: fork.created_at,
              tipExcerpt,
              current: fork.id === current,
              state,
              shows,
              position: place.position,
              link: place.link
            })
        )
      const nowhere = { position: null, link: null }
      if (item.kind === "chat") {
        for (const fork of forks) branches.push(yield* entry(fork, "chatInBin", false, nowhere))
        continue
      }
      if (item.kind === "branch" || item.kind === "threads") {
        for (const fork of forks.filter((f) => (f as ForkRow & { bin_item_id: string | null }).bin_item_id === item.id))
          branches.push(yield* entry(fork, "branchInBin", false, nowhere))
        continue
      }
      const origin = JSON.parse(item.origin_json) as { forkId?: string; slotId?: string }
      const slotId = origin.slotId
      if (origin.forkId === undefined || slotId === undefined) continue
      const named = new Set<string>()
      for (const shown of showing.filter((s) => s.itemId === item.id)) {
        const fork = byId.get(shown.forkId)
        if (fork === undefined || named.has(fork.id)) continue
        named.add(fork.id)
        const live = fork.deleted_at === null
        branches.push(
          yield* entry(
            fork,
            live ? "shown" : "branchInBin",
            true,
            live ? yield* placeIn(chatId, fork, slotId, true) : nowhere
          )
        )
      }
      // Forks whose own deletion of it a purge ends: this item's, and other items over the same text.
      const holders = yield* sql<{ fork_id: string }>`
        SELECT DISTINCT origin_json ->> '$.forkId' AS fork_id FROM bin_items
        WHERE user_id = ${userId} AND chat_id = ${chatId} AND origin_json ->> '$.forkId' IS NOT NULL
          AND (id = ${item.id} OR (kind = 'message' AND target_id = ${slotId})
            OR (${item.kind} = 'message' AND kind = 'version' AND origin_json ->> '$.slotId' = ${slotId})
            OR (${item.kind} = 'version' AND kind = 'version' AND target_id = ${item.target_id}))`
      const holding = new Set(holders.map((h) => h.fork_id))
      for (const fork of forks) {
        if (!holding.has(fork.id) || named.has(fork.id)) continue
        named.add(fork.id)
        const live = fork.deleted_at === null
        branches.push(
          yield* entry(
            fork,
            live ? "deletedHere" : "branchInBin",
            false,
            live ? yield* placeIn(chatId, fork, slotId, false) : nowhere
          )
        )
      }
      // The live branches that show it first, then those it's in the bin for, then the deleted ones.
      const rank = { shown: 0, deletedHere: 1, branchInBin: 2, chatInBin: 3 }
      branches.splice(start, Infinity, ...branches.slice(start).sort((a, b) => rank[a.state] - rank[b.state]))
    }
    return branches
  })
