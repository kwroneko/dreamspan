import { chatAllows } from "./chatKindPolicy.ts"
// Merging another chat into this one (spec/CHAT-MERGE.md; owner decisions DESIGN §3.3,
// 2026-11-05). `mergePlan` computes what a merge brings, for the preview (a reader) and the
// write (the writer, again inside its transaction), so the write merges exactly what was
// previewed or refuses with the new preview.
import { createHash } from "node:crypto"
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { awayAt } from "@dreamspan/shared/knowledge.ts"
import {
  fillMergeTemplate,
  MERGE_JOIN_DEFAULT,
  MERGE_SECTION_DEFAULT,
  MergeChanged,
  MergedMessage,
  MergeInfo,
  ChatMergePreview,
  MergeRefused,
  type MergeRequest,
  type MergeTimelines,
  type MergeView
} from "@dreamspan/shared/mergeApi.ts"
import { type FoldableEvent, foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { viewedJoin } from "../assembler/mergeKnowledge.ts"
import { identitiesOf } from "../assembler/knowledge.ts"
import { leftOutNote, mergedRowText, summaryRowName } from "../assembler/merges.ts"
import { estimateTokens } from "../assembler/st.ts"
import type { Bin } from "./bin.ts"
import { loadCards } from "./cards.ts"
import {
  displayEnd,
  displayLength,
  displaySlots,
  pathPieces,
  type PathPiece,
  positionOf,
  slotAtPosition,
  slotPlace
} from "./displayPath.ts"
import { inFork, shownIn, slotDeletedIn, writeInsert } from "./forkState.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { readKnowers } from "./knowers.ts"
import { insertCopiedNote, mergeNotes, type NoteToBring } from "./mergeNotes.ts"
import { MergeResult, NotFound, StaleWrite, type ReadOps, type WriteOps } from "./ops.ts"
import { castAt } from "./participation.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"
import { threadCastAt } from "./threadReads.ts"
import { joinSplit } from "./threads.ts"
import { query, transaction } from "./tx.ts"

/** The budget's bounds (spec §3): a short span still lets something through; a long one has a ceiling. */
const MERGE_BUDGET_MIN = 4_000
const MERGE_BUDGET_MAX = 50_000

interface ForkRow {
  readonly id: string
  readonly chat_id: string
  readonly tip_slot_id: string | null
  readonly name: string | null
}

interface SourceRow {
  readonly id: string
  readonly version_id: string
  readonly position: number
  readonly deleted: number
  readonly excluded: number
  readonly status: string
  readonly speaker_entity_id: string | null
  readonly content: string
  readonly created_at: number
  readonly first_writer: string
  readonly first_origin: string
  readonly origin: string
  readonly cast_json: string | null
  readonly presence_json: string | null
  /** The version's image media ids, as a JSON array; null when it has none. */
  readonly media: string | null
}

/** One merged source message or summary, as `chat_merge_messages` keeps it. */
interface MergedRow {
  readonly kind: "message" | "summary"
  readonly sourceSlotId: string | null
  /** The version copied (a message's); null for a summary. */
  readonly sourceVersionId: string | null
  /** The copied version's image media ids; null when it had none. */
  readonly media: ReadonlyArray<string> | null
  readonly speaker: string | null
  /** Who knew it in the source (spec/CHARACTER-CONTEXT.md §9.1); null: the whole source cast. */
  readonly knowers: ReadonlyArray<string> | null
  readonly name: string
  readonly side: "user" | "assistant"
  readonly content: string
  readonly sentAt: number
  readonly included: "verbatim" | "summarized" | "left_out"
  /** Where it was in the source (zero-based display positions): a message's own, a summary's range. */
  readonly sourceFrom: number
  readonly sourceTo: number
}

interface MergePlan {
  readonly preview: ChatMergePreview
  readonly fork: ForkRow
  readonly at: { readonly id: string; readonly depth: number }
  /** The join is appended: the merge position is the fork's tip and nothing shows after it. */
  readonly append: boolean
  readonly sourceChatId: string
  readonly sourceForkId: string
  readonly sourceEnd: string | null
  readonly base: string | null
  readonly start: string | null
  readonly stretchBefore: string | null
  readonly rows: ReadonlyArray<MergedRow>
  readonly transcript: string
  readonly union: ReadonlyArray<string>
  readonly destCast: ReadonlyArray<string>
  readonly sourceCast: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
  readonly castNames: ReadonlyArray<string>
  readonly counts: Record<string, number>
  /** The split whose other thread this joins (spec/THREADS.md §7); null for any other merge. */
  readonly splitId: string | null
  /**
   * The join's own view (`chat_merges.timelines`): as asked in a chat with one shared context,
   * where it decides; together otherwise, since separate contexts read every join by presence.
   */
  readonly timelines: MergeTimelines
  /** Characters away at the join that the joined thread brings back (an `away.set` false at J each). */
  readonly back: ReadonlyArray<string>
  /** Who the merged side is: the source's cast, or a joined thread's characters (not away there). */
  readonly sourceSide: ReadonlyArray<string>
  /** Another chat's notes it can bring (`ChatMergePreview.notes`); none for a branch or thread of this chat. */
  readonly notes: ReadonlyArray<NoteToBring>
  /** Destination characters with evidence of presence, rather than only an unplayed cast join. */
  readonly destReaders: ReadonlyArray<string>
}

/** The chat's state at `leaf` on `fork`'s path, its purged references left out. */
const eventsAt = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null, fork: string) =>
  Effect.gen(function* () {
    const rows = yield* stateEventsThrough(sql, chatId as ChatId, leaf as SlotId | null, fork)
    return yield* withoutPurged(
      sql,
      rows.map((e) => ({
        scope: e.scope,
        data: { key: e.key, value: JSON.parse(e.value_json) }
      })) as Array<FoldableEvent>
    )
  })

const stateAt = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null, fork: string) =>
  Effect.map(eventsAt(sql, chatId, leaf, fork), foldState)

const refused = (message: string) => new MergeRefused({ message })

/** "Mira", "Mira and Tobin", "Mira, Tobin and Wren". */
const nameList = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`

/**
 * A thread's name as the app shows it (the client's `threadName`): its own, else its characters
 * at S, else "Thread 2".
 */
const threadTitle = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  split: { readonly splitId: string; readonly ordinal: number }
) =>
  Effect.gen(function* () {
    const [member] = yield* sql<{ name: string | null; fork_id: string; slot_id: string }>`
      SELECT m.name, m.fork_id, x.slot_id FROM thread_members m JOIN thread_splits x ON x.id = m.split_id
      WHERE m.split_id = ${split.splitId} AND m.ordinal = ${split.ordinal}`
    if (member?.name?.trim()) return member.name.trim()
    const cast = member ? yield* threadCastAt(sql, chatId, member.fork_id, member.slot_id) : []
    const cards = new Map((yield* loadCards(sql, userId, cast)).map((c) => [c.card.entityId as string, c.card.name]))
    return nameList(cast.flatMap((id) => cards.get(id) ?? [])) || `Thread ${split.ordinal + 1}`
  })

/**
 * The positions two display paths share from the first message: the number of leading
 * positions holding the same slots. A run holds one slot per depth of its chain, so two runs
 * on one chain from the same depth agree as far as both go.
 */
export const sharedPrefix = (a: ReadonlyArray<PathPiece>, b: ReadonlyArray<PathPiece>) => {
  let i = 0
  let j = 0
  let pa: PathPiece | undefined = a[0]
  let pb: PathPiece | undefined = b[0]
  let shared = 0
  while (pa && pb) {
    if (pa.kind !== "run" || pb.kind !== "run") {
      if (pa.kind === "run" || pb.kind === "run" || pa.slotId !== pb.slotId) break
      shared++
      pa = a[++i]
      pb = b[++j]
      continue
    }
    if (pa.chainId !== pb.chainId || pa.lo !== pb.lo) break
    const la = pa.hi - pa.lo + 1
    const lb = pb.hi - pb.lo + 1
    const n = Math.min(la, lb)
    shared += n
    if (la === lb) {
      pa = a[++i]
      pb = b[++j]
    } else if (la < lb) {
      pb = { ...pb, lo: pb.lo + n, start: pb.start + n }
      pa = a[++i]
      // What follows the shorter run is another chain or an insertion: the paths part here.
      break
    } else {
      pa = { ...pa, lo: pa.lo + n, start: pa.start + n }
      pb = b[++j]
      break
    }
  }
  return shared
}

const ownedChat = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  Effect.flatMap(
    sql<{ id: string; title: string }>`SELECT id, title FROM chats
      WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`,
    ([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "chat", id: chatId })))
  )

const liveFork = (sql: SqlClient.SqlClient, chatId: string, forkId: string) =>
  Effect.flatMap(
    sql<ForkRow>`SELECT id, chat_id, tip_slot_id, name FROM forks
      WHERE id = ${forkId} AND chat_id = ${chatId} AND deleted_at IS NULL`,
    ([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "fork", id: forkId })))
  )

/** The messages of a fork's display path from `first` to `last`, as that fork shows them. */
const readStretch = (
  sql: SqlClient.SqlClient,
  fork: ForkRow,
  pieces: ReadonlyArray<PathPiece>,
  first: number,
  last: number
) =>
  first > last
    ? Effect.succeed([] as ReadonlyArray<SourceRow>)
    : sql<SourceRow>`
        ${displaySlots(sql, pieces, first, last)}
        SELECT s.id, v.id AS version_id, path.position, ${slotDeletedIn(sql, fork.id, "s")} AS deleted,
          ${contextExcludedIn(sql, fork.id)} AS excluded, v.status, v.speaker_entity_id, v.content,
          v.created_at, f.writer AS first_writer, f.origin AS first_origin, v.origin, v.cast_json, v.presence_json,
          (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_group_array(a.media_id) END
            FROM (SELECT media_id FROM version_attachments WHERE version_id = v.id ORDER BY ordinal) a) AS media
        FROM display_slots path JOIN slots s ON s.id = path.id
        JOIN version_records v ON v.id = ${shownIn(sql, fork.id, "s")}
        JOIN versions f ON f.id = (SELECT id FROM versions x WHERE x.slot_id = s.id ORDER BY x.ordinal LIMIT 1)
        WHERE s.chat_id = ${fork.chat_id}
        ORDER BY path.position`

const usable = (row: SourceRow) =>
  row.deleted === 0 &&
  row.excluded === 0 &&
  row.status !== "failed" &&
  row.status !== "generating" &&
  row.content.trim() !== ""

const sideOf = (row: SourceRow): "user" | "assistant" =>
  row.first_writer === "human" && row.first_origin !== "greeting" ? "user" : "assistant"

/** What a merge of `request.source` into `request.forkId` below `request.at` brings (spec §3). */
const mergePlan = (sql: SqlClient.SqlClient, userId: UserId, request: MergeRequest) =>
  Effect.gen(function* () {
    yield* ownedChat(sql, userId, request.chatId)
    const fork = yield* liveFork(sql, request.chatId, request.forkId)
    const sourceChat = yield* ownedChat(sql, userId, request.source.chatId)
    const source = yield* liveFork(sql, request.source.chatId, request.source.forkId)
    if (
      !(yield* chatAllows(sql, request.chatId, "allowsMerge")) ||
      !(yield* chatAllows(sql, request.source.chatId, "allowsMerge"))
    )
      return yield* refused("This chat kind does not support merging.")
    if (source.id === fork.id) return yield* refused("A branch can't be merged into itself.")

    // The destination: its display path, and the merge position on it.
    const pieces = yield* pathPieces(sql, request.chatId, fork.id, fork.tip_slot_id)
    const end = displayEnd(pieces, fork.tip_slot_id)
    const atId = request.at ?? end
    if (atId === null) return yield* refused("This chat has no messages to merge after yet.")
    const place = yield* slotPlace(sql, request.chatId, atId)
    const atPos = place === null ? null : positionOf(pieces, place)
    const [at] = yield* sql<{ id: string; depth: number; row_version: number; deleted: number }>`
      SELECT s.id, s.depth, s.row_version, ${slotDeletedIn(sql, fork.id, "s")} AS deleted
      FROM slots s WHERE s.id = ${atId} AND s.chat_id = ${request.chatId}`
    if (atPos === null || !at || at.deleted !== 0)
      return yield* new StaleWrite({ entity: "slot", id: atId, expected: 0, actual: at?.row_version ?? 0 })

    // The source: its display path, and what it shares with the destination through M.
    const sourcePieces = yield* pathPieces(sql, source.chat_id, source.id, source.tip_slot_id)
    const sourceEnd = displayEnd(sourcePieces, source.tip_slot_id)
    const sourceLength = displayLength(sourcePieces)
    const sameChat = source.chat_id === request.chatId
    let shared = sameChat ? Math.min(sharedPrefix(pieces, sourcePieces), atPos + 1) : 0
    // Shared slots may show different swipes, amend copies or visibility in these forks.
    // Stop at the first effective difference, even while the structural paths still agree.
    if (shared > 0) {
      const [different] = yield* sql<{ position: number }>`
        ${displaySlots(sql, pieces, 0, shared - 1)}
        SELECT path.position FROM display_slots path JOIN slots s ON s.id = path.id
        WHERE ${shownIn(sql, fork.id, "s")} IS NOT ${shownIn(sql, source.id, "s")}
          OR ${slotDeletedIn(sql, fork.id, "s")} <> ${slotDeletedIn(sql, source.id, "s")}
          OR ${contextExcludedIn(sql, fork.id)} <> ${contextExcludedIn(sql, source.id)}
        ORDER BY path.position LIMIT 1`
      if (different) shared = different.position
    }
    let basePos = shared - 1
    // Merged before: only what's new since the latest earlier merge of this source fork on the
    // destination's path up to M, whose pinned tip the source still shows.
    let previousJoin = -1
    for (const row of yield* sql<{ slot_id: string; source_tip_slot_id: string | null }>`
      SELECT slot_id, source_tip_slot_id FROM chat_merges WHERE chat_id = ${request.chatId}
        AND source_fork_id = ${source.id}`) {
      const joinPlace = yield* slotPlace(sql, request.chatId, row.slot_id)
      const joinPos = joinPlace === null ? null : positionOf(pieces, joinPlace)
      if (joinPos === null || joinPos > atPos) continue
      const [deleted] = yield* sql<{ d: number }>`SELECT ${slotDeletedIn(sql, fork.id, "s")} AS d
        FROM slots s WHERE s.id = ${row.slot_id}`
      if (deleted?.d) continue
      const tipPlace =
        row.source_tip_slot_id === null ? null : yield* slotPlace(sql, source.chat_id, row.source_tip_slot_id)
      const tipPos = tipPlace === null ? null : positionOf(sourcePieces, tipPlace)
      if (tipPos === null) continue
      basePos = Math.max(basePos, tipPos)
      previousJoin = Math.max(previousJoin, joinPos)
    }
    const continues = previousJoin >= 0
    const first = basePos + 1
    // A join (spec/THREADS.md §7): the source is another thread of this branch, called by its name.
    const split = sameChat ? yield* joinSplit(sql, request.chatId, fork, source) : null
    const splitId = split?.splitId ?? null
    const title =
      split !== null
        ? yield* threadTitle(sql, userId, request.chatId, split)
        : source.name?.trim() || sourceChat.title.trim() || "Untitled chat"
    if (first > sourceLength - 1)
      return yield* refused(
        split !== null
          ? continues
            ? `Nothing new in “${title}” since it was last joined.`
            : `“${title}” has nothing since the threads parted.`
          : continues
            ? `Nothing new in “${title}” since it was last merged.`
            : `“${title}” has no messages after the part it shares with this chat.`
      )
    const base = basePos >= 0 ? yield* slotAtPosition(sql, sourcePieces, basePos) : null

    // The parallel span: the destination's own messages beside the merged part.
    const spanFrom = continues
      ? previousJoin + 1
      : sameChat && shared > 0
        ? shared
        : request.start == null
          ? atPos
          : yield* Effect.gen(function* () {
              const startPlace = yield* slotPlace(sql, request.chatId, request.start!)
              const startPos = startPlace === null ? null : positionOf(pieces, startPlace)
              if (startPos === null || startPos > atPos)
                return yield* new StaleWrite({ entity: "slot", id: request.start!, expected: 0, actual: 0 })
              return startPos
            })
    const span = (yield* readStretch(sql, fork, pieces, spanFrom, atPos)).filter(usable)
    const startRow = span[0] ?? null
    const spanTokens = span.reduce((n, row) => n + estimateTokens(row.content), 0)
    const budget = Math.min(MERGE_BUDGET_MAX, Math.max(MERGE_BUDGET_MIN, spanTokens))

    // The post-base part, newest first into the budget; the rest from the source's summaries.
    const read = yield* readStretch(sql, source, sourcePieces, first, sourceLength - 1)
    const nested = read.filter((row) => row.first_origin === "merge" && usable(row)).length
    const messages = read.filter((row) => usable(row) && row.first_origin !== "merge")
    const sourceCast = yield* castAt(sql, source.chat_id, sourceEnd, source.id)
    // Freeze what this source branch knew, including its played-stretch corrections.
    const knowers = new Map(
      (yield* readKnowers(
        sql,
        source.chat_id,
        sql`1`,
        messages.map((m) => m.version_id),
        null,
        source.id
      )).map((row) => [
        row.versionId,
        row.knowers ?? (row.away?.length ? sourceCast.filter((id) => !row.away!.includes(id)) : null)
      ])
    )
    const knownBy = (row: SourceRow) => knowers.get(row.version_id) ?? null
    const speakers = [...new Set(messages.flatMap((row) => (row.speaker_entity_id ? [row.speaker_entity_id] : [])))]
    const cards = new Map(
      (yield* loadCards(sql, userId, speakers as Array<EntityId>)).map((c) => [c.card.entityId as string, c.card])
    )
    const nameOf = (row: SourceRow) => {
      const card = row.speaker_entity_id ? cards.get(row.speaker_entity_id) : undefined
      return card?.modelName || card?.name || (sideOf(row) === "user" ? "User" : "Narrator")
    }
    const line = (row: SourceRow) => mergedRowText({ kind: "message", name: nameOf(row), content: row.content })
    let used = 0
    let verbatimFrom = messages.length
    while (verbatimFrom > 0) {
      const cost = estimateTokens(line(messages[verbatimFrom - 1]!)) + 1
      if (used + cost > budget) break
      used += cost
      verbatimFrom--
    }
    const verbatimPos = messages[verbatimFrom]?.position ?? sourceLength
    const layer =
      verbatimFrom > 0
        ? yield* selectSummaryLayer(sql, userId, source.chat_id, sourceEnd).pipe(
            inFork(sql, source.chat_id, source.id, sourceEnd)
          )
        : null
    const summaries = (layer?.summaries ?? [])
      // Summary ranges are one-based; all merge positions are zero-based.
      .map((s) => ({ ...s, from: s.from - 1, to: s.to - 1 }))
      .filter((s) => s.from > basePos && s.to < verbatimPos && s.content.trim() !== "")
      .toSorted((a, b) => a.from - b.from)
    const covered = (position: number) => summaries.some((s) => s.from <= position && position <= s.to)
    const rows: Array<MergedRow> = []
    const blocks: Array<string> = []
    let leftOut = 0
    let leftOutTokens = 0
    let summarized = 0
    let nextSummary = 0
    for (const [i, row] of messages.entries()) {
      while (nextSummary < summaries.length && summaries[nextSummary]!.from <= row.position) {
        const s = summaries[nextSummary++]!
        const name = summaryRowName(s.from + 1, s.to + 1)
        blocks.push(mergedRowText({ kind: "summary", name, content: s.content }))
        rows.push({
          kind: "summary",
          sourceSlotId: s.lastSlotId,
          sourceVersionId: null,
          media: null,
          speaker: null,
          // A frozen summary must retain who knew all its inputs, even after its source is gone.
          // Stale inputs cannot be verified against the current source path.
          knowers:
            s.fresh && !read.some((m) => m.first_origin === "merge" && s.from <= m.position && m.position <= s.to)
              ? messages
                  .filter((m) => s.from <= m.position && m.position <= s.to)
                  .reduce<ReadonlyArray<string> | null>((all, m) => {
                    const known = knownBy(m)
                    return known === null ? all : all === null ? known : all.filter((id) => known.includes(id))
                  }, null)
              : [],
          name,
          side: "assistant",
          content: s.content.trim(),
          sentAt: 0,
          included: "verbatim",
          sourceFrom: s.from,
          sourceTo: s.to
        })
      }
      const verbatim = i >= verbatimFrom
      const inSummary = !verbatim && covered(row.position)
      const kept = verbatim || (!inSummary && request.includeLeftOut)
      if (!verbatim && inSummary) summarized++
      if (!verbatim && !inSummary) {
        leftOut++
        leftOutTokens += estimateTokens(line(row))
      }
      if (kept) blocks.push(line(row))
      rows.push({
        kind: "message",
        sourceSlotId: row.id,
        sourceVersionId: row.version_id,
        media: row.media === null ? null : (JSON.parse(row.media) as Array<string>),
        speaker: row.speaker_entity_id,
        knowers: knownBy(row),
        name: nameOf(row),
        side: sideOf(row),
        content: row.content,
        sentAt: row.created_at,
        included: kept ? "verbatim" : inSummary ? "summarized" : "left_out",
        sourceFrom: row.position,
        sourceTo: row.position
      })
    }
    const notes = [
      ...(leftOut && !request.includeLeftOut ? [leftOutNote(leftOut, title)] : []),
      ...(nested ? [`[${nested} ${nested === 1 ? "chat" : "chats"} merged into “${title}” not included.]`] : [])
    ]
    const transcript = [...notes, ...blocks].join("\n\n")

    // The cast: the union of both at the merge point (DESIGN §3.3 [D]).
    const destEvents = yield* eventsAt(sql, request.chatId, atId, fork.id)
    const destState = foldState(destEvents)
    const destCast = destState.participants
    const identities = identitiesOf(destEvents)
    // A source character silently added to this cast has not read this chat yet. Presence
    // comes from retained authored versions on this path, including previous card identities,
    // never from the current cast alone. An unselected swipe still records participation.
    const candidates = sameChat ? [] : sourceCast.filter((id) => destCast.includes(id))
    const evidence = [...new Set(candidates.flatMap((id) => identities.get(id) ?? [id]))]
    const present = evidence.length
      ? new Set(
          (yield* sql<{ entity: string }>`
          ${displaySlots(sql, pieces, 0, atPos)}
          SELECT DISTINCT p.entity_id AS entity FROM display_slots path
          JOIN slots s ON s.id = path.id
          JOIN versions v ON v.slot_id = s.id AND v.purged_at IS NULL
          JOIN version_participants p ON p.version_id = v.id
          WHERE v.origin <> 'merge' AND v.status <> 'generating' AND v.status <> 'failed'
            AND p.entity_id IN ${sql.in(evidence)}`).map((r) => r.entity)
        )
      : new Set<string>()
    const destReaders = destCast.filter(
      (id) => !candidates.includes(id) || (identities.get(id) ?? [id]).some((alias) => present.has(alias))
    )
    const union = [...new Set([...destCast, ...sourceCast])]
    const added = sourceCast.filter((id) => !destCast.includes(id))
    const castCards = new Map(
      (yield* loadCards(sql, userId, union as Array<EntityId>)).map((c) => [c.card.entityId as string, c.card])
    )
    // A join's characters away here are back from the join on, and the templates name only those in it.
    const sourceAway = splitId === null ? [] : awayAt(yield* stateAt(sql, source.chat_id, sourceEnd, source.id))
    const inThread = sourceCast.filter((id) => !sourceAway.includes(id))
    const destAway = awayAt(destState)
    const back = splitId === null ? [] : inThread.filter((id) => destAway.includes(id))
    const named = splitId === null ? sourceCast : inThread
    const castNames = named.map((id) => castCards.get(id)?.modelName || castCards.get(id)?.name || "someone")
    // How the characters read it (spec/THREADS.md §7.3): as asked in a chat with one shared
    // context (together by default); a chat with separate contexts reads it separately, whatever
    // the join records, and the join records its own choice only (together there), so a chat
    // switched to one shared context later reads such a join whole.
    const choosesTimelines = (destState.contextPerSpeaker ?? "shared") === "shared"
    const chosen: MergeTimelines = choosesTimelines ? (request.timelines ?? "together") : "together"
    const timelines: MergeTimelines = choosesTimelines ? chosen : "separate"
    // With separate timelines, what each character reads of it, as assembly filters it: the
    // rows it knew, those read with the source's cast where none was recorded.
    const views: Array<MergeView> = []
    if (timelines === "separate") {
      const assembled = rows
        .filter((r) => r.included !== "summarized")
        .map((r, ordinal) => ({
          ordinal,
          kind: r.kind,
          name: r.name,
          side: r.side,
          speaker: r.speaker,
          content: r.included === "verbatim" ? r.content : "",
          included: r.included === "verbatim" ? ("verbatim" as const) : ("left_out" as const),
          knowers: r.knowers ?? sourceCast
        }))
      for (const id of union) {
        if (destState.roles[id] === "narrator" || destState.playedByMe.includes(id)) continue
        const seen = viewedJoin(transcript, title, assembled, (knowers) => knowers.includes(id))
        views.push({
          entity: id as EntityId,
          name: castCards.get(id)?.name ?? "Unknown",
          section: seen.rows.length === 0 && seen.partial ? "" : seen.content,
          readable: !(seen.rows.length === 0 && seen.partial),
          // Another chat kept separate: which chat's past the character keeps (db/threadStretches.ts).
          ...(splitId === null && choosesTimelines
            ? { from: destReaders.includes(id) ? (sourceCast.includes(id) ? "both" : "here") : "merged" }
            : {})
        } satisfies MergeView)
      }
    }

    // A summary covering M in the destination is written again over the join (MESSAGE-INSERT §3.4).
    const append = atId === fork.tip_slot_id && end === fork.tip_slot_id
    const destLayer = append
      ? null
      : yield* selectSummaryLayer(sql, userId, request.chatId, end).pipe(inFork(sql, request.chatId, fork.id, end))
    const covering = destLayer?.summaries.find((s) => s.from <= atPos + 1 && atPos + 1 < s.to) ?? null

    // Another chat's notes, each brought only when ticked (spec §6; db/mergeNotes.ts).
    const bringable =
      sameChat || splitId !== null
        ? null
        : yield* mergeNotes(
            sql,
            userId,
            { chatId: source.chat_id, forkId: source.id, end: sourceEnd },
            { chatId: request.chatId, forkId: fork.id, at: atId },
            sourceCast
          )

    const counts = {
      messages: messages.length,
      verbatim: rows.filter((r) => r.kind === "message" && r.included === "verbatim").length,
      summarized,
      summaries: summaries.length,
      leftOut: request.includeLeftOut ? 0 : leftOut,
      tokens: estimateTokens(transcript)
    }
    const previewFields = {
      sourceTitle: title,
      sameChat,
      shared: Math.max(0, shared),
      continues,
      from: first + 1,
      messages: messages.length,
      verbatim: counts.verbatim,
      summarized,
      summaries: summaries.length,
      leftOut,
      leftOutTokens,
      tokens: counts.tokens,
      budget,
      spanTokens,
      at: { slotId: atId as SlotId, number: atPos + 1 },
      start: startRow ? { slotId: startRow.id as SlotId, number: startRow.position + 1 } : null,
      cast: union.map((id) => {
        const card = castCards.get(id)
        return {
          entity: id as EntityId,
          name: card?.name ?? "Unknown",
          avatarMediaId: card?.avatarMediaId ?? null,
          added: added.includes(id)
        }
      }),
      castNames,
      framing: fillMergeTemplate(MERGE_SECTION_DEFAULT, title, castNames),
      section: transcript,
      join: fillMergeTemplate(MERGE_JOIN_DEFAULT, title, castNames),
      rewrites: covering ? { from: covering.from, to: covering.to, tokens: covering.tokens } : null,
      timelines,
      ...(choosesTimelines ? { choosesTimelines } : {}),
      ...(splitId === null ? {} : { thread: true, back: back as Array<EntityId> }),
      ...(timelines === "separate" ? { views } : {}),
      ...(bringable === null ? {} : { notes: bringable.map((note) => note.entry) })
    }
    // Hash the actual preview and frozen rows, including full texts and speaker names.
    // Text length alone misses same-length edits and swipes made while the dialog is open.
    const digest = createHash("sha256")
      // The request field by field, whatever order its keys came in, with the position as
      // resolved: a join below an earlier one of the same write previews the same.
      .update(
        JSON.stringify([
          [request.chatId, request.forkId, atId, request.source.chatId, request.source.forkId],
          [request.start === undefined ? "absent" : request.start, request.includeLeftOut, chosen, timelines],
          source.tip_slot_id,
          sourceEnd,
          previewFields,
          bringable,
          rows
        ])
      )
      .digest("base64url")
    const preview = new ChatMergePreview({ ...previewFields, digest })
    return {
      preview,
      fork,
      at,
      append,
      sourceChatId: source.chat_id,
      sourceForkId: source.id,
      sourceEnd,
      base,
      start: startRow?.id ?? null,
      // Kept separate, another chat's characters lived none of this chat before the join: its
      // stretch is the whole path (null), whatever span the layout reads beside it. A branch of
      // this chat shares the part before the span (db/threadStretches.ts).
      stretchBefore: sameChat && spanFrom > 0 ? yield* slotAtPosition(sql, pieces, spanFrom - 1) : null,
      rows,
      transcript,
      union,
      destCast,
      destReaders,
      sourceCast,
      added,
      castNames,
      counts,
      splitId,
      timelines: chosen,
      back,
      sourceSide: named,
      notes: bringable ?? []
    } satisfies MergePlan
  })

/** The merge whose join is `slotId`, read for the timeline. */
const mergeInfo = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, slotId: string) =>
  Effect.gen(function* () {
    yield* ownedChat(sql, userId, chatId)
    const [row] = yield* sql<{
      id: string
      slot_id: string
      title: string
      source_chat_id: string | null
      source_fork_id: string | null
      live: number
      cast_json: string
      counts_json: string
      created_at: number
      split_id: string | null
    }>`SELECT m.*, EXISTS (SELECT 1 FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE f.id = m.source_fork_id AND f.chat_id = m.source_chat_id AND f.deleted_at IS NULL
          AND c.deleted_at IS NULL AND c.owner_user_id = ${userId}) AS live
      FROM chat_merges m WHERE m.chat_id = ${chatId} AND m.slot_id = ${slotId}`
    if (!row) return yield* new NotFound({ entity: "merge", id: slotId })
    const counts = JSON.parse(row.counts_json) as Record<string, number>
    return new MergeInfo({
      id: row.id,
      slotId: row.slot_id as SlotId,
      title: row.title,
      sourceChatId: row.live ? (row.source_chat_id as ChatId) : null,
      sourceForkId: row.live ? (row.source_fork_id as ForkId) : null,
      sourceLive: row.live === 1,
      messages: counts.messages ?? 0,
      verbatim: counts.verbatim ?? 0,
      summarized: counts.summarized ?? 0,
      leftOut: counts.leftOut ?? 0,
      cast: (JSON.parse(row.cast_json) as Array<{ name: string; from: string }>)
        .filter((c) => c.from !== "destination")
        .map((c) => c.name),
      createdAt: row.created_at,
      ...(row.split_id === null ? {} : { thread: true })
    })
  })

type ReadHandlers = Parameters<typeof ReadOps.of>[0]
type WriteHandlers = Parameters<typeof WriteOps.of>[0]

export const makeMergeReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    PreviewChatMerge: ({ userId, ...request }) =>
      Effect.map(mergePlan(sql, userId, request), (plan) => plan.preview).pipe(query("PreviewChatMerge")),
    GetMerge: ({ userId, chatId, slotId }) => mergeInfo(sql, userId, chatId, slotId).pipe(query("GetMerge")),
    MergeMessages: ({ userId, chatId, mergeId, offset, limit }) =>
      Effect.gen(function* () {
        yield* ownedChat(sql, userId, chatId)
        const rows = yield* sql<{
          ordinal: number
          kind: "message" | "summary"
          speaker_entity_id: string | null
          speaker_name: string
          side: "user" | "assistant"
          content: string
          sent_at: number
          included: "verbatim" | "summarized" | "left_out"
        }>`SELECT mm.* FROM chat_merge_messages mm JOIN chat_merges m ON m.id = mm.merge_id
          WHERE m.id = ${mergeId} AND m.chat_id = ${chatId} AND mm.ordinal >= ${offset}
          ORDER BY mm.ordinal LIMIT ${Math.min(200, Math.max(1, limit))}`
        return rows.map((r): MergedMessage => ({
          ordinal: r.ordinal,
          kind: r.kind,
          speakerEntityId: r.speaker_entity_id as EntityId | null,
          speakerName: r.speaker_name,
          side: r.side,
          content: r.content,
          sentAt: r.sent_at,
          included: r.included
        }))
      }).pipe(query("MergeMessages"))
  } satisfies Partial<ReadHandlers>
})

export const makeMergeWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)

    /**
     * Writes a planned merge's join below `parent` (appended when `append`, else inserted), its
     * row and frozen rows, the cast union's joins and, for a join of another thread, its
     * characters back from J on. Inside the caller's transaction; returns the join's slot.
     */
    const writeMerge = (
      userId: UserId,
      plan: MergePlan,
      title: string,
      framing: string | null,
      parent: { readonly id: string; readonly depth: number },
      append: boolean,
      now: number,
      bring: ReadonlyArray<NoteToBring> = []
    ) =>
      Effect.gen(function* () {
        const chatId = plan.fork.chat_id
        const version = new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: plan.transcript,
          status: "complete",
          macroMode: "verbatim",
          origin: "merge"
        })
        const { slotId, version: row } = yield* graph.insertSlot(
          chatId,
          parent,
          version,
          now,
          plan.fork.id,
          [],
          0,
          !append
        )
        if (append)
          yield* sql`UPDATE forks SET tip_slot_id = ${slotId}, row_version = row_version + 1 WHERE id = ${plan.fork.id}`
        else yield* writeInsert(sql, { id: plan.fork.id, chatId }, slotId, 1)
        // The join pins the union: the merged-in characters took part (DESIGN §3.5).
        yield* sql`UPDATE version_records SET cast_json = ${JSON.stringify(plan.union)} WHERE id = ${row.id}`
        for (const entity of plan.added)
          yield* graph.insertStateEvent(
            userId,
            chatId,
            slotId,
            null,
            null,
            { key: "participant.join", value: { entity: entity as EntityId } },
            plan.fork.id
          )
        // A joined thread's characters are here again from the join on (spec/THREADS.md §7.1).
        for (const entity of plan.back)
          yield* graph.insertStateEvent(
            userId,
            chatId,
            slotId,
            null,
            null,
            { key: "away.set", value: { entity: entity as EntityId, away: false } },
            plan.fork.id
          )
        // The ticked notes, on from the join: a chat note as this chat's new copy, a card's
        // note itself (its moved-passage partner switched with it, graphWrites.ts).
        for (const note of bring) {
          for (const binding of note.bindings)
            yield* graph.insertStateEvent(
              userId,
              chatId,
              slotId,
              null,
              null,
              { key: "note.binding", value: { note: binding.note, revision: binding.revision } },
              plan.fork.id
            )
          const entity = note.copy === null ? note.entry.id : yield* insertCopiedNote(sql, userId, note.copy, now)
          yield* graph.insertStateEvent(
            userId,
            chatId,
            slotId,
            null,
            null,
            { key: "note.activate", value: { note: entity as EntityId } },
            plan.fork.id
          )
        }
        const mergeId = uuidv7()
        const inDestination = new Set(plan.destReaders)
        const inSource = new Set(plan.sourceSide)
        yield* sql`INSERT INTO chat_merges ${sql.insert({
          id: mergeId,
          chat_id: chatId,
          slot_id: slotId,
          fork_id: plan.fork.id,
          source_chat_id: plan.sourceChatId,
          source_fork_id: plan.sourceForkId,
          source_tip_slot_id: plan.sourceEnd,
          base_slot_id: plan.base,
          start_slot_id: plan.start,
          title: title.trim().slice(0, 200) || plan.preview.sourceTitle,
          framing: framing?.trim() ? framing.trim().slice(0, 2_000) : null,
          cast_json: JSON.stringify(
            plan.preview.cast.map((c) => ({
              entity: c.entity,
              name: c.name,
              from: inSource.has(c.entity) ? (inDestination.has(c.entity) ? "both" : "source") : "destination"
            }))
          ),
          counts_json: JSON.stringify(plan.counts),
          created_at: now,
          timelines: plan.timelines,
          split_id: plan.splitId,
          stretch_before_slot_id: plan.timelines === "separate" ? plan.stretchBefore : null
        })}`
        for (let i = 0; i < plan.rows.length; i += 200)
          yield* sql`INSERT INTO chat_merge_messages ${sql.insert(
            plan.rows.slice(i, i + 200).map((r, n) => ({
              merge_id: mergeId,
              ordinal: i + n,
              kind: r.kind,
              source_slot_id: r.sourceSlotId,
              source_version_id: r.sourceVersionId,
              media_json: r.media === null ? null : JSON.stringify(r.media),
              speaker_entity_id: r.speaker,
              knowers_json: r.knowers === null ? null : JSON.stringify(r.knowers),
              speaker_name: r.name,
              side: r.side,
              content: r.content,
              sent_at: r.sentAt,
              included: r.included,
              source_from: r.sourceFrom,
              source_to: r.sourceTo
            }))
          )}`
        return slotId
      })

    /** After the joins: the fork chatted in, the chat's row, and each join's position now. */
    const finish = (forkId: string, chatId: string, slots: ReadonlyArray<string>, now: number) =>
      Effect.gen(function* () {
        // Merging adds a message: the fork is chatted in (ARCHITECTURE §3.8).
        yield* graph.chatIn(forkId, now)
        const [chat] = yield* sql<ChatRow>`
          UPDATE chats SET last_message_at = ${now}, row_version = row_version + 1
          WHERE id = ${chatId} RETURNING *`
        const [tip] = yield* sql<{ tip: string | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${forkId}`
        const pieces = yield* pathPieces(sql, chatId, forkId, tip!.tip)
        const results: Array<MergeResult> = []
        for (const slotId of slots)
          results.push(
            new MergeResult({
              slotId: slotId as SlotId,
              forkId: forkId as ForkId,
              position: positionOf(pieces, (yield* slotPlace(sql, chatId, slotId))!)!,
              chat: toChat(chat!)
            })
          )
        return results
      })

    /**
     * Writes each of `joins` as previewed, all planned at `request.at` and each below the one
     * before (several threads joined at once are consecutive J's, spec/THREADS.md §7.1). With
     * `threads`, every source must be another thread of this branch.
     */
    const merged = (
      userId: UserId,
      request: Omit<MergeRequest, "source">,
      joins: ReadonlyArray<{
        readonly source: MergeRequest["source"]
        readonly title: string
        readonly framing: string | null
        readonly digest: string
      }>,
      threads: boolean
    ) =>
      Effect.gen(function* () {
        const now = Date.now()
        if (new Set(joins.map((join) => `${join.source.chatId}/${join.source.forkId}`)).size !== joins.length)
          return yield* refused("Each thread can be joined once at a time.")
        const slots: Array<string> = []
        let at: SlotId | null = request.at
        let place: { parent: { id: string; depth: number }; append: boolean } | null = null
        for (const join of joins) {
          const plan = yield* mergePlan(sql, userId, { ...request, at, source: join.source })
          if (plan.preview.digest !== join.digest) return yield* new MergeChanged({ preview: plan.preview })
          if (threads && plan.splitId === null)
            return yield* refused(`“${plan.preview.sourceTitle}” isn't another thread of this branch.`)
          const bring: Array<NoteToBring> = []
          for (const id of new Set(request.notes ?? [])) {
            const note = plan.notes.find((one) => one.entry.id === id)
            if (!note)
              return yield* refused("A note to bring isn't in the merged chat any more. Review the merge again.")
            if (note.entry.conflict !== null) return yield* refused(note.entry.conflict)
            bring.push(note)
          }
          at = plan.at.id as SlotId
          const target: { parent: { id: string; depth: number }; append: boolean } = place ?? {
            parent: plan.at,
            append: plan.append
          }
          const slotId: string = yield* writeMerge(
            userId,
            plan,
            join.title,
            join.framing,
            target.parent,
            target.append,
            now,
            bring
          )
          slots.push(slotId)
          place = { parent: { id: slotId, depth: target.parent.depth + 1 }, append: target.append }
        }
        return yield* finish(request.forkId, request.chatId, slots, now)
      })

    return {
      MergeChat: ({ userId, title, framing, digest, ...request }) =>
        Effect.map(
          merged(userId, request, [{ source: request.source, title, framing, digest }], false),
          (results) => results[0]!
        ).pipe(transaction(sql, "MergeChat")),
      JoinThreads: ({ userId, joins, ...request }) =>
        merged(
          userId,
          request,
          joins.map(({ forkId, ...join }) => ({ source: { chatId: request.chatId, forkId }, ...join })),
          true
        ).pipe(transaction(sql, "JoinThreads"))
    } satisfies Partial<WriteHandlers>
  })
