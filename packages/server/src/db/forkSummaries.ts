// What the shell shows of each fork (ARCHITECTURE.md §12, `ShellLibrary`): its endpoint's
// excerpt, its visible message count, who joined and left and who last spoke, from a walk of
// its display path with its state folded along it. The walk costs the chat's messages, so its
// results are kept per fork in `fork_summaries`, valid while the chat's `shell_stamp` and the
// owner's `shell_user_stamps` row are what they were when it was computed: triggers move them
// on every write the walk reads (db/baseline.ts). Only entity ids are kept: names, avatars and
// the fork's display name are the read's, so a card's rename or bin never invalidates one.
// Readers and the writer (at the end of an ST chat import) share the computation.
import type { EntityId } from "@rp/shared/chat.ts"
import { branchOwned, foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { pathPieces } from "./displayPath.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import type { ForkRow } from "./rows.ts"
import { shellEventsQuery, shellSlotsQuery } from "./shellQueries.ts"
import { withoutPurged } from "./stateRefs.ts"

/** Bumped whenever the computation changes, so summaries stored by an older build are recomputed. */
export const FORK_SUMMARY_FORMAT = 1

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
}
type Event = FoldableEvent & { fork_id: string; chat_id: string; slot_id: string | null }

/** The stamps a summary of a fork of `chatId` is valid at, read before anything they guard. */
export const summaryStamps = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(
    sql<{ stamp: number }>`SELECT stamp FROM shell_user_stamps WHERE user_id = ${userId}`,
    ([row]) => row?.stamp ?? 0
  )

/**
 * The summaries of `records`, live forks of live chats, from one read of their chats' slots
 * and events (`shellSlotsQuery`, `shellEventsQuery`, by chat id). Iterative, so deep imported
 * paths need no recursion.
 */
export const computeForkSummaries = (sql: SqlClient.SqlClient, records: ReadonlyArray<ForkRow>) =>
  Effect.gen(function* () {
    if (records.length === 0) return []
    const chatIds = JSON.stringify([...new Set(records.map((r) => r.chat_id))])
    const wanted = new Set(records.map((r) => r.id))
    const slots = yield* sql.unsafe<Slot>(shellSlotsQuery, [chatIds])
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
    }>(shellEventsQuery, [chatIds])
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
    const summaries: Array<ForkSummary> = []
    for (const record of records) {
      if (!wanted.has(record.id)) continue
      const map = slotsByFork.get(record.id)
      // Iterative, including an interior checkpoint and every same-tip peer.
      let path: Array<Slot> = []
      let slot = map?.get(record.tip_slot_id ?? "")
      while (slot) {
        path.push(slot)
        const parent = map?.get(slot.parent_slot_id ?? "")
        slot = parent && parent.depth < slot.depth ? parent : undefined
      }
      path.reverse()
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
      const joined = new Set([
        ...state.participants,
        ...foldState(branch, state).participants,
        ...applicable.flatMap(({ data }) =>
          data.key === "participant.join" || data.key === "card.swap" ? [data.value.entity] : []
        )
      ])
      const activity = new Map<string, { entityId: EntityId; at: number; slot: string }>()
      let endpoint: Slot | undefined
      let messages = 0
      for (const s of path) {
        if (s.deleted_at !== null) continue
        messages++
        endpoint = s
        state = foldState(positional.get(s.id) ?? [], state)
        let here = state
        // Existing turns retain their authors across card swaps. Keep the played
        // identities at each step, including intermediate cards in a swap chain.
        let playedByMe = s.speaker !== null && here.playedByMe.includes(s.speaker)
        for (const event of branch) {
          here = foldState([event], here)
          playedByMe ||= s.speaker !== null && here.playedByMe.includes(s.speaker)
        }
        for (const id of here.participants) joined.add(id)
        if (s.speaker !== null && !playedByMe)
          activity.set(s.speaker, { entityId: s.speaker as EntityId, at: s.at, slot: s.id })
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
 * computed at: a write since then made them stale, and the next read computes them again. Replaces
 * what each such chat had, so rows of forks no longer live go too. Three statements, however many
 * chats: one finds the current ones, one clears them, one inserts from the JSON.
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
    yield* sql`DELETE FROM fork_summaries WHERE fork_id IN (
      SELECT f.id FROM json_each(${JSON.stringify(kept.map((c) => c.chatId))}) j CROSS JOIN forks f ON f.chat_id = j.value)`
    const rows = `[${kept.map((c) => `[${JSON.stringify(c.chatId)},${c.stamp},${c.userStamp},${c.forks}]`).join(",")}]`
    yield* sql`INSERT OR REPLACE INTO fork_summaries (fork_id, chat_id, format, stamp, user_stamp, preview, messages,
        leaf, end_at, cast_json, joined_json, departed_json, activity_json)
      SELECT f.id, f.chat_id, ${FORK_SUMMARY_FORMAT}, c.value ->> 1, c.value ->> 2, s.value ->> 'preview',
        s.value ->> 'messages', s.value ->> 'leaf', s.value ->> 'endAt', s.value -> 'cast', s.value -> 'joined',
        s.value -> 'departed', s.value -> 'activity'
      FROM json_each(${rows}) c CROSS JOIN json_each(c.value, '$[3]') s
      CROSS JOIN forks f ON f.id = s.value ->> 'forkId' AND f.chat_id = c.value ->> 0`
  })

/**
 * In the writer, at the end of a write: computes and stores the summaries of chat `chatId`'s
 * live forks at its stamps as they now stand, so the next read needn't (an ST import finishing
 * a chat, which nobody may read until the whole import is done).
 */
export const refreshChatSummaries = (sql: SqlClient.SqlClient, userId: string, chatId: string) =>
  Effect.gen(function* () {
    const [chat] = yield* sql<{ shell_stamp: number }>`SELECT shell_stamp FROM chats
      WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
    if (chat === undefined) return
    const records = yield* sql<ForkRow>`SELECT * FROM forks WHERE chat_id = ${chatId} AND deleted_at IS NULL`
    const forks = yield* computeForkSummaries(sql, records)
    yield* storeSummaries(sql, userId, [
      { chatId, stamp: chat.shell_stamp, userStamp: yield* summaryStamps(sql, userId), forks: JSON.stringify(forks) }
    ])
  })
