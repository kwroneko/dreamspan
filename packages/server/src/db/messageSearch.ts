// Message text search across all of the user's chats (SearchMessages; @rp/shared/messageSearch.ts,
// ARCHITECTURE §12 "Finding a message"). A hit is a message version, the text as written, with
// the live branches that show it: a message a hundred branches share is one hit. Read newest
// first through the version full-text index, a batch of matches at a time; each match is checked
// for ownership, deletion and whether any branch can show it (its slot's selection, or a
// branch's selection or replacement naming it) before its chat's branches are looked at, so the
// unselected swipes most matches are cost one indexed row each. A page stops at `limit` hits or
// after `SCAN` matches, whichever comes first, with a cursor to go on from, so a query no
// version of the user's matches still answers in bounded time. Every statement is separate, so
// a superseded query interrupted by its caller stops at the next one (readerPool.ts).
import { importState, unfinishedTitle } from "@rp/shared/stImportApi.ts"
import { chatName } from "@rp/shared/chatName.ts"
import type { ChatId, EntityId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import {
  excerpt,
  focusPhrase,
  HIT_BRANCHES,
  type HitBranch,
  type MessageCursor,
  type MessageHit,
  type MessageSearchPage,
  type ParsedQuery,
  parseQuery,
  queryWords
} from "@rp/shared/messageSearch.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { onDisplayPath, type PathPiece, pathPieces, positionOf } from "./displayPath.ts"
import { forkRecency } from "./forks.ts"
import { chatForkSummaries, computeForkSummaries, FORK_SUMMARY_FORMAT, summaryStamps } from "./forkSummaries.ts"
import { shownIn, shownVersionDeletedIn, slotDeletedIn } from "./forkState.ts"
import type { ForkRow } from "./rows.ts"
import { query } from "./tx.ts"

/** Full-text matches read per statement. */
const BATCH = 5000
/** Matches a page looks at most before it answers with what it found and a cursor. */
const SCAN = 20_000

interface Candidate {
  readonly seq: number
  readonly id: string | null
  readonly slot_id: string | null
  readonly speaker_entity_id: string | null
  readonly writer: string | null
  readonly created_at: number | null
  readonly chat_id: string | null
  readonly chain_id: string | null
  readonly depth: number | null
  readonly inserted: number | null
  /** Owned, live, finished and possibly shown somewhere. */
  readonly eligible: number
}

interface ChatForks {
  readonly name: string
  readonly currentForkId: string | null
  /** Live forks, most recently current first. */
  readonly forks: ReadonlyArray<ForkRow & { readonly tip_depth: number | null }>
  readonly pieces: Map<string, ReadonlyArray<PathPiece>>
  /** Where each unnamed branch parts from its parent, as its list row names it. */
  readonly splits: Map<string, HitBranch["split"]>
}

/**
 * The full-text queries a search reads, in the order their matches are listed. Each word is
 * quoted so FTS syntax in it is only text; a word as the start of a word (`*`), a quoted
 * phrase's words exactly and side by side. Two or more words outside quotes are read twice:
 * first where they stand side by side in the order typed (an FTS phrase of prefixes), then
 * where they're all present but apart, so a phrase match ranks above scattered words.
 */
const matchPhases = ({ phrases, words }: ParsedQuery): ReadonlyArray<string> => {
  const quote = (word: string) => `"${word.replaceAll('"', '""')}"`
  const all = [...phrases.map((phrase) => quote(phrase.join(" "))), ...words.map((word) => `${quote(word)}*`)].join(
    " AND "
  )
  if (phrases.length > 0 || words.length < 2) return [all]
  const together = words.map((word) => `${quote(word)}*`).join(" + ")
  return [together, `(${all}) NOT (${together})`]
}

const searchMessages = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  text: string,
  cursor: MessageCursor | null,
  limit: number
) =>
  Effect.gen(function* () {
    const words = queryWords(text)
    if (words.length === 0) return { hits: [], next: null } satisfies MessageSearchPage
    const phases = matchPhases(parseQuery(text))
    const phrase = focusPhrase(text)
    const chats = new Map<string, ChatForks | null>()
    const hits: Array<MessageHit> = []
    let phase = cursor?.phase === "words" && phases.length > 1 ? 1 : 0
    let before = cursor?.before ?? Number.MAX_SAFE_INTEGER
    let scanned = 0
    let finished = false
    for (;;) {
      while (scanned < SCAN) {
        const batch = yield* sql<Candidate>`
          WITH h(seq) AS MATERIALIZED (
            SELECT rowid FROM versions_fts WHERE versions_fts MATCH ${phases[phase]!}
              AND rowid < ${before} ORDER BY rowid DESC LIMIT ${BATCH})
          SELECT h.seq, v.id, v.slot_id, v.speaker_entity_id, v.writer, v.created_at, s.chat_id, s.chain_id,
            s.depth, s.inserted,
            (c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND v.status NOT IN ('generating', 'failed')
              AND v.deleted_at IS NULL AND v.purged_at IS NULL AND s.deleted_at IS NULL AND s.purged_at IS NULL
              AND (s.selected_version_id = v.id
                OR EXISTS (SELECT 1 FROM fork_overrides o WHERE o.target_id = s.id AND o.kind = 'select' AND o.value_id = v.id)
                OR (v.fork_id IS NOT NULL AND EXISTS (SELECT 1 FROM fork_overrides o
                  WHERE o.target_id = v.source_version_id AND o.kind = 'replace' AND o.value_id = v.id)))) AS eligible
          FROM h LEFT JOIN versions v ON v.seq = h.seq LEFT JOIN slots s ON s.id = v.slot_id
            LEFT JOIN chats c ON c.id = s.chat_id
          ORDER BY h.seq DESC`
        let read = 0
        for (const row of batch) {
          read++
          scanned++
          before = row.seq
          if (row.eligible !== 1) continue
          const hit = yield* hitOf(sql, userId, chats, row, words, phase === 0 ? phrase : null)
          if (hit !== null) hits.push(hit)
          if (hits.length === limit) break
        }
        if (batch.length < BATCH && read === batch.length) {
          finished = true
          break
        }
        if (hits.length === limit) break
      }
      // A phase read to its end goes on with the next, from the newest, while the page has room.
      if (!finished || phase === phases.length - 1) break
      phase++
      before = Number.MAX_SAFE_INTEGER
      finished = false
      if (hits.length === limit || scanned >= SCAN) break
    }
    const next: MessageCursor | null = finished ? null : { before, ...(phase === 1 ? { phase: "words" as const } : {}) }
    return { hits, next } satisfies MessageSearchPage
  })

/** The chat's name and live forks, read once per search. */
const chatForks = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  Effect.gen(function* () {
    const [chat] = yield* sql<{ title: string; current_fork_id: string | null; shell_stamp: number }>`
      SELECT title, current_fork_id, shell_stamp FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
    if (!chat) return null
    const forks = yield* sql<ForkRow & { tip_depth: number | null }>`
      SELECT f.*, t.depth AS tip_depth FROM forks f LEFT JOIN slots t ON t.id = f.tip_slot_id
      WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
      ORDER BY f.id = ${chat.current_fork_id} DESC, ${sql.literal(forkRecency("f"))} DESC, f.id DESC`
    // The cast as the current branch's list row has it, for a chat named after its characters.
    const userStamp = yield* summaryStamps(sql, userId)
    const [stored] = yield* sql<{ cast_json: string }>`SELECT cast_json FROM fork_summaries
      WHERE fork_id = ${chat.current_fork_id} AND stamp = ${chat.shell_stamp}
        AND user_stamp = ${userStamp} AND format = ${FORK_SUMMARY_FORMAT}`
    const current = forks.find((fork) => fork.id === chat.current_fork_id)
    const castIds =
      stored !== undefined
        ? stored.cast_json
        : JSON.stringify(current === undefined ? [] : (yield* computeForkSummaries(sql, [current]))[0]!.cast)
    const cast = yield* sql<{ label: string }>`SELECT r.label FROM json_each(${castIds}) j
      JOIN entity_refs r ON r.entity_id = j.value ORDER BY j.key`
    const imported = importState(chat.title)
    const name = chatName(
      imported.title,
      cast.map((c) => ({ name: c.label }))
    ).name
    return {
      name: imported.unfinished ? unfinishedTitle(name) : name,
      currentForkId: chat.current_fork_id,
      forks,
      pieces: new Map(),
      splits: new Map()
    } satisfies ChatForks
  })

const hitOf = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chats: Map<string, ChatForks | null>,
  row: Candidate,
  words: ReadonlyArray<string>,
  /** Where the excerpt is centred, when the message has it side by side. */
  phrase: ReadonlyArray<string> | null
) =>
  Effect.gen(function* () {
    const chatId = row.chat_id!
    if (!chats.has(chatId)) chats.set(chatId, yield* chatForks(sql, userId, chatId))
    const chat = chats.get(chatId)
    if (!chat) return null
    const place = { id: row.slot_id!, chainId: row.chain_id!, depth: row.depth! }
    // Forks whose tip is at or below the message (an inserted one can sit below its tip).
    const reaching = chat.forks.filter((f) => row.inserted === 1 || (f.tip_depth ?? -1) >= place.depth)
    if (reaching.length === 0) return null
    const showing = new Set(
      (yield* sql<{ id: string }>`
        SELECT f.value AS id FROM json_each(${JSON.stringify(reaching.map((f) => f.id))}) f
        CROSS JOIN slots s ON s.id = ${place.id} CROSS JOIN versions v ON v.id = ${row.id}
        WHERE ${shownIn(sql, sql.literal("f.value"), "s")} = v.id
          AND NOT ${slotDeletedIn(sql, sql.literal("f.value"), "s")}
          AND NOT ${shownVersionDeletedIn(sql, sql.literal("f.value"), "v")}`).map((r) => r.id)
    )
    const shown: Array<ForkRow & { position: number }> = []
    for (const fork of reaching) {
      if (!showing.has(fork.id)) continue
      let pieces = chat.pieces.get(fork.id)
      if (pieces === undefined) {
        pieces = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
        chat.pieces.set(fork.id, pieces)
      }
      if (!onDisplayPath(pieces, place)) continue
      shown.push({ ...fork, position: (positionOf(pieces, place) ?? place.depth) + 1 })
    }
    if (shown.length === 0) return null
    const named = shown.slice(0, HIT_BRANCHES)
    // Only an unnamed branch made from another is named by where it splits off (`forkLabel`):
    // read its stored summary, or work it out, once per search.
    const unknown = named.filter(
      (f) => (f.name === null || f.name === "") && f.parent_fork_id !== null && !chat.splits.has(f.id)
    )
    if (unknown.length > 0) {
      const summaries = yield* chatForkSummaries(sql, userId, chatId, unknown)
      for (const f of unknown) chat.splits.set(f.id, summaries.get(f.id)?.split ?? null)
    }
    const branches = named.map((f): HitBranch => ({
      forkId: f.id as ForkId,
      name: f.name,
      original: f.parent_fork_id === null,
      split: chat.splits.get(f.id) ?? null,
      createdAt: f.created_at,
      current: f.id === chat.currentForkId
    }))
    const [content] = yield* sql<{ content: string }>`SELECT content FROM version_texts WHERE version_seq = ${row.seq}`
    const [speaker] =
      row.speaker_entity_id === null
        ? []
        : yield* sql<{ label: string }>`SELECT r.label FROM entity_refs r JOIN entities e ON e.id = r.entity_id
            WHERE r.entity_id = ${row.speaker_entity_id} AND e.owner_user_id = ${userId}`
    return {
      versionId: row.id as VersionId,
      slotId: place.id as SlotId,
      chatId: chatId as ChatId,
      chatName: chat.name,
      speakerEntityId: row.speaker_entity_id as EntityId | null,
      speaker: speaker?.label ?? (row.writer === "human" ? "You" : "Model"),
      position: shown[0]!.position,
      createdAt: row.created_at!,
      excerpt: excerpt(content?.content ?? "", words, undefined, phrase),
      branches,
      branchCount: shown.length
    } satisfies MessageHit
  })

export const makeMessageSearchHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SearchMessages: ({
      userId,
      text,
      cursor,
      limit
    }: {
      readonly userId: UserId
      readonly text: string
      readonly cursor: MessageCursor | null
      readonly limit: number
    }) => searchMessages(sql, userId, text, cursor, limit).pipe(query("SearchMessages"))
  }
})
