// What belongs to a fork rather than to a message (spec/FORK-INDEPENDENCE-DELTA.md §2.2;
// schema/forkOverrides.ts). A fork G sees its own overrides, its parent's with seq up to
// when G was made, its grandparent's up to when the parent was made, and so on, as its
// `lineage_json` lists them. The effective value of a key in G is the first lineage entry
// with a row for it, the newest row there; without one, the base column. Reads cost the
// lineage's length per key, never the path's or the chat's.
import { uuidv7 } from "@rp/shared/id.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Context, Effect } from "effect"
import type { SqlClient, Statement } from "effect/sql"
import { forkThrough } from "./forks.ts"
import { type ForkRow, versionExtras, type VersionRow } from "./rows.ts"

/**
 * The fork a read without a fork of its own is in, provided once per operation (`atLeaf`,
 * `inFork`). Null: none was, and each read takes the fork through its slot (`viewAt`).
 */
const ForkView = Context.Reference<string | null>("rp/ForkView", { defaultValue: () => null })

/** A fork made from one whose lineage would grow past this starts afresh with a copy of its rows. */
export const LINEAGE_CAP = 64

/** A fork: an id bound as a parameter, or an SQL expression (`sql.literal("c.current_fork_id")`). */
type ForkRef = string | null | Statement.Fragment

/**
 * SQL: the id of the effective override of `kind` for `target` in the fork `fork` (both SQL
 * expressions, which can't name `ef`, `el` or `eo`), or null. One lookup by index per fork in
 * the lineage, by `fork_overrides_point`: the joins are `CROSS JOIN`s to keep the lineage
 * outside, since SQLite 3.53 (Node 24.22) otherwise takes `fork_overrides_target`, which reads
 * every fork's overrides of the target.
 */
const effectiveOverrideSql = (kind: string, fork: string, target: string) => `(
  SELECT eo.id FROM forks ef CROSS JOIN json_each(ef.lineage_json) el CROSS JOIN fork_overrides eo
  WHERE ef.id = ${fork} AND eo.fork_id = el.value ->> 0 AND eo.kind = '${kind}'
    AND eo.target_id = ${target} AND eo.seq <= coalesce(el.value ->> 1, 9223372036854775807)
  ORDER BY el.key, eo.seq DESC LIMIT 1)`

/** SQL: the version slot `s` shows in the fork `fork` (an SQL expression): its selection there, else its own. */
export const selectedInSql = (fork: string, s: string) =>
  `coalesce((SELECT value_id FROM fork_overrides WHERE id = ${effectiveOverrideSql("select", fork, `${s}.id`)}),
    ${s}.selected_version_id)`

/**
 * SQL: the message's own version that version row `v` is or stands in for. A fork's own
 * version is a copy standing in for one (schema/forkVersions.ts); swipes are the message's.
 */
export const originalSql = (v: string) => `CASE WHEN ${v}.fork_id IS NULL THEN ${v}.id ELSE ${v}.source_version_id END`

/**
 * SQL: what the fork `fork` shows in place of `version`, one of a message's own versions
 * (both SQL expressions): the copy its replacement names, else the version itself.
 */
const replacedInSql = (fork: string, version: string) =>
  `coalesce((SELECT value_id FROM fork_overrides WHERE id = ${effectiveOverrideSql("replace", fork, version)}),
    ${version})`

/**
 * SQL: from slot `s`, as `ss_`, joined to the fork's selection override `so_` and its
 * replacement override `sr_` of what that selects, so each is one lookup per lineage entry.
 */
const selectionJoins = (fork: string, s: string) => `FROM slots ss_
  LEFT JOIN fork_overrides so_ ON so_.id = ${effectiveOverrideSql("select", fork, "ss_.id")}
  LEFT JOIN fork_overrides sr_
    ON sr_.id = ${effectiveOverrideSql("replace", fork, "coalesce(so_.value_id, ss_.selected_version_id)")}
  WHERE ss_.id = ${s}.id`

/** SQL: the version slot `s` shows in the fork `fork`: its selection there, as the fork replaces it. */
export const shownInSql = (fork: string, s: string) => `(
  SELECT coalesce(sr_.value_id, so_.value_id, ss_.selected_version_id) ${selectionJoins(fork, s)})`

/** `sqlText` with the fork bound in place of its placeholder. */
const withFork = (sql: SqlClient.SqlClient, fork: ForkRef, sqlText: (fork: string) => string) => {
  const [first, ...rest] = sqlText("\u0000").split("\u0000")
  return rest.reduce((statement, part) => sql`${statement}${fork}${sql.literal(part)}`, sql`${sql.literal(first!)}`)
}

/** `effectiveOverrideSql` for a fork bound as a parameter or given as a fragment. */
export const effectiveOverride = (sql: SqlClient.SqlClient, kind: string, fork: ForkRef, target: string) =>
  withFork(sql, fork, (f) => effectiveOverrideSql(kind, f, target))

/** The version slot `s` shows in `fork`: its selection there, else the slot's own. */
export const selectedIn = (sql: SqlClient.SqlClient, fork: ForkRef, s: string) =>
  withFork(sql, fork, (f) => selectedInSql(f, s))

/** The version slot `s` shows in `fork`: its selection there, as the fork replaces it (`shownInSql`). */
export const shownIn = (sql: SqlClient.SqlClient, fork: ForkRef, s: string) =>
  withFork(sql, fork, (f) => shownInSql(f, s))

/** What `fork` shows in place of `version`, one of a message's own (`replacedInSql`). */
export const replacedIn = (sql: SqlClient.SqlClient, fork: ForkRef, version: string) =>
  withFork(sql, fork, (f) => replacedInSql(f, version))

/**
 * Whether a state event attached to `column` applies at slot `s` in `fork`: while the fork
 * selects that version there, or shows it as the copy standing in for its selection.
 */
export const attachedApplies = (sql: SqlClient.SqlClient, fork: ForkRef, s: string, column: string) =>
  withFork(
    sql,
    fork,
    (f) => `(${column} IS NULL OR EXISTS (SELECT 1 ${selectionJoins(f, s)}
      AND ${column} IN (coalesce(so_.value_id, ss_.selected_version_id), sr_.value_id)))`
  )

/** SQL: the current fork of the chat `chat` (an SQL expression). */
export const currentForkSql = (chat: string) => `(SELECT current_fork_id FROM chats WHERE id = ${chat})`

/**
 * The live fork a read of the path to `slotId` is in, when it names no fork: the current
 * one if its path holds the slot, else the most recently current one whose path does, else
 * the current one. Generations started at a slot record their fork the same way.
 */
export const forkAt = (sql: SqlClient.SqlClient, chatId: string, slotId: string | null) =>
  Effect.gen(function* () {
    const [chat] = yield* sql<{ id: string | null }>`SELECT current_fork_id AS id FROM chats WHERE id = ${chatId}`
    const current = chat?.id ?? null
    if (slotId === null) return current
    return (yield* forkThrough(sql, chatId, slotId, current))?.id ?? current
  })

/** The fork in view (ForkView), else the one a read of the path to `slotId` is in (`forkAt`). */
export const viewAt = (sql: SqlClient.SqlClient, chatId: string, slotId: string | null) =>
  Effect.flatMap(ForkView, (fork) => (fork !== null ? Effect.succeed(fork) : forkAt(sql, chatId, slotId)))

/** Runs `effect` in the fork a read of the path to `slotId` is in (`forkAt`), unless one is in view already. */
export const atLeaf =
  (sql: SqlClient.SqlClient, chatId: string, slotId: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if ((yield* ForkView) !== null) return yield* effect
      const fork = yield* forkAt(sql, chatId, slotId)
      return yield* Effect.provideService(effect, ForkView, fork)
    })

/**
 * Runs `effect` in fork `forkId` of the chat, which must be one of its forks (NotFound
 * otherwise), or with none named, as `atLeaf` does.
 */
export const inFork =
  (sql: SqlClient.SqlClient, chatId: string, forkId: string | null | undefined, slotId: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    forkId == null
      ? atLeaf(sql, chatId, slotId)(effect)
      : Effect.gen(function* () {
          const [fork] = yield* sql<{ id: string }>`SELECT id FROM forks WHERE id = ${forkId} AND chat_id = ${chatId}`
          if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
          return yield* Effect.provideService(effect, ForkView, fork.id)
        })

/** The next state seq of a chat, for a per-fork write in the same transaction. */
const nextSeq = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.map(
    sql<{ seq: number }>`UPDATE chats SET state_seq = state_seq + 1 WHERE id = ${chatId} RETURNING state_seq AS seq`,
    ([row]) => row!.seq
  )

/**
 * A slot's selection in a fork, the version shown for it there (its replacement, if any), and
 * the newest seq of the overrides that decide those (0: the slot's own). Every per-fork write
 * takes a newer seq, so the seq only grows with the fork's own choices.
 */
export const selectionIn = (sql: SqlClient.SqlClient, forkId: string | null, slotId: string) =>
  Effect.map(
    sql<{ version_id: string; shown_id: string; seq: number }>`
      SELECT coalesce(o.value_id, s.selected_version_id) AS version_id,
        coalesce(r.value_id, o.value_id, s.selected_version_id) AS shown_id,
        max(coalesce(o.seq, 0), coalesce(r.seq, 0)) AS seq
      FROM slots s LEFT JOIN fork_overrides o ON o.id = ${effectiveOverride(sql, "select", forkId, "s.id")}
        LEFT JOIN fork_overrides r
          ON r.id = ${effectiveOverride(sql, "replace", forkId, "coalesce(o.value_id, s.selected_version_id)")}
      WHERE s.id = ${slotId}`,
    ([row]) => row ?? null
  )

/** A row of what a fork changes, by kind: what it's about and its value (schema/forkOverrides.ts). */
interface OverrideValue {
  readonly kind: "select" | "replace" | "star" | "picker_hide"
  readonly targetId: string
  readonly slotId: string
  readonly valueId: string | null
  readonly flag: number | null
}

/**
 * Fork `fork` has `value` for its key from now on. The fork's own row is updated in place
 * when no fork was made from it since that row (only a child's bound can reach it, and a
 * grandchild reads it through its parent's, which is earlier); otherwise a row is added, so
 * forks made from it keep what they saw. Either way it takes the next seq.
 */
export const writeOverride = (
  sql: SqlClient.SqlClient,
  fork: { readonly id: string; readonly chatId: string },
  value: OverrideValue,
  origin: "user" | "import" = "user"
) =>
  Effect.gen(function* () {
    const seq = yield* nextSeq(sql, fork.chatId)
    const [own] = yield* sql<{ id: string; seq: number; forked: number }>`
      SELECT o.id, o.seq, EXISTS (SELECT 1 FROM forks c WHERE c.parent_fork_id = o.fork_id AND c.branched_at >= o.seq)
        AS forked
      FROM fork_overrides o WHERE o.fork_id = ${fork.id} AND o.kind = ${value.kind} AND o.target_id = ${value.targetId}
      ORDER BY o.seq DESC LIMIT 1`
    if (own !== undefined && own.forked === 0) {
      yield* sql`UPDATE fork_overrides SET value_id = ${value.valueId}, flag = ${value.flag}, seq = ${seq},
        origin = ${origin} WHERE id = ${own.id}`
      return seq
    }
    yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag,
        origin)
      SELECT ${uuidv7()}, ${fork.chatId}, ${fork.id}, ${seq}, ${value.kind}, ${value.targetId}, id, depth,
        ${value.valueId}, ${value.flag}, ${origin}
      FROM slots WHERE id = ${value.slotId}`
    return seq
  })

/** Fork `fork` shows `versionId` at `slotId` from now on (`writeOverride`). */
export const writeSelect = (
  sql: SqlClient.SqlClient,
  fork: { readonly id: string; readonly chatId: string },
  slotId: string,
  versionId: string,
  origin: "user" | "import" = "user"
) => writeOverride(sql, fork, { kind: "select", targetId: slotId, slotId, valueId: versionId, flag: null }, origin)

/**
 * Every fork of the chat that shows `from` at `slotId`, deleted forks included, shows `to`
 * instead. For what still changes a slot in every fork at once: deleting a swipe, until
 * deletion is per fork (§2.4), and an ST re-import following its file (§5 step 6).
 */
export const reselectEverywhere = (
  sql: SqlClient.SqlClient,
  chatId: string,
  slotId: string,
  from: string,
  to: string,
  origin: "user" | "import" = "user"
) =>
  Effect.gen(function* () {
    const forks = yield* sql<{ id: string }>`
      SELECT f.id FROM forks f JOIN slots s ON s.id = ${slotId}
      WHERE f.chat_id = ${chatId} AND ${selectedIn(sql, sql.literal("f.id"), "s")} = ${from}`
    for (const fork of forks) yield* writeSelect(sql, { id: fork.id, chatId }, slotId, to, origin)
    return forks.length
  })

/**
 * A new fork of `parent`, made now: its lineage is itself, then the parent up to the chat's
 * state seq now, then the parent's lineage. Entries bounded at 0 are left out (no row has seq
 * 0). Past `LINEAGE_CAP` forks, the parent's effective rows are copied into the new fork,
 * which then reads only its own: that costs the overrides, not the path.
 */
export const insertFork = (
  sql: SqlClient.SqlClient,
  fork: {
    readonly chatId: string
    readonly parent: ForkRow
    readonly baseSlotId: string | null
    readonly tipSlotId: string | null
    readonly at: number
  }
) =>
  Effect.gen(function* () {
    const id = uuidv7()
    const [chat] = yield* sql<{ seq: number }>`SELECT state_seq AS seq FROM chats WHERE id = ${fork.chatId}`
    const branchedAt = chat!.seq
    const ancestors = (JSON.parse(fork.parent.lineage_json ?? "[]") as Array<[string, number]>).slice(1)
    const inherited = [[fork.parent.id, branchedAt] as [string, number], ...ancestors].filter(([, bound]) => bound > 0)
    const fresh = inherited.length + 1 > LINEAGE_CAP
    const lineage = fresh ? [[id, null]] : [[id, null], ...inherited]
    yield* sql`INSERT INTO forks (id, chat_id, parent_fork_id, branched_at, base_slot_id, tip_slot_id, created_at, lineage_json)
      VALUES (${id}, ${fork.chatId}, ${fork.parent.id}, ${branchedAt}, ${fork.baseSlotId}, ${fork.tipSlotId}, ${fork.at},
        ${JSON.stringify(lineage)})`
    if (fresh) {
      const rows = yield* sql<{
        kind: string
        target_id: string
        slot_id: string | null
        slot_depth: number | null
        value_id: string | null
        flag: number | null
        bin_item_id: string | null
        changeset_id: string | null
        summaries_done: number
        origin: string
      }>`
        SELECT kind, target_id, slot_id, slot_depth, value_id, flag, bin_item_id, changeset_id, summaries_done, origin
        FROM (
          SELECT o.*, row_number() OVER (PARTITION BY o.kind, o.target_id ORDER BY l.key, o.seq DESC) AS n
          FROM json_each(${JSON.stringify(inherited)}) l
            JOIN fork_overrides o ON o.fork_id = l.value ->> 0 AND o.seq <= l.value ->> 1
        ) WHERE n = 1`
      for (const row of rows)
        yield* sql`INSERT INTO fork_overrides ${sql.insert({
          id: uuidv7(),
          chat_id: fork.chatId,
          fork_id: id,
          seq: branchedAt,
          ...row
        })}`
    }
    const [row] = yield* sql<ForkRow>`SELECT * FROM forks WHERE id = ${id}`
    return row!
  })

/**
 * A version's own columns as `toVersion` reads them, for version `v` shown in place of `o`, one
 * of its message's own (itself, or the version a fork's copy `v` stands in for): its position
 * in the picker is the original's, and its star and picker flag are the fork's on the original,
 * the rows `sf` and `pf` (null: none), else their own.
 */
export const shownVersionColumns = `v.id, v.slot_id, o.ordinal, v.status, v.speaker_entity_id, v.writer, v.content,
  v.macro_mode, v.origin, v.source_version_id, v.direction, coalesce(pf.flag, v.hidden) AS hidden,
  coalesce(sf.flag, v.starred) AS starred, v.created_at, v.error_json, v.mark, v.frozen_macros, v.rollout_id,
  v.reasoning, ${versionExtras("v")}`

/** Joins version `o`, one of a message's own, to what fork `fork` shows for it (`v`) and the fork's flags on it. */
export const shownJoin = (sql: SqlClient.SqlClient, fork: string | null) => sql`
  LEFT JOIN fork_overrides ro ON ro.id = ${effectiveOverride(sql, "replace", fork, "o.id")}
  JOIN versions v ON v.id = coalesce(ro.value_id, o.id)
  LEFT JOIN fork_overrides sf ON sf.id = ${effectiveOverride(sql, "star", fork, "o.id")}
  LEFT JOIN fork_overrides pf ON pf.id = ${effectiveOverride(sql, "picker_hide", fork, "o.id")}`

/** Version `versionId` as fork `fork` shows it in its place (`shownVersionColumns`), live or not; null if none. */
export const versionAsShown = (sql: SqlClient.SqlClient, fork: string, versionId: string) =>
  Effect.map(
    sql<VersionRow>`
      SELECT ${sql.literal(shownVersionColumns)} FROM versions x JOIN versions o ON o.id = ${sql.literal(originalSql("x"))}
        ${shownJoin(sql, fork)}
      WHERE x.id = ${versionId}`,
    ([row]) => row ?? null
  )
