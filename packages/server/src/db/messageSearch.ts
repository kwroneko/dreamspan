// Message text search across all of the user's chats (SearchMessages; @dreamspan/shared/messageSearch.ts,
// ARCHITECTURE §12 "Finding a message"). A hit is a message version, the text as written, with
// the live branches that show it: a message a hundred branches share is one hit. Read newest
// first through the version full-text index, a batch of matches at a time; each match is checked
// for ownership, deletion and whether any branch can show it (its slot's selection, or a
// branch's selection or replacement naming it) before its chat's branches are looked at, so the
// unselected swipes most matches are cost one indexed row each. A page stops at `limit` hits or
// after `SCAN` matches, whichever comes first, with a cursor to go on from, so a query no
// version of the user's matches still answers in bounded time. Every statement is separate, so
// a superseded query interrupted by its caller stops at the next one (readerPool.ts).
// Newest and Oldest read every match in one pass, either way; a filter or a character's scope
// restricts the matches to the chats the caller lists, in the same statement. The Chat sort reads
// the listed chats one at a time in their order, each between its first and last version
// (`chatSpan`), within the same SCAN, and at most CHAT_VISITS chats a page.
// CountMessages counts the matches that may be shown, capped (MESSAGE_COUNT_CAP, COUNT_SCAN).
import { importState, unfinishedTitle } from "@dreamspan/shared/stImportApi.ts"
import { chatName } from "@dreamspan/shared/chatName.ts"
import type { ChatId, EntityId, ForkId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import {
  excerpt,
  focusPhrase,
  HIT_BRANCHES,
  type HitBranch,
  MESSAGE_COUNT_CAP,
  type MessageCount,
  type MessageCursor,
  type MessageHit,
  type MessageSearchPage,
  type MessageSort,
  type ParsedQuery,
  parseQuery,
  queryWords
} from "@dreamspan/shared/messageSearch.ts"
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
 * Every word and phrase present, anywhere in the text: what Newest, Oldest, Chat and the count
 * read. Each word is quoted so FTS syntax in it is only text; a word as the start of a word
 * (`*`), a quoted phrase's words exactly and side by side.
 */
const quote = (word: string) => `"${word.replaceAll('"', '""')}"`
const matchAll = ({ phrases, words }: ParsedQuery) =>
  [...phrases.map((phrase) => quote(phrase.join(" "))), ...words.map((word) => `${quote(word)}*`)].join(" AND ")

/**
 * The full-text queries Best match reads, in the order their matches are listed. Two or more
 * words outside quotes are read twice: first where they stand side by side in the order typed
 * (an FTS phrase of prefixes), then where they're all present but apart, so a phrase match
 * ranks above scattered words.
 */
const matchPhases = (parsed: ParsedQuery): ReadonlyArray<string> => {
  const { phrases, words } = parsed
  const all = matchAll(parsed)
  if (phrases.length > 0 || words.length < 2) return [all]
  const together = words.map((word) => `${quote(word)}*`).join(" + ")
  return [together, `(${all}) NOT (${together})`]
}

/**
 * Whether a match is a message someone may see: in a live chat (its owner's: checked beside it),
 * finished, not deleted, and its slot's selection or a branch's selection or replacement.
 */
const ELIGIBLE = `c.deleted_at IS NULL AND v.status NOT IN ('generating', 'failed')
  AND v.deleted_at IS NULL AND v.purged_at IS NULL AND s.deleted_at IS NULL AND s.purged_at IS NULL
  AND (s.selected_version_id = v.id
    OR EXISTS (SELECT 1 FROM fork_overrides o WHERE o.target_id = s.id AND o.kind = 'select' AND o.value_id = v.id)
    OR (v.fork_id IS NOT NULL AND EXISTS (SELECT 1 FROM fork_overrides o
      WHERE o.target_id = v.source_version_id AND o.kind = 'replace' AND o.value_id = v.id)))`

/**
 * A batch of matches from `before` on, newest first (`down`) or oldest first, each with what
 * decides whether it's shown; in `chats` only, when given (a JSON array, null for every chat).
 * `from`: no match below this version (a chat's first, for the Chat sort).
 */
const batchOf = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  match: string,
  before: number,
  down: boolean,
  chats: string | null,
  from = 0
) => sql<Candidate>`
  WITH h(seq) AS MATERIALIZED (
    SELECT rowid FROM versions_fts WHERE versions_fts MATCH ${match}
      AND rowid ${sql.literal(down ? "<" : ">")} ${before} AND rowid >= ${from}
      ORDER BY rowid ${sql.literal(down ? "DESC" : "ASC")} LIMIT ${BATCH})
  SELECT h.seq, v.id, v.slot_id, v.speaker_entity_id, v.writer, v.created_at, s.chat_id, s.chain_id,
    s.depth, s.inserted,
    (c.owner_user_id = ${userId} AND ${sql.literal(ELIGIBLE)}
      AND (${chats} IS NULL OR s.chat_id IN (SELECT value FROM json_each(${chats})))) AS eligible
  FROM h LEFT JOIN versions v ON v.seq = h.seq LEFT JOIN slots s ON s.id = v.slot_id
    LEFT JOIN chats c ON c.id = s.chat_id
  ORDER BY h.seq ${sql.literal(down ? "DESC" : "ASC")}`

/**
 * The first and last version a chat holds: the Chat sort reads its matches between them, so a
 * chat written in one stretch costs only its own matches. Through the chat's slots and their
 * versions, both by covering indexes.
 */
const chatSpan = (sql: SqlClient.SqlClient, chatId: string) =>
  sql<{ readonly first: number | null; readonly last: number | null }>`
    SELECT MIN(v.seq) AS first, MAX(v.seq) AS last FROM slots s JOIN versions v ON v.slot_id = s.id
    WHERE s.chat_id = ${chatId}`

/** Chats the Chat sort looks into per page at most, past which it answers with a cursor. */
const CHAT_VISITS = 200

const searchMessages = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  text: string,
  cursor: MessageCursor | null,
  limit: number,
  sort: MessageSort,
  chatList: ReadonlyArray<string> | null
) =>
  Effect.gen(function* () {
    const words = queryWords(text)
    if (words.length === 0) return { hits: [], next: null } satisfies MessageSearchPage
    const parsed = parseQuery(text)
    const phrase = focusPhrase(text)
    const chats = new Map<string, ChatForks | null>()
    const hits: Array<MessageHit> = []
    if (sort === "chat") {
      // By chat name: the caller's list says the order (every chat, when it gave none).
      const order =
        chatList ??
        (yield* sql<{ id: string }>`SELECT id FROM chats WHERE owner_user_id = ${userId} AND deleted_at IS NULL
          ORDER BY title, id`).map((row) => row.id)
      // A chat at a time, in that order, each newest first between its first and last version.
      const match = matchAll(parsed)
      let chat = cursor?.chat ?? 0
      let before = cursor?.before ?? Number.MAX_SAFE_INTEGER
      let scanned = 0
      let visits = 0
      while (chat < order.length && hits.length < limit && scanned < SCAN && visits < CHAT_VISITS) {
        visits++
        const id = order[chat]!
        const [span] = yield* chatSpan(sql, id)
        let done = span?.last === null || span?.last === undefined
        while (!done && hits.length < limit && scanned < SCAN) {
          const batch = yield* batchOf(
            sql,
            userId,
            match,
            Math.min(before, span!.last! + 1),
            true,
            JSON.stringify([id]),
            span!.first!
          )
          let read = 0
          for (const row of batch) {
            read++
            scanned++
            before = row.seq
            if (row.eligible !== 1) continue
            const hit = yield* hitOf(sql, userId, chats, row, words, phrase)
            if (hit !== null) hits.push(hit)
            if (hits.length === limit) break
          }
          if (batch.length < BATCH && read === batch.length) done = true
        }
        if (!done) break
        chat++
        before = Number.MAX_SAFE_INTEGER
      }
      return { hits, next: chat >= order.length ? null : { before, chat } } satisfies MessageSearchPage
    }
    const only = chatList === null ? null : JSON.stringify(chatList)
    const down = sort !== "oldest"
    const phases = sort === "best" ? matchPhases(parsed) : [matchAll(parsed)]
    const start = down ? Number.MAX_SAFE_INTEGER : -1
    let phase = cursor?.phase === "words" && phases.length > 1 ? 1 : 0
    let before = cursor?.before ?? start
    let scanned = 0
    let finished = false
    for (;;) {
      while (scanned < SCAN) {
        const batch = yield* batchOf(sql, userId, phases[phase]!, before, down, only)
        let read = 0
        for (const row of batch) {
          read++
          scanned++
          before = row.seq
          if (row.eligible !== 1) continue
          const hit = yield* hitOf(sql, userId, chats, row, words, sort === "best" && phase === 1 ? null : phrase)
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
      before = start
      finished = false
      if (hits.length === limit || scanned >= SCAN) break
    }
    const next: MessageCursor | null = finished ? null : { before, ...(phase === 1 ? { phase: "words" as const } : {}) }
    return { hits, next } satisfies MessageSearchPage
  })

/** Matches a count reads at most before it answers "N+". */
const COUNT_SCAN = SCAN

/**
 * How many messages have the words (in `chatList` when given), and in how many chats: the
 * matches that may be shown (`ELIGIBLE`), newest first, stopping at MESSAGE_COUNT_CAP or after
 * COUNT_SCAN matches, so a common word answers as fast as a page.
 */
const countMessages = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  text: string,
  chatList: ReadonlyArray<string> | null
) =>
  Effect.gen(function* () {
    if (queryWords(text).length === 0) return { messages: 0, chats: 0, more: false } satisfies MessageCount
    const match = matchAll(parseQuery(text))
    const only = chatList === null ? null : JSON.stringify(chatList)
    const chats = new Set<string>()
    let messages = 0
    let scanned = 0
    let before = Number.MAX_SAFE_INTEGER
    for (;;) {
      const batch = yield* batchOf(sql, userId, match, before, true, only)
      for (const row of batch) {
        scanned++
        before = row.seq
        if (row.eligible !== 1) continue
        messages++
        chats.add(row.chat_id!)
        if (messages === MESSAGE_COUNT_CAP) return { messages, chats: chats.size, more: true } satisfies MessageCount
      }
      if (batch.length < BATCH) return { messages, chats: chats.size, more: false } satisfies MessageCount
      if (scanned >= COUNT_SCAN) return { messages, chats: chats.size, more: true } satisfies MessageCount
    }
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
      limit,
      sort,
      chats
    }: {
      readonly userId: UserId
      readonly text: string
      readonly cursor: MessageCursor | null
      readonly limit: number
      readonly sort?: MessageSort
      readonly chats?: ReadonlyArray<string> | null
    }) => searchMessages(sql, userId, text, cursor, limit, sort ?? "best", chats ?? null).pipe(query("SearchMessages")),
    CountMessages: ({
      userId,
      text,
      chats
    }: {
      readonly userId: UserId
      readonly text: string
      readonly chats?: ReadonlyArray<string> | null
    }) => countMessages(sql, userId, text, chats ?? null).pipe(query("CountMessages"))
  }
})
