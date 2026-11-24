// Branching a story branches its workshops (spec/WORKSHOP-BRANCHES.md §3). Every story fork row is
// made by `insertFork` (forkState.ts), which calls `branchWorkshops` in the same transaction: each
// live workshop beside the story with a branch paired with the parent fork A gets one new fork,
// paired with the new story fork B, cut at the workshop as it was when the story stood at B's fork
// point N (§3.2), or at its tip where the user chose "As it is now" (§4). Nothing is copied: one
// `forks` row, its placement rows (`placeAsShown`) and one `workshop.paired` event per workshop.
// The same cut answers the fork dialog's rows (`previewForkWorkshops`).
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { ForkWorkshop } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { displayEndOf, displayLength, displaySlots, pathPieces, positionOf } from "./displayPath.ts"
import { insertForkRow, shownIn, slotDeletedIn } from "./forkState.ts"
import { placeAsShown } from "./forkOrder.ts"
import type { ForkRow } from "./rows.ts"
import { pairedWorkshopForks, writePairing } from "./workshopPairing.ts"

/** The user's choice for a workshop in "Branch from here"; every other path takes "then". */
export type WorkshopChoice = "then" | "now"

/** How many left-out messages the dialog lists, the rest counted (§4). */
const LISTED = 20

interface PathMessage {
  readonly id: string
  readonly version_id: string
  readonly leaf: string | null
}

/** Workshop fork `fork`'s live messages, in display order, with each shown version's story position: ids only. */
const workshopPath = (sql: SqlClient.SqlClient, workshopId: string, fork: ForkRow) =>
  Effect.gen(function* () {
    const pieces = yield* pathPieces(sql, workshopId, fork.id, fork.tip_slot_id)
    const length = displayLength(pieces)
    if (length === 0) return []
    // A version written without its own record (an edit's) is where its source was.
    return yield* sql<PathMessage>`${displaySlots(sql, pieces, 0, length - 1)}
      , shown(id, version_id, position) AS (
        SELECT s.id, ${shownIn(sql, fork.id, "s")}, d.position FROM display_slots d JOIN slots s ON s.id = d.id
        WHERE NOT ${slotDeletedIn(sql, fork.id, "s")})
      SELECT sh.id, sh.version_id,
        coalesce(
          (SELECT json_extract(e.value_json, '$.leaf') FROM state_events e
            WHERE e.key = 'workshop.story_at' AND e.version_id = wv.id LIMIT 1),
          (SELECT json_extract(e.value_json, '$.leaf') FROM state_events e
            WHERE e.key = 'workshop.story_at' AND e.version_id = wv.source_version_id LIMIT 1)) AS leaf
      FROM shown sh JOIN version_records wv ON wv.id = sh.version_id
      ORDER BY sh.position`
  })

/**
 * The default cut (§3.2): the index in `path` of the newest message whose recorded story position
 * is on story fork A's display path at or before N (null: before the first message), or has none;
 * -1 when none does. A position A no longer shows (a message deleted since) doesn't qualify.
 */
const cutIndex = (
  sql: SqlClient.SqlClient,
  storyId: string,
  story: ForkRow,
  at: string | null,
  path: ReadonlyArray<PathMessage>
) =>
  Effect.gen(function* () {
    const leaves = [...new Set(path.flatMap((m) => (m.leaf === null ? [] : [m.leaf])))]
    if (leaves.length === 0) return path.length - 1
    const pieces = yield* pathPieces(sql, storyId, story.id, story.tip_slot_id)
    const places = yield* sql<{ id: string; chain_id: string; depth: number }>`
      SELECT id, chain_id, depth FROM slots WHERE chat_id = ${storyId} AND id IN ${sql.in(at === null ? leaves : [...leaves, at])}`
    const position = new Map(
      places.map((p) => [p.id, positionOf(pieces, { id: p.id, chainId: p.chain_id, depth: p.depth })])
    )
    const limit = at === null ? -1 : (position.get(at) ?? -1)
    for (let i = path.length - 1; i >= 0; i--) {
      const leaf = path[i]!.leaf
      if (leaf === null) return i
      const p = position.get(leaf)
      if (p !== undefined && p !== null && p <= limit) return i
    }
    return -1
  })

interface WorkshopCut {
  readonly workshopId: string
  readonly title: string
  readonly source: ForkRow
  /** The source's display end: "As it is now". */
  readonly tip: string | null
  /** The default cut: "As it was then". */
  readonly then: string | null
  /** What the default leaves out, oldest first. */
  readonly leftOut: ReadonlyArray<PathMessage>
}

/**
 * For each live workshop beside story `storyId` with a branch paired with its fork `story`: the
 * source branch (the one chatted in last, §3.1) and both cuts at `at`. Nothing is read past the
 * one probe when there's none.
 */
const workshopCuts = (sql: SqlClient.SqlClient, storyId: string, story: ForkRow, at: string | null) =>
  Effect.gen(function* () {
    const paired = yield* pairedWorkshopForks(sql, storyId, story.id)
    if (paired.length === 0) return []
    const sources = new Map<string, ForkRow>()
    // Ordered by chat, then chatted in last first: the first of each workshop is its source.
    for (const fork of paired) if (!sources.has(fork.chat_id)) sources.set(fork.chat_id, fork)
    const titles = new Map(
      (yield* sql<{ id: string; title: string | null }>`SELECT id, title FROM chats
        WHERE id IN ${sql.in([...sources.keys()])}`).map((c) => [c.id, c.title])
    )
    const cuts: Array<WorkshopCut> = []
    const atEnd = at !== null && at === (yield* displayEndOf(sql, storyId, story))
    for (const [workshopId, source] of sources) {
      const tip = (yield* displayEndOf(sql, workshopId, source)) ?? null
      const path = atEnd ? [] : yield* workshopPath(sql, workshopId, source)
      const index = atEnd ? -1 : yield* cutIndex(sql, storyId, story, at, path)
      cuts.push({
        workshopId,
        title: titles.get(workshopId)?.trim() || "Workshop",
        source,
        tip,
        then: atEnd ? tip : index < 0 ? null : path[index]!.id,
        leftOut: path.slice(index + 1)
      })
    }
    return cuts.sort((a, b) => a.workshopId.localeCompare(b.workshopId))
  })

/** A message's first line, for the dialog's list. */
const firstLine = (content: string) => {
  const line = content.trim().split("\n")[0]?.trim() ?? ""
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * The dialog's workshop rows (§4) for a branch of story fork `story` at `at`: each workshop whose
 * default cut leaves something out, with the source branch and tip (so the comparison digest
 * changes when a message is sent there) and the messages left out.
 */
export const previewForkWorkshops = (sql: SqlClient.SqlClient, storyId: string, story: ForkRow, at: string | null) =>
  Effect.gen(function* () {
    const rows: Array<ForkWorkshop> = []
    for (const cut of yield* workshopCuts(sql, storyId, story, at)) {
      if (cut.leftOut.length === 0) continue
      // Content and speakers only for the messages the dialog lists.
      const listed = cut.leftOut.slice(0, LISTED)
      const texts = new Map(
        (yield* sql<{ id: string; content: string; human: number; speaker: string | null }>`
          SELECT wv.id, wv.content, wv.writer = 'human' AS human,
            (SELECT r.label FROM entity_refs r WHERE r.entity_id = wv.speaker_entity_id ORDER BY r.id LIMIT 1) AS speaker
          FROM version_records wv WHERE wv.id IN ${sql.in(listed.map((m) => m.version_id))}`).map((t) => [t.id, t])
      )
      rows.push({
        workshop: cut.workshopId as ChatId,
        title: cut.title,
        sourceForkId: cut.source.id as ForkId,
        tipSlotId: cut.tip as SlotId | null,
        leftOut: {
          count: cut.leftOut.length,
          first: listed.map((m) => {
            const t = texts.get(m.version_id)
            return { speaker: t?.speaker ?? (t?.human ? "You" : "Assistant"), line: firstLine(t?.content ?? "") }
          })
        }
      })
    }
    return rows
  })

/**
 * The hook (§3.1): story fork `made` was just made from `parent` (its fork point `made.base_slot_id`).
 * Each workshop with a branch paired with `parent` gets a fork of that branch, paired with `made`,
 * without moving the workshop's own current fork.
 */
export const branchWorkshops = (
  sql: SqlClient.SqlClient,
  made: ForkRow,
  parent: ForkRow,
  at: number,
  choices?: ReadonlyMap<string, WorkshopChoice>
) =>
  Effect.gen(function* () {
    const cuts = yield* workshopCuts(sql, made.chat_id, parent, made.base_slot_id)
    for (const cut of cuts) {
      const point = choices?.get(cut.workshopId) === "now" ? cut.tip : cut.then
      const fork = yield* insertForkRow(sql, {
        chatId: cut.workshopId,
        parent: cut.source,
        baseSlotId: point,
        tipSlotId: point,
        at
      })
      yield* placeAsShown(sql, cut.workshopId, cut.source, point, fork)
      yield* writePairing(sql, cut.workshopId, fork.id, made.id)
    }
  })
