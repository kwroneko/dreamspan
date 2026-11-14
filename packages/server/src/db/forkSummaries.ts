// What the shell shows of each fork (ARCHITECTURE.md §12, `ShellLibrary`): its endpoint's
// excerpt, its visible message count, who joined and left and who last spoke, from a walk of
// its display path with its state folded along it. The walk costs the fork's path, so its
// results are kept per fork in `fork_summaries`, with the chat's `shell_stamp` it was computed
// at (`stamp`) and the owner's `shell_user_stamps` row (`user_stamp`). Triggers move those on
// every write the walk reads (db/baseline.ts); the writer notes which forks each write reaches,
// moving their `fork_shell_stamps` row to the chat's new stamp (db/summaryValidity.ts). A summary
// is valid while its stamp is at least its fork's, its user stamp the owner's, and the writer
// noted every move of the chat's stamp (`summaryValidSql`): a write reaching one fork leaves
// the chat's others valid, and a summary computed while another fork was written stays storable.
// Only entity ids are kept: names, avatars and the fork's display name are the read's, so a
// card's rename or bin never invalidates one.
// Readers and the writer (at the end of an ST chat import) share the computation.
import type { EntityId } from "@rp/shared/chat.ts"
import { branchOwned, foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"
import { pathPieces } from "./displayPath.ts"
import { shownIn, slotDeletedIn } from "./forkState.ts"
import type { ForkRow } from "./rows.ts"
import { makePathResolver, type PathResolver } from "./forkPaths.ts"

export { makePathResolver, type PathResolver }
import { shellEventsQuery, shellSlotsQuery, shellOutlineSlotsQuery } from "./shellQueries.ts"
import { withoutPurged } from "./stateRefs.ts"
import { FORK_SUMMARY_FORMAT, settleSummaries, summaryValidSql } from "./summaryValidity.ts"
import { slotHumanAuthorsSql, slotParticipantsSql } from "./participation.ts"
import { placesOf, threadCandidates } from "./threads.ts"
import { ActiveStateModules } from "./stateModules.ts"
import type { ThreadPlace } from "@rp/shared/threads.ts"

export { FORK_SUMMARY_FORMAT, summaryValidSql }

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
  readonly added: ReadonlyArray<string>
  readonly joined: ReadonlyArray<string>
  readonly departed: ReadonlyArray<string>
  readonly activity: ReadonlyArray<{
    readonly entityId: string
    readonly at: number
    readonly slot: string
    readonly category: "just" | "with" | "was"
  }>
  /** The thread sets it's in, innermost first (db/threads.ts), whether shown or not. */
  readonly threads: ReadonlyArray<ThreadPlace>
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
  version_seq: number
  content_length: number
  status: string
  participants: string
  human_authors: string
}
type Event = FoldableEvent & { fork_id: string; source_fork_id: string | null; chat_id: string; slot_id: string | null }

/** The stamps a summary of a fork of `chatId` is valid at, read before anything they guard. */
export const summaryStamps = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(
    sql<{ stamp: number }>`SELECT stamp FROM shell_user_stamps WHERE user_id = ${userId}`,
    ([row]) => row?.stamp ?? 0
  )

/** Up to this many forks of one chat are walked by their paths alone (unless its tree is held). */
const PATHS_ALONE = 8

/**
 * The summaries of `records`, live forks of live chats, from their paths' slots and their
 * events. A few forks (`pathsOnly`, an import refresh) read just their paths
 * (`shellSlotsQuery`, `shellEventsQuery`, by fork id); otherwise a chat with more than
 * `PATHS_ALONE` of them, or whose tree `resolver` holds, has its tree and events read once and
 * every fork's path resolved in it (db/forkPaths.ts), in batches, and the other chats' forks
 * read their paths. Iterative, so deep imported paths need no recursion.
 */
const computeSummaries = (
  sql: SqlClient.SqlClient,
  records: ReadonlyArray<ForkRow>,
  pathsOnly = records.length <= 2,
  evidence = true,
  resolver?: PathResolver
): Effect.Effect<Array<ForkSummary>, SqlError.SqlError> =>
  Effect.gen(function* () {
    if (records.length === 0) return []
    // Plain branches share Slot objects. Decode their immutable evidence once,
    // rather than once for every branch which retains that prefix.
    const participants = new WeakMap<Slot, ReadonlyArray<string>>()
    const authors = new WeakMap<Slot, ReadonlyArray<{ readonly entity: string; readonly at: number }>>()
    const emptyParticipants: ReadonlyArray<string> = []
    const emptyAuthors: ReadonlyArray<{ readonly entity: string; readonly at: number }> = []
    const participantsOf = (slot: Slot) => {
      if (slot.participants === "[]") return emptyParticipants
      let decoded = participants.get(slot)
      if (decoded === undefined) {
        decoded = JSON.parse(slot.participants) as Array<string>
        participants.set(slot, decoded)
      }
      return decoded
    }
    const authorsOf = (slot: Slot) => {
      if (slot.human_authors === "[]") return emptyAuthors
      let decoded = authors.get(slot)
      if (decoded === undefined) {
        decoded = JSON.parse(slot.human_authors) as Array<{ entity: string; at: number }>
        authors.set(slot, decoded)
      }
      return decoded
    }
    // A batch holds its forks' and their parents' paths at once: dense overrides make each a
    // row per position, and hundreds of long paths at once exhausted the reader heap.
    const batchSize = 16
    if (!pathsOnly) {
      const shared = resolver ?? makePathResolver(sql, evidence)
      // A chat's forks together, so its tree and events are read once.
      const ordered = [...records].sort((a, b) => (a.chat_id < b.chat_id ? -1 : a.chat_id > b.chat_id ? 1 : 0))
      const perChat = new Map<string, number>()
      for (const record of ordered) perChat.set(record.chat_id, (perChat.get(record.chat_id) ?? 0) + 1)
      // A chat with few of these forks whose tree isn't held reads just their paths: on chats of
      // 5,000 messages, reading the tree cost as much as walking 8 to 32 forks' paths alone.
      const alone = (record: ForkRow) => perChat.get(record.chat_id)! <= PATHS_ALONE && !shared.holds(record.chat_id)
      const summaries: Array<ForkSummary> = []
      for (const [batch, viaTree] of [
        [ordered.filter(alone), false],
        [ordered.filter((record) => !alone(record)), true]
      ] as const)
        for (let at = 0; at < batch.length; at += batchSize)
          summaries.push(
            ...(yield* computeSummaries(
              sql,
              batch.slice(at, at + batchSize),
              true,
              evidence,
              viaTree ? shared : undefined
            ))
          )
      const position = new Map(ordered.map((record, i) => [record.id, i]))
      return summaries.sort((a, b) => position.get(a.forkId)! - position.get(b.forkId)!)
    }
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
    const resolved = resolver === undefined ? undefined : yield* resolver.paths(walked)
    const slots =
      resolved !== undefined
        ? []
        : yield* sql.unsafe<Slot>(evidence ? shellSlotsQuery : shellOutlineSlotsQuery, [
            JSON.stringify(walked.map((r) => r.id))
          ])
    const insertionChats = new Set(
      (yield* sql<{ chat_id: string }>`SELECT DISTINCT o.chat_id FROM json_each(${chatIds}) j
        CROSS JOIN fork_overrides o ON o.chat_id = j.value AND o.kind = 'insert'`).map((row) => row.chat_id)
    )
    const raw =
      resolver !== undefined
        ? yield* resolver.events(records)
        : yield* sql.unsafe<{
            fork_id: string
            source_fork_id: string | null
            chat_id: string
            slot_id: string | null
            scope: string
            key: string
            value_json: string
          }>(shellEventsQuery, [JSON.stringify(records.map((r) => r.id))])
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
    const structural = (fork: Pick<ForkRow, "id" | "chat_id" | "tip_slot_id">): ReadonlyArray<Slot> => {
      const known = resolved?.get(fork.id)
      if (known) return known
      const map = slotsByFork.get(fork.id)
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
    // Which threads each is in: the splits its labels see, kept where its path holds S.
    const threadsSeen = yield* threadCandidates(
      sql,
      records.map((r) => r.id)
    )
    const summaries: Array<ForkSummary> = []
    const previewCandidates: Array<Array<number>> = []
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
                v.status, v.speaker_entity_id AS speaker, v.seq AS version_seq, v.content_length,
                ${sql.literal(evidence ? slotParticipantsSql("s") : "'[]'")} AS participants,
                ${sql.literal(evidence ? slotHumanAuthorsSql("s") : "'[]'")} AS human_authors,
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
      const candidatesSeen = threadsSeen.filter((place) => place.forkId === record.id)
      const ownEvents = eventsByFork.get(record.id) ?? []
      // Branch-wide events need no position lookup; most imported branches have
      // no positional events or thread sets. Avoid a whole-path map in that case.
      const onPath =
        candidatesSeen.length > 0 || ownEvents.some((e) => e.slot_id !== null)
          ? new Map(path.map((s, position) => [s.id, position]))
          : null
      const applicable =
        onPath === null ? ownEvents : ownEvents.filter((e) => e.slot_id === null || onPath.has(e.slot_id))
      // The child's bounded lineage retains the parent's cast as of the split. Own
      // events at the base (including branch-wide swaps) must not change that baseline.
      const baseIndex = record.base_slot_id === null ? -1 : path.findIndex((s) => s.id === record.base_slot_id)
      const before = applicable.some((e) => e.source_fork_id !== record.id && e.slot_id !== null)
        ? new Set(path.slice(0, baseIndex + 1).map((s) => s.id))
        : null
      const inherited = applicable.filter(
        (e) => e.source_fork_id !== record.id && (e.slot_id === null || before?.has(e.slot_id) === true)
      )
      const splitState = foldState([
        ...inherited.filter((e) => !branchOwned.has(e.data.key)),
        ...inherited.filter((e) => branchOwned.has(e.data.key))
      ])
      const added = new Set<string>()
      if (record.parent_fork_id !== null && (record.base_slot_id === null || baseIndex >= 0))
        for (const slot of path.slice(baseIndex + 1))
          for (const id of participantsOf(slot)) if (!splitState.participants.includes(id)) added.add(id)
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
      const lastSpoke = new Map<string, number>()
      let endpoint: Slot | undefined
      const candidates: Array<number> = []
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
        for (const id of participantsOf(s)) joined.add(id)
        if (s.deleted_at !== null) continue
        if (shared !== null && split === null && !shared(s)) split = { at: s.created_at, after: messages }
        messages++
        endpoint = s
        if (s.status !== "failed" && s.content_length > 0) candidates.push(s.version_seq)
        const changes = positional.get(s.id)
        if (changes !== undefined || state.playedByMe.length > 1) state = foldState(changes ?? [], state)
        const record = (entity: string, at: number) => {
          if (at >= (activity.get(entity)?.at ?? -Infinity))
            activity.set(entity, { entityId: entity as EntityId, at, slot: s.id })
        }
        if (s.speaker !== null) {
          record(s.speaker, s.at)
          lastSpoke.set(s.speaker, messages)
        }
        for (const author of authorsOf(s)) record(author.entity, author.at)
      }
      for (const event of branch) {
        const { data } = event
        if (
          data.key === "card.swap" &&
          data.value.entity !== data.value.replaces &&
          state.participants.includes(data.value.replaces)
        ) {
          const rank = lastSpoke.get(data.value.replaces)
          if (rank !== undefined) {
            lastSpoke.set(data.value.entity, Math.max(rank, lastSpoke.get(data.value.entity) ?? 0))
            lastSpoke.delete(data.value.replaces)
          }
        }
        state = foldState([event], state)
      }
      const present = state.participants.filter((id) => !state.playedByMe.includes(id) && !state.absent.includes(id))
      previewCandidates.push(candidates)
      summaries.push({
        forkId: record.id,
        chatId: record.chat_id,
        preview: "",
        messages,
        leaf: endpoint?.id ?? null,
        endAt: endpoint?.at ?? null,
        split: shared === null ? null : (split ?? { at: record.created_at, after: messages }),
        // Every card, binned or not: the read keeps those it can show.
        cast: state.participants
          .filter((id) => !state.playedByMe.includes(id))
          .sort((a, b) => (lastSpoke.get(b) ?? 0) - (lastSpoke.get(a) ?? 0)),
        added: [...added],
        joined: [...joined],
        departed: [...joined].filter((id) => !state.participants.includes(id)),
        activity: [...activity.values()].map((a) => ({
          ...a,
          category: !state.participants.includes(a.entityId)
            ? ("was" as const)
            : present.some((id) => id !== a.entityId)
              ? ("with" as const)
              : ("just" as const)
        })),
        threads:
          candidatesSeen.length === 0
            ? []
            : placesOf(candidatesSeen, record.id, (slotId) => onPath!.has(slotId), onPath!)
      })
    }
    // All history/participation above is metadata. Read only each fork's newest
    // candidate excerpt, sharing reads where forks select the same version. A
    // whitespace-only prefix falls back to the next candidate, exactly as before.
    const previews: Array<string> = summaries.map(() => "")
    const excerpts = new Map<number, string>()
    let pending = previewCandidates.flatMap((candidates, i) => (candidates.length ? [i] : []))
    while (pending.length > 0) {
      const unread = [...new Set(pending.map((i) => previewCandidates[i]!.at(-1)!))].filter((seq) => !excerpts.has(seq))
      if (unread.length > 0) {
        const read = yield* sql<{ version_seq: number; text: string }>`
          SELECT t.version_seq, substr(t.content, 1, 160) AS text FROM json_each(${JSON.stringify(unread)}) j
          CROSS JOIN version_texts t ON t.version_seq = j.value`
        for (const row of read) excerpts.set(row.version_seq, row.text)
      }
      const next: Array<number> = []
      for (const i of pending) {
        const text = excerpts.get(previewCandidates[i]!.pop()!) ?? ""
        if (text.trim()) previews[i] = text
        else if (previewCandidates[i]!.length > 0) next.push(i)
      }
      pending = next
    }
    return summaries.map((summary, i) => ({ ...summary, preview: previews[i]! }))
  })

/** Navigation needs cast ordering, endpoints and split/thread metadata, without swipe activity. */
export const computeForkOutlines = (sql: SqlClient.SqlClient, records: ReadonlyArray<ForkRow>) =>
  computeSummaries(sql, records, records.length <= 2, false)

/** Complete shell summaries, including every retained swipe's participation evidence. */
export const computeForkSummaries = (
  sql: SqlClient.SqlClient,
  records: ReadonlyArray<ForkRow>,
  pathsOnly = records.length <= 2,
  /** A resolver kept from an earlier read of the same chats at the same stamps (`makePathResolver`). */
  resolver?: PathResolver
) => computeSummaries(sql, records, pathsOnly, true, resolver)

/**
 * Where each of chat `chatId`'s live forks `records` parts from its parent and when its last
 * message is, for a read: the stored summaries where valid, computing only the stale forks now (a
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
    const stored =
      (yield* ActiveStateModules) !== ""
        ? []
        : yield* sql<{
            fork_id: string
            end_at: number | null
            split_at: number | null
            split_after: number | null
            preview: string
            threads_json: string
          }>`SELECT s.fork_id, s.end_at, s.split_at, s.split_after, s.preview, s.threads_json
      FROM fork_summaries s JOIN chats c ON c.id = s.chat_id
      WHERE s.chat_id = ${chatId} AND ${sql.literal(summaryValidSql("s", "c", String(userStamp)))}`
    const byFork = new Map<string, Pick<ForkSummary, "endAt" | "split" | "preview" | "threads">>(
      stored.map((row) => [
        row.fork_id,
        {
          endAt: row.end_at,
          preview: row.preview,
          split:
            row.split_at === null || row.split_after === null ? null : { at: row.split_at, after: row.split_after },
          threads: JSON.parse(row.threads_json) as ReadonlyArray<ThreadPlace>
        }
      ])
    )
    const missing = records.filter((record) => !byFork.has(record.id))
    // This read returns only previews, split markers and threads, never the shell's
    // cast/activity fields. Do not scan all alternatives to compute fields it discards.
    for (const s of yield* computeSummaries(sql, missing, missing.length <= 2, false))
      byFork.set(s.forkId, { endAt: s.endAt, split: s.split, preview: s.preview, threads: s.threads })

    return byFork
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
 * Stores each fork's summary still valid now: computed at a chat stamp no older than its fork's
 * (no write since reached it) and at its owner's stamp now. A write meanwhile that reached other
 * forks of the chat leaves it storable. A chat whose stamp moved without the writer noting it
 * (`chat_shell_tracked` behind) has every fork's stamp moved to the chat's now first, so only
 * summaries computed at that stamp are kept. Replaces those forks' rows only. A fork no longer
 * live keeps its row, which no read shows; deleting the fork deletes it. A few statements,
 * however many chats.
 */
export const storeSummaries = (sql: SqlClient.SqlClient, userId: string, chats: ReadonlyArray<ChatSummaries>) =>
  Effect.gen(function* () {
    // On-disk summaries describe core reducers. A scoped plugin fold must never
    // overwrite them and survive the plugin's disposal or another worker's read.
    if ((yield* ActiveStateModules) !== "") return
    if (chats.length === 0) return
    const userStamp = yield* summaryStamps(sql, userId)
    const kept = chats.filter((c) => c.userStamp === userStamp)
    if (kept.length === 0) return
    const claims = JSON.stringify(kept.map((c) => [c.chatId, c.stamp]))
    const untracked = (yield* sql<{ id: string; shell_stamp: number }>`SELECT c.id, c.shell_stamp
      FROM json_each(${claims}) j CROSS JOIN chats c ON c.id = j.value ->> 0
      WHERE c.owner_user_id = ${userId} AND c.shell_stamp = j.value ->> 1 AND c.shell_stamp IS NOT
        (SELECT stamp FROM chat_shell_tracked WHERE chat_id = c.id)`).map((row) => [row.id, row.shell_stamp])
    if (untracked.length > 0) {
      const moved = JSON.stringify(untracked)
      yield* sql`INSERT INTO fork_shell_stamps (fork_id, stamp)
        SELECT f.id, j.value ->> 1 FROM json_each(${moved}) j CROSS JOIN forks f ON f.chat_id = j.value ->> 0 WHERE 1
        ON CONFLICT (fork_id) DO UPDATE SET stamp = excluded.stamp`
      yield* sql`INSERT INTO chat_shell_tracked (chat_id, stamp) SELECT j.value ->> 0, j.value ->> 1 FROM json_each(${moved}) j
        WHERE 1 ON CONFLICT (chat_id) DO UPDATE SET stamp = excluded.stamp`
    }
    const rows = `[${kept.map((c) => `[${JSON.stringify(c.chatId)},${c.stamp},${c.userStamp},${c.forks}]`).join(",")}]`
    yield* sql`INSERT OR REPLACE INTO fork_summaries (fork_id, chat_id, format, stamp, user_stamp, preview, messages,
        leaf, end_at, split_at, split_after, cast_json, joined_json, departed_json, activity_json, added_json,
        threads_json)
      SELECT f.id, f.chat_id, ${FORK_SUMMARY_FORMAT}, c.value ->> 1, c.value ->> 2, s.value ->> 'preview',
        s.value ->> 'messages', s.value ->> 'leaf', s.value ->> 'endAt', s.value ->> '$.split.at',
        s.value ->> '$.split.after', s.value -> 'cast', s.value -> 'joined',
        s.value -> 'departed', s.value -> 'activity', s.value -> 'added', coalesce(s.value -> 'threads', '[]')
      FROM json_each(${rows}) c CROSS JOIN chats ch ON ch.id = c.value ->> 0 AND ch.owner_user_id = ${userId}
        AND (SELECT stamp FROM chat_shell_tracked WHERE chat_id = ch.id) = ch.shell_stamp
        AND c.value ->> 1 <= ch.shell_stamp
      CROSS JOIN json_each(c.value, '$[3]') s
      CROSS JOIN forks f ON f.id = s.value ->> 'forkId' AND f.chat_id = ch.id
      WHERE c.value ->> 1 >= coalesce((SELECT stamp FROM fork_shell_stamps WHERE fork_id = f.id), 0)`
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
    const records = yield* sql<ForkRow>`SELECT f.* FROM forks f JOIN chats c ON c.id = f.chat_id
      LEFT JOIN fork_summaries s ON s.fork_id = f.id
      WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
        AND (s.fork_id IS NULL OR NOT ${sql.literal(summaryValidSql("s", "c", String(userStamp)))})`
    if (records.length === 0) return
    const forks = yield* computeForkSummaries(sql, records, records.length <= 2)
    yield* storeSummaries(sql, userId, [{ chatId, stamp: chat.shell_stamp, userStamp, forks: JSON.stringify(forks) }])
  })
