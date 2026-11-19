// Summaries kept per view (spec/CHARACTER-CONTEXT.md §2.3 [D], §9.2 unit C7). A summary's
// `audience_json` is NULL for the whole path (a shared context, a narrator, a persona), or the
// identities of the one character whose separate context it summarizes: its card and the cards
// it replaced on that fork (`card.swap`), sorted and distinct (the baseline's canonical-form
// triggers). Such a summary's inputs are the messages that character knew; one it didn't know is
// an input with no version, as an absent message is. A view reads the shared summaries up to its
// first message it didn't know, then its own: the context's cached prefix is the shared one up to
// where it diverged. In a chat with one shared context, a separate join (spec/THREADS.md §7.3,
// TH7) makes such views too, scoped to its parallel stretch (`STRETCH_VIEW`, db/knowers.ts).
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { type ForkRef, shownIn, shownVersionDeletedIn, slotDeletedIn, viewAt } from "./forkState.ts"
import { displaySlots } from "./displayPath.ts"
import { pathView } from "./lcmDisplay.ts"
import { isStretchView, knowsSql } from "./knowers.ts"
import { STRETCH_VIEW } from "@dreamspan/shared/knowledge.ts"
import { stretchesAt } from "./threadStretches.ts"
import { type ChatState, type FoldableEvent, foldState } from "@dreamspan/shared/state.ts"
import { identitiesOf } from "../assembler/knowledge.ts"
import { stateEventsThrough } from "./stateRead.ts"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"

/** A view's audience: its identities, in the stored canonical form. */
export const audienceKey = (identities: ReadonlyArray<string>) => JSON.stringify([...new Set(identities)].sort())

/** The identities an audience key names. */
export const audienceIds = (key: string) => JSON.parse(key) as ReadonlyArray<string>

/**
 * The rows of `summaries` or `summarization_jobs` (alias `alias`) a view reads: the shared ones,
 * and those whose audience is among its identities (a summary written before a card replacement
 * stays its successor's). No identities: the shared rows only. A stretch view reads only its
 * kind's own rows, never a separate context's, which left out more.
 */
export const audienceScope = (sql: SqlClient.SqlClient, alias: string, identities?: ReadonlyArray<string>) =>
  identities === undefined
    ? sql`${sql.literal(alias)}.audience_json IS NULL`
    : isStretchView(identities)
      ? sql`(${sql.literal(alias)}.audience_json IS NULL OR (NOT EXISTS (SELECT 1 FROM json_each(${sql.literal(alias)}.audience_json) a
        WHERE a.value NOT IN (SELECT value FROM json_each(${JSON.stringify([...identities])})))
          AND EXISTS (SELECT 1 FROM json_each(${sql.literal(alias)}.audience_json) a WHERE a.value = ${STRETCH_VIEW})))`
      : sql`(${sql.literal(alias)}.audience_json IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(${sql.literal(alias)}.audience_json) a
        WHERE a.value NOT IN (SELECT value FROM json_each(${JSON.stringify([...identities])}))))`

/**
 * Whether a live separate join (resolved from its predecessor, `threadStretches`) is on the path to
 * `leaf`: only there does a chat with one shared context keep views (spec/THREADS.md §7.3). One
 * indexed read of the chat's merges, then a path probe per such join (few).
 */
export const stretchOnPath = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null) =>
  Effect.map(stretchesAt(sql, chatId, leaf), (ranges) => ranges.length > 0)

/** A stretch view's identities: the character's, with `STRETCH_VIEW`. */
const stretchView = (identities: ReadonlyArray<string>) => [...new Set([...identities, STRETCH_VIEW])]

/** Whether the chat state reads one shared context (the default). */
const sharedContext = (state: ChatState) => state.contextPerSpeaker === null || state.contextPerSpeaker === "shared"

/**
 * A character's view at `leaf`, as the summary UI names it: its identities (its card and those
 * it replaced on the path, `card.swap`) and their audience key; in a chat with one shared
 * context, its stretch view where a separate join is on the path (a narrator's or persona's
 * view there is the shared one, its identities alone).
 */
export const viewerAudience = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: string,
  leaf: string,
  viewer: string
) {
  const rows = yield* stateEventsThrough(sql, chatId as ChatId, leaf as SlotId, yield* viewAt(sql, chatId, leaf))
  const events = rows.map((e) => ({ scope: e.scope, data: { key: e.key, value: JSON.parse(e.value_json) } }))
  // Any of the character's identities names it: its card now, or one it replaced.
  const replaced = identitiesOf(events as Array<FoldableEvent>)
  const own = replaced.get(viewer) ?? [...replaced.values()].find((ids) => ids.includes(viewer)) ?? [viewer]
  const state = foldState(events as Array<FoldableEvent>)
  const identities =
    sharedContext(state) &&
    state.roles[viewer] !== "narrator" &&
    !state.playedByMe.includes(viewer) &&
    (yield* stretchOnPath(sql, chatId, leaf))
      ? stretchView(own)
      : own
  return { identities, audience: audienceKey(identities) }
})

/**
 * Which of these versions the identities knew (`knowsSql`, in fork `fork` when given: what it
 * counts them not present for): point lookups by version id.
 */
export const knownVersions = (
  sql: SqlClient.SqlClient,
  versionIds: ReadonlyArray<string>,
  identities: ReadonlyArray<string>,
  fork?: ForkRef
) =>
  Effect.gen(function* () {
    if (versionIds.length === 0) return new Set<string>()
    const rule = yield* knowsSql(sql, identities, fork, true)
    const rows = yield* sql<{ id: string }>`SELECT v.id FROM json_each(${JSON.stringify([...new Set(versionIds)])}) r
      CROSS JOIN version_records v ON v.id = r.value CROSS JOIN slots s ON s.id = v.slot_id WHERE ${rule}`
    return new Set(rows.map((row) => row.id))
  })

/**
 * Whether the identities knew every message a summary was written from: its inputs' recorded
 * versions, through its children for a higher level. A stale summary is used for a view only
 * then, so a later correction of who was there can't put a missed message back in its context.
 */
export const inputsKnown = (
  sql: SqlClient.SqlClient,
  summaryId: string,
  identities: ReadonlyArray<string>,
  fork?: ForkRef
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ unknown: number }>`WITH RECURSIVE parts(id) AS (
        SELECT ${summaryId} UNION SELECT p.parent_id FROM summary_parents p JOIN parts ON p.summary_id = parts.id
      ) SELECT EXISTS (SELECT 1 FROM parts JOIN summary_inputs i ON i.summary_id = parts.id
        JOIN version_records v ON v.id = i.version_id JOIN slots s ON s.id = v.slot_id
        WHERE NOT CASE WHEN (SELECT audience_json FROM summaries WHERE id=${summaryId}) IS NOT NULL
          THEN ${yield* knowsSql(sql, identities, fork, true)} ELSE ${yield* knowsSql(sql, identities, fork)} END) AS unknown`
    return (rows[0]?.unknown ?? 0) === 0
  })

/**
 * The display position of the first message on the path to `leaf` the identities didn't know, as its fork
 * shows it; null when they knew everything. Shared summaries end before it to be theirs too.
 */
export const firstUnknownPosition = (
  sql: SqlClient.SqlClient,
  chatId: string,
  leaf: string,
  identities: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    // A stretch view knew everything off a separate join's stretch: none on the path, nothing missed.
    if (isStretchView(identities) && !(yield* stretchOnPath(sql, chatId, leaf))) return null
    const fork = yield* viewAt(sql, chatId, leaf)
    const shown = yield* pathView(sql, chatId, leaf)
    const path = shown
      ? sql`${displaySlots(sql, shown.pieces, 0, shown.end)}, path(id, position) AS (SELECT id, position FROM display_slots)`
      : sql`WITH RECURSIVE path(id, position) AS (
        SELECT id, depth FROM slots WHERE id = ${leaf} AND chat_id = ${chatId}
        UNION ALL SELECT s.id, s.depth FROM slots s JOIN path p ON s.id = (SELECT parent_slot_id FROM slots WHERE id = p.id)
      )`
    const [row] = yield* sql<{ position: number | null }>`${path}
      SELECT min(path.position) AS position FROM path JOIN slots s ON s.id = path.id
        JOIN version_records v ON v.id = ${shownIn(sql, fork, "s")}
        WHERE NOT ${slotDeletedIn(sql, fork, "s")} AND ${contextExcludedIn(sql, fork)} = 0
          AND NOT ${shownVersionDeletedIn(sql, fork, "v")} AND v.status NOT IN ('generating', 'failed')
          AND (v.content_length > 0 OR EXISTS (SELECT 1 FROM version_attachments a WHERE a.version_id=v.id))
          AND NOT ${yield* knowsSql(sql, identities, fork)}`
    return row?.position ?? null
  })

/** A separate context with summaries of its own: its character, identities and audience key. */
interface SummaryView {
  readonly entity: string
  readonly identities: ReadonlyArray<string>
  readonly audience: string
  /** The display position of its first message it didn't know: the shared summaries end before it. */
  readonly unknownFrom: number
}

/**
 * The views with summaries of their own at `leaf`: in a chat set to separate contexts (any view
 * but `shared`), each character of the cast, not a narrator nor a persona (they read the whole
 * path, §6 [D]), that missed a message on the path. A character that knew everything reads the
 * shared summaries, so a chat makes one summary pass per character that missed something. In a
 * chat with one shared context, the same for what each missed in the stretch of a separate join
 * on the path (spec/THREADS.md §7.3, TH7): stretch views; with no such join, none.
 */
export const activeViews = (
  sql: SqlClient.SqlClient,
  chatId: string,
  leaf: string,
  state: ChatState,
  events: ReadonlyArray<FoldableEvent>
) =>
  Effect.gen(function* () {
    const shared = sharedContext(state)
    if (shared && !(yield* stretchOnPath(sql, chatId, leaf))) return []
    const replaced = identitiesOf(events)
    const views: Array<SummaryView> = []
    for (const entity of state.participants) {
      if (state.playedByMe.includes(entity) || state.roles[entity] === "narrator") continue
      const own = replaced.get(entity) ?? [entity]
      const identities = shared ? stretchView(own) : own
      const unknownFrom = yield* firstUnknownPosition(sql, chatId, leaf, identities)
      if (unknownFrom !== null) views.push({ entity, identities, audience: audienceKey(identities), unknownFrom })
    }
    return views
  })
