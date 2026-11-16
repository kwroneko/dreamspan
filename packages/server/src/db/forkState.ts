// What belongs to a fork rather than to a message (spec/FORK-INDEPENDENCE-DELTA.md §2.2;
// schema/forkOverrides.ts). A fork G sees its own overrides, its parent's with seq up to
// when G was made, its grandparent's up to when the parent was made, and so on: its lineage.
// The effective value of a key in G is the nearest lineage entry with a row for it, the newest
// row there; without one, the base column. Fork labels (db/forkLabels.ts, spec/FORK-COST.md)
// index that as a step function, so each lookup is one index probe, whatever G's depth or the
// chat's number of forks, and making a fork copies nothing.
import { stateKeys } from "@rp/shared/state.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Context, Effect } from "effect"
import type { SqlClient, Statement } from "effect/sql"
import { forkThrough } from "./forks.ts"
import { endSql, pointSql } from "./forkLabels.ts"
import { type ForkRow, versionExtras, type VersionRow } from "./rows.ts"

/**
 * The fork a read without a fork of its own is in, provided once per operation (`atLeaf`,
 * `inFork`). Null: none was, and each read takes the fork through its slot (`viewAt`).
 */
const ForkView = Context.Reference<string | null>("rp/ForkView", { defaultValue: () => null })

/** A fork: an id bound as a parameter, or an SQL expression (`sql.literal("c.current_fork_id")`). */
export type ForkRef = string | null | Statement.Fragment

/** SQL: the step of `kind` for `target` in force at fork `fork`'s point: one probe of `fork_steps`. */
const stepSql = (
  kind: string,
  fork: string,
  target: string,
  point = pointSql(fork)
) => `(SELECT fx_s.override_id FROM fork_steps fx_s
    WHERE fx_s.kind = '${kind}' AND fx_s.target_id = ${target} AND fx_s.label <= ${point}
    ORDER BY fx_s.label DESC LIMIT 1)`

/**
 * SQL: the id of the effective override of `kind` for `target` in the fork `fork` (both SQL
 * expressions, which can't name tables aliased `fx_*`), or null: one probe of `fork_steps` at
 * the fork's point (db/forkLabels.ts). A `hide` is the slot's own or that of a published LCM
 * range holding it (`hide_range`), each one probe; the one written nearest the fork wins (the
 * writer with the longer base is the deeper one in the lineage), the newest of one writer's.
 */
export const effectiveOverrideSql = (kind: string, fork: string, target: string, point?: string) => {
  if (kind !== "hide") return stepSql(kind, fork, target, point)
  return `(SELECT id FROM (
    SELECT fx_o.id, length(fx_ol.base) AS depth, fx_o.seq FROM fork_overrides fx_o
      JOIN fork_labels fx_ol ON fx_ol.fork_id = fx_o.fork_id
    WHERE fx_o.id = ${stepSql("hide", fork, target, point)}
    UNION ALL
    SELECT fx_o.id, length(fx_ol.base) AS depth, fx_o.seq
    FROM lcm_enable_slots fx_es JOIN lcm_enable_runs fx_er ON fx_er.id = fx_es.run_id
      CROSS JOIN fork_overrides fx_o JOIN fork_labels fx_ol ON fx_ol.fork_id = fx_o.fork_id
    WHERE fx_es.slot_id = ${target} AND fx_es.shown = 1 AND fx_er.published = 1
      AND fx_o.id = ${stepSql("hide_range", fork, "fx_es.run_id", point)}
  ) ORDER BY depth DESC, seq DESC LIMIT 1)`
}

/**
 * SQL: whether slot `s` is deleted in the fork `fork`: marked on the slot (before forks, or
 * because no live fork showed it, `markUnseen` in bin.ts), emptied for good, or deleted in the
 * fork's own view (`delete_slot`). A flag of 0 is a restore.
 */
export const slotDeletedInSql = (fork: string, s: string, point?: string) =>
  `(${s}.deleted_at IS NOT NULL OR ${s}.purged_at IS NOT NULL OR coalesce((SELECT flag FROM fork_overrides
    WHERE id = ${effectiveOverrideSql("delete_slot", fork, `${s}.id`, point)}), 0) = 1)`

/** SQL: whether version `o`, one of a message's own versions, is deleted in the fork `fork` (`slotDeletedInSql`'s rule). */
export const versionDeletedInSql = (fork: string, o: string) =>
  `(${o}.deleted_at IS NOT NULL OR ${o}.purged_at IS NOT NULL OR coalesce((SELECT flag FROM fork_overrides
    WHERE id = ${effectiveOverrideSql("delete_version", fork, `${o}.id`)}), 0) = 1)`

/** SQL: whether version `v`, one a fork shows (a message's own, or the copy standing in for it), is deleted in `fork`. */
const shownVersionDeletedInSql = (fork: string, v: string) =>
  `(${v}.deleted_at IS NOT NULL OR ${v}.purged_at IS NOT NULL OR coalesce((SELECT flag FROM fork_overrides
    WHERE id = ${effectiveOverrideSql("delete_version", fork, originalSql(v))}), 0) = 1)`

/** `shownVersionDeletedInSql` for a fork bound as a parameter or given as a fragment. */
export const shownVersionDeletedIn = (sql: SqlClient.SqlClient, fork: ForkRef, v: string) =>
  withFork(sql, fork, (f) => shownVersionDeletedInSql(f, v))

/** SQL: the version slot `s` shows in the fork `fork` (an SQL expression): its selection there, else its own. */
export const selectedInSql = (fork: string, s: string) =>
  `coalesce((SELECT value_id FROM fork_overrides WHERE id = ${effectiveOverrideSql("select", fork, `${s}.id`)}),
    ${s}.selected_version_id)`

/**
 * SQL from `FROM` on: the chat's versions being written now. Through the partial index of
 * generating versions: with covering slot/version indexes, the planner otherwise walks every
 * version of the chat (360 ms for 170,000 versions).
 */
export const generatingIn = (sql: SqlClient.SqlClient, chatId: string) =>
  sql`versions v INDEXED BY versions_generating CROSS JOIN slots s ON s.id = v.slot_id
    WHERE v.status = 'generating' AND s.chat_id = ${chatId}`

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
 * replacement override `sr_` of what that selects, each one probe (`effectiveOverrideSql`).
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
export const withFork = (sql: SqlClient.SqlClient, fork: ForkRef, sqlText: (fork: string) => string) => {
  const [first, ...rest] = sqlText("\u0000").split("\u0000")
  return rest.reduce((statement, part) => sql`${statement}${fork}${sql.literal(part)}`, sql`${sql.literal(first!)}`)
}

/** `effectiveOverrideSql` for a fork bound as a parameter or given as a fragment. */
export const effectiveOverride = (sql: SqlClient.SqlClient, kind: string, fork: ForkRef, target: string) =>
  withFork(sql, fork, (f) => effectiveOverrideSql(kind, f, target))

/**
 * SQL: whether the fork `fork` took image `media` (a media id) of version `o`, one of its
 * message's own, out of the context (an `image_exclude` override with flag 1). A copy's images
 * are its original's, so an amend keeps the choice for the images it keeps.
 */
export const imageExcludedSql = (fork: string, o: string, media: string) =>
  `coalesce((SELECT flag FROM fork_overrides WHERE id = ${effectiveOverrideSql("image_exclude", fork, `${o} || ':' || ${media}`)}), 0) = 1`

/** `imageExcludedSql` for a fork bound as a parameter or given as a fragment. */
export const imageExcludedIn = (sql: SqlClient.SqlClient, fork: ForkRef, o: string, media: string) =>
  withFork(sql, fork, (f) => imageExcludedSql(f, o, media))

/** The override target of image `mediaId` of version `original`, one of its message's own. */
export const imageTarget = (original: string, mediaId: string) => `${original}:${mediaId}`

/**
 * SQL: which of version `o`'s thinking (one of its message's own versions) the fork `fork`
 * hid from the model (`thinking_hide` overrides with flag 1, SetThinkingHidden): 1 the
 * provider's reasoning, 2 the thinking captured from the reply, 3 both, 0 neither. A copy's
 * thinking is its original's, so an amend keeps the choice, as it does an image's.
 */
export const thinkingHiddenSql = (fork: string, o: string) =>
  `(coalesce((SELECT flag FROM fork_overrides WHERE id = ${effectiveOverrideSql("thinking_hide", fork, `${o} || ':reasoning'`)}), 0)
    + 2 * coalesce((SELECT flag FROM fork_overrides WHERE id = ${effectiveOverrideSql("thinking_hide", fork, `${o} || ':sections'`)}), 0))`

/** `thinkingHiddenSql` for a fork bound as a parameter or given as a fragment. */
export const thinkingHiddenIn = (sql: SqlClient.SqlClient, fork: ForkRef, o: string) =>
  withFork(sql, fork, (f) => thinkingHiddenSql(f, o))

/** The override target of version `original`'s thinking `part`, one of its message's own. */
export const thinkingTarget = (original: string, part: "reasoning" | "sections") => `${original}:${part}`

/** `slotDeletedInSql` for a fork bound as a parameter or given as a fragment. */
export const slotDeletedIn = (sql: SqlClient.SqlClient, fork: ForkRef, s: string) =>
  withFork(sql, fork, (f) => slotDeletedInSql(f, s))

/** `versionDeletedInSql` for a fork bound as a parameter or given as a fragment. */
export const versionDeletedIn = (sql: SqlClient.SqlClient, fork: ForkRef, o: string) =>
  withFork(sql, fork, (f) => versionDeletedInSql(f, o))

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
const atLeaf =
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
export const nextSeq = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.map(
    sql<{ seq: number }>`UPDATE chats SET state_seq = state_seq + 1 WHERE id = ${chatId} RETURNING state_seq AS seq`,
    ([row]) => row!.seq
  )

/**
 * A slot's selection in a fork, the version shown for it there (its replacement, if any), and
 * the newest seq of its selection, replacement, deletion and visibility overrides (0: the
 * slot's own), matching path entries' optimistic row version. Every per-fork write takes a
 * newer seq, so the seq only grows with the fork's own choices.
 */
export const selectionIn = (sql: SqlClient.SqlClient, forkId: string | null, slotId: string) =>
  Effect.map(
    sql<{ version_id: string; shown_id: string; seq: number }>`
      SELECT coalesce(o.value_id, s.selected_version_id) AS version_id,
        coalesce(r.value_id, o.value_id, s.selected_version_id) AS shown_id,
        max(coalesce(o.seq, 0), coalesce(r.seq, 0), coalesce(d.seq, 0), coalesce(h.seq, 0)) AS seq
      FROM slots s LEFT JOIN fork_overrides o ON o.id = ${effectiveOverride(sql, "select", forkId, "s.id")}
        LEFT JOIN fork_overrides r
          ON r.id = ${effectiveOverride(sql, "replace", forkId, "coalesce(o.value_id, s.selected_version_id)")}
        LEFT JOIN fork_overrides d ON d.id = ${effectiveOverride(sql, "delete_slot", forkId, "s.id")}
        LEFT JOIN fork_overrides h ON h.id = ${effectiveOverride(sql, "hide", forkId, "s.id")}
      WHERE s.id = ${slotId}`,
    ([row]) => row ?? null
  )

/** A row of what a fork changes, by kind: what it's about and its value (schema/forkOverrides.ts). */
interface OverrideValue {
  readonly kind:
    | "select"
    | "replace"
    | "star"
    | "picker_hide"
    | "delete_slot"
    | "delete_version"
    | "hide"
    | "suppress_event"
    | "image_exclude"
    | "thinking_hide"
    | "summary_revision"
    | "summary_choice"
    | "summary_rerun"
    | "summary_superseded"
    | "insert"
    | "move"
    | "presence_range"
  readonly targetId: string
  readonly slotId: string | null
  readonly valueId: string | null
  readonly flag: number | null
  /** The bin item of a deletion, which a restore names. */
  readonly binItemId?: string | null
  readonly summariesDone?: boolean
  readonly changesetId?: string | null
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
        bin_item_id = ${value.binItemId ?? null}, summaries_done = ${value.summariesDone ? 1 : 0}, changeset_id = ${value.changesetId === undefined ? sql.literal("changeset_id") : value.changesetId}, origin = ${origin} WHERE id = ${own.id}`
      return seq
    }
    yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id, flag,
        bin_item_id, summaries_done, changeset_id, origin)
      VALUES (${uuidv7()}, ${fork.chatId}, ${fork.id}, ${seq}, ${value.kind}, ${value.targetId}, ${value.slotId},
        (SELECT depth FROM slots WHERE id = ${value.slotId}), ${value.valueId}, ${value.flag}, ${value.binItemId ?? null}, ${value.summariesDone ? 1 : 0}, ${value.changesetId ?? null}, ${origin})`
    return seq
  })

/**
 * Fork `fork` places inserted slot `slotId` below its anchor (flag 1), or doesn't (0), from
 * now on (`writeOverride`; spec/MESSAGE-INSERT.md §2.2). The row names the anchor, its parent.
 */
export const writeInsert = (
  sql: SqlClient.SqlClient,
  fork: { readonly id: string; readonly chatId: string },
  slotId: string,
  flag: 0 | 1
) =>
  Effect.gen(function* () {
    const [slot] = yield* sql<{ anchor: string | null }>`
      SELECT parent_slot_id AS anchor FROM slots WHERE id = ${slotId} AND chat_id = ${fork.chatId}`
    if (slot === undefined) return yield* new NotFound({ entity: "slot", id: slotId })
    return yield* writeOverride(sql, fork, {
      kind: "insert",
      targetId: slotId,
      slotId: slot.anchor,
      valueId: null,
      flag
    })
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
 * A new fork of `parent`, made now: one `forks` row, which the label trigger places in the fork
 * tree below the parent's point (db/forkLabels.ts). It sees the parent's rows up to the chat's
 * state seq now and nothing the parent writes later. Copies nothing, whatever the history.
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
    const [row] = yield* sql<ForkRow>`
      INSERT INTO forks (id, chat_id, parent_fork_id, branched_at, base_slot_id, tip_slot_id, created_at)
      SELECT ${id}, ${fork.chatId}, ${fork.parent.id}, state_seq, ${fork.baseSlotId}, ${fork.tipSlotId}, ${fork.at}
      FROM chats WHERE id = ${fork.chatId}
      RETURNING *`
    return row!
  })

/**
 * A version's own columns as `toVersion` reads them, for version `v` shown in place of `o`, one
 * of its message's own (itself, or the version a fork's copy `v` stands in for): its position
 * in the picker is the original's, and its star and picker flag are the fork's on the original,
 * the rows `sf` and `pf` (null: none), else their own.
 */
export const shownVersionColumns = `v.id, v.slot_id, o.ordinal, v.status, v.speaker_entity_id, v.speaker_pick_json, v.writer, v.content,
  v.macro_mode, v.origin, v.source_version_id, v.direction, coalesce(pf.flag, v.hidden) AS hidden,
  coalesce(sf.flag, v.starred) AS starred, v.created_at, v.error_json, v.mark, v.frozen_macros, v.rollout_id,
  v.reasoning, v.reply_sections, v.rewrite_json, v.recorded_model_json,
  v.recorded_generation_json, v.raw_content IS NOT NULL AS raw_kept,
  v.raw_reasoning IS NOT NULL AS raw_reasoning_kept, v.raw_sections IS NOT NULL AS raw_sections_kept,
  ${versionExtras("v")}`

/** Joins version `o`, one of a message's own, to what fork `fork` shows for it (`v`) and the fork's flags on it. */
export const shownJoin = (sql: SqlClient.SqlClient, fork: string | null) => sql`
  LEFT JOIN fork_overrides ro ON ro.id = ${effectiveOverride(sql, "replace", fork, "o.id")}
  JOIN version_records v ON v.id = coalesce(ro.value_id, o.id)
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

/**
 * SQL: whether a row written in fork `writer` at `label` (SQL expressions) is in fork `fork`'s
 * lineage: the writer is `fork` or one it was made from (directly or not) after the row was
 * written. Two comparisons of labels (db/forkLabels.ts).
 */
export const labelVisibleSql = (fork: string, writer: string, label: string) =>
  `(${label} <= ${pointSql(fork)} AND ${pointSql(fork)} < ${endSql(writer)})`

/** An event is shared state, or was written within this fork's lineage. */
const eventVisibleSql = (fork: string, e: string) =>
  `(${e}.fork_id IS NULL OR ${labelVisibleSql(fork, `${e}.fork_id`, `${e}.fork_label`)})`

/** Visibility and per-fork undo apply in every state reader. */
export const eventAppliesSql = (fork: string, e: string) => `(${eventVisibleSql(fork, e)}
  AND ${e}.superseded_by_changeset IS NULL AND coalesce((SELECT flag FROM fork_overrides
    WHERE id = ${effectiveOverrideSql("suppress_event", fork, `${e}.id`)}), 0) = 0)`

export const eventApplies = (sql: SqlClient.SqlClient, fork: ForkRef, e: string) =>
  withFork(sql, fork, (f) => eventAppliesSql(f, e))

/**
 * Positional events first, by `position` (their slot's depth; the display position, read by
 * `displayEvents`, in a fork with insertions); every registered branch-owned key last, in chat
 * sequence order.
 */
export const eventOrder = (e: string, position = `${e}.slot_depth`) => {
  const keys = stateKeys
    .list()
    .filter((key) => key.scope === "branch")
    .map((key) => `'${key.id.replaceAll("'", "''")}'`)
  const branch = keys.length === 0 ? "0" : `${e}.key IN (${keys.join(",")})`
  return `CASE WHEN ${branch} THEN 1 ELSE 0 END,
    coalesce(${position}, -1), CASE WHEN ${branch} THEN coalesce(${e}.fork_seq, ${e}.seq) ELSE ${e}.seq END`
}
