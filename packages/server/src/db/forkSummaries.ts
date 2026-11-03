// What the shell shows of each fork (ARCHITECTURE.md §12, `ShellLibrary`): its endpoint's
// excerpt, its visible message count, who joined and left and who last spoke, from a walk of
// its display path with its state folded along it. The walk costs the fork's path, so its
// results are kept per fork in `fork_summaries`, valid while its `stamp` is the chat's
// `shell_stamp` and its `user_stamp` the owner's `shell_user_stamps` row: triggers move those
// on every write the walk reads (db/baseline.ts), and the writer moves a summary's `stamp` on
// with its chat's when the write couldn't reach it (db/summaryValidity.ts). Only entity ids
// are kept: names, avatars and the fork's display name are the read's, so a card's rename or
// bin never invalidates one.
// Readers and the writer (at the end of an ST chat import) share the computation.
import type { EntityId } from "@rp/shared/chat.ts"
import { branchOwned, foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { pathPieces } from "./displayPath.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import type { ForkRow } from "./rows.ts"
import { shellEventsQuery, shellPlainForksQuery, shellSlotsQuery, shellTreeQuery } from "./shellQueries.ts"
import { withoutPurged } from "./stateRefs.ts"
import { settleSummaries } from "./summaryValidity.ts"
import { slotHumanAuthorsSql, slotParticipantsSql } from "./participation.ts"

/** Bumped whenever the computation changes, so summaries stored by an older build are recomputed. */
// Recompute rows that predate retained-swipe invalidation and human-author activity.
export const FORK_SUMMARY_FORMAT = 4

/**
 * What the shell shows of a fork: ids only, the cast with every card, binned or not, and the
 * time of its last shown message (`endAt`, null without one).
 */
export interface ForkSummary {
  readonly forkId: string
  readonly chatId: string
  readonly preview: string
  readonly messages: number
  readonly leaf: string | null
  readonly endAt: number | null
  /**
   * Where it parts from the fork it was made from (owner, 2026-11-01): `at`, its first own
   * message's time, else its making; `after`, how many shown messages it shares before it.
   * Null for a chat's first fork, and one whose parent and base are gone.
   */
  readonly split: { readonly at: number; readonly after: number } | null
  readonly cast: ReadonlyArray<string>
  readonly joined: ReadonlyArray<string>
  readonly departed: ReadonlyArray<string>
  readonly activity: ReadonlyArray<{
    readonly entityId: string
    readonly at: number
    readonly slot: string
    readonly category: "just" | "with" | "was"
  }>
}

type Slot = {
  fork_id: string
  id: string
  chat_id: string
  parent_slot_id: string | null
  created_at: number
  deleted_at: number | null
  speaker: string | null
  at: number
  depth: number
  preview: string
  participants: string
  human_authors: string
}
type Event = FoldableEvent & { fork_id: string; chat_id: string; slot_id: string | null }

/** The stamps a summary of a fork of `chatId` is valid at, read before anything they guard. */
export const summaryStamps = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(
    sql<{ stamp: number }>`SELECT stamp FROM shell_user_stamps WHERE user_id = ${userId}`,
    ([row]) => row?.stamp ?? 0
  )

/**
 * The summaries of `records`, live forks of live chats, from one read of their paths' slots
 * and their events (`shellSlotsQuery`, `shellEventsQuery`, by fork id). Iterative, so deep
 * imported paths need no recursion.
 */
export const computeForkSummaries = (sql: SqlClient.SqlClient, records: ReadonlyArray<ForkRow>, pathsOnly = false) =>
  Effect.gen(function* () {
    if (records.length === 0) return []
    const chatIds = JSON.stringify([...new Set(records.map((r) => r.chat_id))])
    // Where a fork splits off reads its parent's path, so a live parent not in `records` is
    // walked too (its path only: it gets no summary here).
    const recordIds = new Set(records.map((r) => r.id))
    const parentIds = new Set(records.flatMap((r) => (r.parent_fork_id === null ? [] : [r.parent_fork_id])))
    const others = [...parentIds].filter((id) => !recordIds.has(id))
    const walked: ReadonlyArray<Pick<ForkRow, "id" | "chat_id" | "tip_slot_id">> = [
      ...records,
      ...(others.length === 0
        ? []
        : yield* sql<Pick<ForkRow, "id" | "chat_id" | "tip_slot_id">>`SELECT f.id, f.chat_id, f.tip_slot_id
            FROM json_each(${JSON.stringify(others)}) j CROSS JOIN forks f ON f.id = j.value WHERE f.deleted_at IS NULL`)
    ]
    // Many plain forks share one tree read. A small import refresh must read only its
    // paths: reading the whole growing tree at every new branch is quadratic.
    const plain = new Set(
      pathsOnly
        ? []
        : (yield* sql.unsafe<{ id: string }>(shellPlainForksQuery, [JSON.stringify(walked.map((r) => r.id))])).map(
            (row) => row.id
          )
    )
    const own = walked.filter((r) => !plain.has(r.id))
    const treeChats = [...new Set(walked.flatMap((r) => (plain.has(r.id) ? [r.chat_id] : [])))]
    const slots =
      own.length === 0 ? [] : yield* sql.unsafe<Slot>(shellSlotsQuery, [JSON.stringify(own.map((r) => r.id))])
    const trees = new Map<string, Map<string, Slot>>()
    if (treeChats.length > 0)
      for (const slot of yield* sql.unsafe<Slot>(shellTreeQuery, [JSON.stringify(treeChats)])) {
        const tree = trees.get(slot.chat_id) ?? new Map<string, Slot>()
        tree.set(slot.id, slot)
        trees.set(slot.chat_id, tree)
      }
    const forkIds = JSON.stringify(records.map((r) => r.id))
    const insertionChats = new Set(
      (yield* sql<{ chat_id: string }>`SELECT DISTINCT o.chat_id FROM json_each(${chatIds}) j
        CROSS JOIN fork_overrides o ON o.chat_id = j.value AND o.kind = 'insert'`).map((row) => row.chat_id)
    )
    const raw = yield* sql.unsafe<{
      fork_id: string
      chat_id: string
      slot_id: string | null
      scope: string
      key: string
      value_json: string
    }>(shellEventsQuery, [forkIds])
    const events = (yield* withoutPurged(
      sql,
      raw.map((e) => ({ ...e, data: { key: e.key, value: JSON.parse(e.value_json) } })) as Array<Event>,
      (event) => event.fork_id
    )) as ReadonlyArray<Event>
    const eventsByFork = new Map<string, Array<Event>>()
    for (const event of events) {
      const list = eventsByFork.get(event.fork_id) ?? []
      list.push(event)
      eventsByFork.set(event.fork_id, list)
    }
    const slotsByFork = new Map<string, Map<string, Slot>>()
    for (const slot of slots) {
      const map = slotsByFork.get(slot.fork_id) ?? new Map<string, Slot>()
      map.set(slot.id, slot)
      slotsByFork.set(slot.fork_id, map)
    }
    /** A fork's structural path, root first. Iterative, including an interior checkpoint and every same-tip peer. */
    const structural = (fork: Pick<ForkRow, "id" | "chat_id" | "tip_slot_id">) => {
      const map = plain.has(fork.id) ? trees.get(fork.chat_id) : slotsByFork.get(fork.id)
      const path: Array<Slot> = []
      let slot = map?.get(fork.tip_slot_id ?? "")
      while (slot) {
        path.push(slot)
        const parent = map?.get(slot.parent_slot_id ?? "")
        slot = parent && parent.depth < slot.depth ? parent : undefined
      }
      return path.reverse()
    }
    // Each live parent's path, as ids; none for a parent with no slots (as for one gone).
    const parentPaths = new Map<string, ReadonlySet<string>>()
    for (const fork of walked) {
      if (!parentIds.has(fork.id)) continue
      const ids = new Set(structural(fork).map((s) => s.id))
      if (ids.size > 0) parentPaths.set(fork.id, ids)
    }
    const summaries: Array<ForkSummary> = []
    for (const record of records) {
      let path = structural(record)
      const base = record.base_slot_id === null ? undefined : path.find((s) => s.id === record.base_slot_id)
      if (insertionChats.has(record.chat_id)) {
        const pieces = yield* pathPieces(sql, record.chat_id, record.id, record.tip_slot_id)
        const ids = pieces.flatMap((piece) => (piece.kind === "inserted" ? [piece.slotId] : []))
        const inserted =
          ids.length === 0
            ? []
            : yield* sql<Slot>`
              SELECT ${record.id} AS fork_id, s.id, s.chat_id, s.parent_slot_id, s.created_at, s.depth,
                CASE WHEN ${slotDeletedIn(sql, record.id, "s")} THEN 1 END AS deleted_at,
                v.speaker_entity_id AS speaker, substr(v.content, 1, 160) AS preview,
                ${sql.literal(slotParticipantsSql("s"))} AS participants,
                ${sql.literal(slotHumanAuthorsSql("s"))} AS human_authors,
                CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END AS at
              FROM slots s JOIN versions v ON v.id = ${shownIn(sql, record.id, "s")}
              WHERE ${sql.in("s.id", ids)}`
        const byId = new Map(inserted.map((slot) => [slot.id, slot]))
        const shown: Array<Slot> = []
        let structural = 0
        // `path` is already this fork's structural path, with one slot per depth.
        // Consume its runs once and splice the single inserted pieces between them.
        for (const piece of pieces) {
          if (piece.kind === "inserted") {
            const slot = byId.get(piece.slotId)
            if (slot) shown.push(slot)
          } else {
            while (structural < path.length && path[structural]!.depth <= piece.hi) shown.push(path[structural++]!)
          }
        }
        path = shown
      }
      const onPath = new Set(path.map((s) => s.id))
      const applicable = (eventsByFork.get(record.id) ?? []).filter((e) => e.slot_id === null || onPath.has(e.slot_id))
      const branch = applicable.filter((e) => branchOwned.has(e.data.key))
      const positional = new Map<string, Array<Event>>()
      for (const e of applicable) {
        if (branchOwned.has(e.data.key)) continue
        const key = e.slot_id ?? ""
        const list = positional.get(key) ?? []
        list.push(e)
        positional.set(key, list)
      }
      let state = foldState(positional.get("") ?? [])
      const joined = new Set<string>()
      const activity = new Map<string, { entityId: EntityId; at: number; slot: string }>()
      let endpoint: Slot | undefined
      let messages = 0
      // What it shares: its parent's path while that's live, else the history up to its base.
      const parent = record.parent_fork_id === null ? undefined : parentPaths.get(record.parent_fork_id)
      const baseDepth = base?.depth
      const shared =
        record.parent_fork_id === null
          ? null
          : parent !== undefined
            ? (s: Slot) => parent.has(s.id)
            : baseDepth !== undefined
              ? (s: Slot) => s.depth <= baseDepth
              : null
      let split: ForkSummary["split"] = null
      for (const s of path) {
        // Every retained swipe at this position counts, even one no longer selected.
        // Cast events at the endpoint describe the next turn, never the preceding one.
        for (const id of JSON.parse(s.participants) as Array<string>) joined.add(id)
        if (s.deleted_at !== null) continue
        if (shared !== null && split === null && !shared(s)) split = { at: s.created_at, after: messages }
        messages++
        endpoint = s
        state = foldState(positional.get(s.id) ?? [], state)
        const record = (entity: string, at: number) => {
          if (at >= (activity.get(entity)?.at ?? -Infinity))
            activity.set(entity, { entityId: entity as EntityId, at, slot: s.id })
        }
        if (s.speaker !== null) record(s.speaker, s.at)
        for (const author of JSON.parse(s.human_authors) as Array<{ entity: string; at: number }>)
          record(author.entity, author.at)
      }
      state = foldState(branch, state)
      const present = state.participants.filter((id) => !state.playedByMe.includes(id) && !state.absent.includes(id))
      summaries.push({
        forkId: record.id,
        chatId: record.chat_id,
        preview: endpoint?.preview ?? "",
        messages,
        leaf: endpoint?.id ?? null,
        endAt: endpoint?.at ?? null,
        split: shared === null ? null : (split ?? { at: record.created_at, after: messages }),
        // Every card, binned or not: the read keeps those it can show.
        cast: state.participants.filter((id) => !state.playedByMe.includes(id)),
        joined: [...joined],
        departed: [...joined].filter((id) => !state.participants.includes(id)),
        activity: [...activity.values()].map((a) => ({
          ...a,
          category: !state.participants.includes(a.entityId)
            ? ("was" as const)
            : present.some((id) => id !== a.entityId)
              ? ("with" as const)
              : ("just" as const)
        }))
      })
    }
    return summaries
  })

/**
 * Where each of chat `chatId`'s live forks `records` parts from its parent and when its last
 * message is, for a read: the stored summaries while they're all valid, else computed now (a
 * reader stores nothing; the shell's next read stores them).
 */
export const chatForkSummaries = (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  records: ReadonlyArray<ForkRow>
) =>
  Effect.gen(function* () {
    const userStamp = yield* summaryStamps(sql, userId)
    const stored = yield* sql<{
      fork_id: string
      end_at: number | null
      split_at: number | null
      split_after: number | null
    }>`SELECT s.fork_id, s.end_at, s.split_at, s.split_after FROM fork_summaries s JOIN chats c ON c.id = s.chat_id
      WHERE s.chat_id = ${chatId} AND s.format = ${FORK_SUMMARY_FORMAT} AND s.stamp = c.shell_stamp
        AND s.user_stamp = ${userStamp}`
    const byFork = new Map<string, Pick<ForkSummary, "endAt" | "split">>(
      stored.map((row) => [
        row.fork_id,
        {
          endAt: row.end_at,
          split: row.split_at === null || row.split_after === null ? null : { at: row.split_at, after: row.split_after }
        }
      ])
    )
    if (records.every((record) => byFork.has(record.id))) return byFork
    return new Map<string, Pick<ForkSummary, "endAt" | "split">>(
      (yield* computeForkSummaries(sql, records)).map((s) => [s.forkId, { endAt: s.endAt, split: s.split }])
    )
  })

/** A chat's summaries as a read computed them, with the stamps it read (`ChatSummariesAt` in ops.ts). */
export interface ChatSummaries {
  readonly chatId: string
  readonly stamp: number
  readonly userStamp: number
  /** The JSON of its `ForkSummary`s. */
  readonly forks: string
}

/**
 * Stores each chat's summaries if the chat's and its owner's stamps are still the ones they were
 * computed at: a write since then may have made them stale, and the next read computes them
 * again. Replaces those forks' rows only: the chat's others are valid or not on their own. A
 * fork no longer live keeps its row, which no read shows; deleting the fork deletes it. Two
 * statements, however many chats: one finds the current ones, one inserts from the JSON.
 */
export const storeSummaries = (sql: SqlClient.SqlClient, userId: string, chats: ReadonlyArray<ChatSummaries>) =>
  Effect.gen(function* () {
    if (chats.length === 0) return
    const claims = JSON.stringify(chats.map((c) => [c.chatId, c.stamp, c.userStamp]))
    const current = new Set(
      (yield* sql<{ id: string }>`SELECT c.id FROM json_each(${claims}) j CROSS JOIN chats c ON c.id = j.value ->> 0
        WHERE c.owner_user_id = ${userId} AND c.shell_stamp = j.value ->> 1
          AND coalesce((SELECT stamp FROM shell_user_stamps WHERE user_id = ${userId}), 0) = j.value ->> 2`).map(
        (row) => row.id
      )
    )
    const kept = chats.filter((c) => current.has(c.chatId))
    if (kept.length === 0) return
    const rows = `[${kept.map((c) => `[${JSON.stringify(c.chatId)},${c.stamp},${c.userStamp},${c.forks}]`).join(",")}]`
    yield* sql`INSERT OR REPLACE INTO fork_summaries (fork_id, chat_id, format, stamp, user_stamp, preview, messages,
        leaf, end_at, split_at, split_after, cast_json, joined_json, departed_json, activity_json)
      SELECT f.id, f.chat_id, ${FORK_SUMMARY_FORMAT}, c.value ->> 1, c.value ->> 2, s.value ->> 'preview',
        s.value ->> 'messages', s.value ->> 'leaf', s.value ->> 'endAt', s.value ->> '$.split.at',
        s.value ->> '$.split.after', s.value -> 'cast', s.value -> 'joined',
        s.value -> 'departed', s.value -> 'activity'
      FROM json_each(${rows}) c CROSS JOIN json_each(c.value, '$[3]') s
      CROSS JOIN forks f ON f.id = s.value ->> 'forkId' AND f.chat_id = c.value ->> 0`
  })

/**
 * In the writer, at the end of a write: computes and stores the summaries of chat `chatId`'s
 * live forks that its writes left stale, at its stamps as they now stand, so the next read
 * needn't (an ST import finishing a chat, which nobody may read until the whole import is done).
 * The ones the writes couldn't reach stay valid (`settleSummaries`), so finishing one branch
 * file of a chat with hundreds walks that branch.
 */
export const refreshChatSummaries = (sql: SqlClient.SqlClient, userId: string, chatId: string) =>
  Effect.gen(function* () {
    yield* settleSummaries(sql)
    const [chat] = yield* sql<{ shell_stamp: number }>`SELECT shell_stamp FROM chats
      WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
    if (chat === undefined) return
    const userStamp = yield* summaryStamps(sql, userId)
    const records = yield* sql<ForkRow>`SELECT f.* FROM forks f LEFT JOIN fork_summaries s ON s.fork_id = f.id
      WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL AND (s.fork_id IS NULL OR s.format <> ${FORK_SUMMARY_FORMAT}
        OR s.stamp <> ${chat.shell_stamp} OR s.user_stamp <> ${userStamp})`
    if (records.length === 0) return
    const forks = yield* computeForkSummaries(sql, records, records.length <= 2)
    yield* storeSummaries(sql, userId, [{ chatId, stamp: chat.shell_stamp, userStamp, forks: JSON.stringify(forks) }])
  })
