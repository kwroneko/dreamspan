// Merging another chat into this one (spec/CHAT-MERGE.md; owner decisions DESIGN §3.3,
// 2026-11-05). `mergePlan` computes what a merge brings, for the preview (a reader) and the
// write (the writer, again inside its transaction), so the write merges exactly what was
// previewed or refuses with the new preview.
import { createHash } from "node:crypto"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { NewVersion } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import {
  fillMergeTemplate,
  MERGE_JOIN_DEFAULT,
  MERGE_SECTION_DEFAULT,
  MergeChanged,
  MergedMessage,
  MergeInfo,
  ChatMergePreview,
  MergeRefused,
  type MergeRequest
} from "@rp/shared/mergeApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
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
import { MergeResult, NotFound, StaleWrite, type ReadOps, type WriteOps } from "./ops.ts"
import { castAt } from "./participation.ts"
import { type ChatRow, toChat } from "./rows.ts"
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
}

/** One merged source message or summary, as `chat_merge_messages` keeps it. */
interface MergedRow {
  readonly kind: "message" | "summary"
  readonly sourceSlotId: string | null
  readonly speaker: string | null
  readonly name: string
  readonly side: "user" | "assistant"
  readonly content: string
  readonly sentAt: number
  readonly included: "verbatim" | "summarized" | "left_out"
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
  readonly rows: ReadonlyArray<MergedRow>
  readonly transcript: string
  readonly union: ReadonlyArray<string>
  readonly destCast: ReadonlyArray<string>
  readonly sourceCast: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
  readonly castNames: ReadonlyArray<string>
  readonly counts: Record<string, number>
}

const refused = (message: string) => new MergeRefused({ message })

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
    if (pa.kind === "inserted" || pb.kind === "inserted") {
      if (pa.kind !== "inserted" || pb.kind !== "inserted" || pa.slotId !== pb.slotId) break
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
        SELECT s.id, path.position, ${slotDeletedIn(sql, fork.id, "s")} AS deleted,
          ${contextExcludedIn(sql, fork.id)} AS excluded, v.status, v.speaker_entity_id, v.content,
          v.created_at, f.writer AS first_writer, f.origin AS first_origin, v.origin
        FROM display_slots path JOIN slots s ON s.id = path.id
        JOIN versions v ON v.id = ${shownIn(sql, fork.id, "s")}
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

const summaryText = (from: number, to: number, content: string) =>
  `<summary from="${from}" to="${to}">\n${content}\n</summary>`

/** What a merge of `request.source` into `request.forkId` below `request.at` brings (spec §3). */
const mergePlan = (sql: SqlClient.SqlClient, userId: UserId, request: MergeRequest) =>
  Effect.gen(function* () {
    yield* ownedChat(sql, userId, request.chatId)
    const fork = yield* liveFork(sql, request.chatId, request.forkId)
    const sourceChat = yield* ownedChat(sql, userId, request.source.chatId)
    const source = yield* liveFork(sql, request.source.chatId, request.source.forkId)
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
    const title = source.name?.trim() || sourceChat.title.trim() || "Untitled chat"
    if (first > sourceLength - 1)
      return yield* refused(
        continues
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
    const speakers = [...new Set(messages.flatMap((row) => (row.speaker_entity_id ? [row.speaker_entity_id] : [])))]
    const cards = new Map(
      (yield* loadCards(sql, userId, speakers as Array<EntityId>)).map((c) => [c.card.entityId as string, c.card])
    )
    const nameOf = (row: SourceRow) => {
      const card = row.speaker_entity_id ? cards.get(row.speaker_entity_id) : undefined
      return card?.modelName || card?.name || (sideOf(row) === "user" ? "User" : "Narrator")
    }
    const line = (row: SourceRow) => `${nameOf(row)}: ${row.content.trim()}`
    let used = 0
    let verbatimFrom = messages.length
    while (verbatimFrom > 0) {
      const cost = estimateTokens(line(messages[verbatimFrom - 1]!)) + 1
      if (used + cost > budget && verbatimFrom < messages.length) break
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
        blocks.push(summaryText(s.from + 1, s.to + 1, s.content.trim()))
        rows.push({
          kind: "summary",
          sourceSlotId: s.lastSlotId,
          speaker: null,
          name: `Summary of #${s.from + 1}–${s.to + 1}`,
          side: "assistant",
          content: s.content.trim(),
          sentAt: 0,
          included: "verbatim"
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
        speaker: row.speaker_entity_id,
        name: nameOf(row),
        side: sideOf(row),
        content: row.content,
        sentAt: row.created_at,
        included: kept ? "verbatim" : inSummary ? "summarized" : "left_out"
      })
    }
    const notes = [
      ...(leftOut && !request.includeLeftOut
        ? [`[${leftOut} earlier ${leftOut === 1 ? "message" : "messages"} of “${title}” not included.]`]
        : []),
      ...(nested ? [`[${nested} ${nested === 1 ? "chat" : "chats"} merged into “${title}” not included.]`] : [])
    ]
    const transcript = [...notes, ...blocks].join("\n\n")

    // The cast: the union of both at the merge point (DESIGN §3.3 [D]).
    const destCast = yield* castAt(sql, request.chatId, atId, fork.id)
    const sourceCast = yield* castAt(sql, source.chat_id, sourceEnd, source.id)
    const union = [...new Set([...destCast, ...sourceCast])]
    const added = sourceCast.filter((id) => !destCast.includes(id))
    const castCards = new Map(
      (yield* loadCards(sql, userId, union as Array<EntityId>)).map((c) => [c.card.entityId as string, c.card])
    )
    const castNames = sourceCast.map((id) => castCards.get(id)?.modelName || castCards.get(id)?.name || "someone")

    // A summary covering M in the destination is written again over the join (MESSAGE-INSERT §3.4).
    const append = atId === fork.tip_slot_id && end === fork.tip_slot_id
    const destLayer = append
      ? null
      : yield* selectSummaryLayer(sql, userId, request.chatId, end).pipe(inFork(sql, request.chatId, fork.id, end))
    const covering = destLayer?.summaries.find((s) => s.from <= atPos + 1 && atPos + 1 < s.to) ?? null

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
      rewrites: covering ? { from: covering.from, to: covering.to, tokens: covering.tokens } : null
    }
    // Hash the actual preview and frozen rows, including full texts and speaker names.
    // Text length alone misses same-length edits and swipes made while the dialog is open.
    const digest = createHash("sha256")
      .update(JSON.stringify([request, source.tip_slot_id, sourceEnd, previewFields, rows]))
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
      rows,
      transcript,
      union,
      destCast,
      sourceCast,
      added,
      castNames,
      counts
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
      createdAt: row.created_at
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
    return {
      MergeChat: ({ userId, title, framing, digest, ...request }) =>
        Effect.gen(function* () {
          const now = Date.now()
          const plan = yield* mergePlan(sql, userId, request)
          if (plan.preview.digest !== digest) return yield* new MergeChanged({ preview: plan.preview })
          const chatId = request.chatId
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
            plan.at,
            version,
            now,
            plan.fork.id,
            [],
            0,
            !plan.append
          )
          if (plan.append)
            yield* sql`UPDATE forks SET tip_slot_id = ${slotId}, row_version = row_version + 1 WHERE id = ${plan.fork.id}`
          else yield* writeInsert(sql, { id: plan.fork.id, chatId }, slotId, 1)
          // The join pins the union: the merged-in characters took part (DESIGN §3.5).
          yield* sql`UPDATE versions SET cast_json = ${JSON.stringify(plan.union)} WHERE id = ${row.id}`
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
          const mergeId = uuidv7()
          const inDestination = new Set(plan.destCast)
          const inSource = new Set(plan.sourceCast)
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
            created_at: now
          })}`
          for (let i = 0; i < plan.rows.length; i += 200)
            yield* sql`INSERT INTO chat_merge_messages ${sql.insert(
              plan.rows.slice(i, i + 200).map((r, n) => ({
                merge_id: mergeId,
                ordinal: i + n,
                kind: r.kind,
                source_slot_id: r.sourceSlotId,
                speaker_entity_id: r.speaker,
                speaker_name: r.name,
                side: r.side,
                content: r.content,
                sent_at: r.sentAt,
                included: r.included
              }))
            )}`
          // Merging adds a message: the fork is chatted in (ARCHITECTURE §3.8).
          yield* graph.chatIn(plan.fork.id, now)
          const [chat] = yield* sql<ChatRow>`
            UPDATE chats SET last_message_at = ${now},
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              row_version = row_version + 1
            WHERE id = ${chatId} RETURNING *`
          const [tip] = yield* sql<{
            tip: string | null
          }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${plan.fork.id}`
          const pieces = yield* pathPieces(sql, chatId, plan.fork.id, tip!.tip)
          const position = positionOf(pieces, (yield* slotPlace(sql, chatId, slotId))!)!
          return new MergeResult({
            slotId: slotId as SlotId,
            forkId: plan.fork.id as ForkId,
            position,
            chat: toChat(chat!)
          })
        }).pipe(transaction(sql, "MergeChat"))
    } satisfies Partial<WriteHandlers>
  })
