import { factRowCharacters } from "./lcmFactWeight.ts"
import { factStore } from "./lcmFactStore.ts"
import { lineageCache } from "./lcmLineageCache.ts"
import { BaseViews, messageView } from "./lcmBaseView.ts"
import { pathSegments } from "./pathSegments.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { ContextDisplay } from "@rp/shared/inspectorApi.ts"
import type { WireContext } from "../assembler/types.ts"
import { tokensOf } from "../assembler/st.ts"
import { toLlmRequest, type LlmRequestRow } from "./providers.ts"
import { inSummaryFork } from "./lcmFork.ts"
import { effectiveOverride } from "./forkState.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { Summary, SummaryAttempt, SummaryDetails } from "@rp/shared/lcm.ts"
import { shownIn, shownVersionDeletedIn, slotDeletedIn, viewAt } from "./forkState.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Context, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"
import { positionOf, showsMoves } from "./displayPath.ts"
import { lcmView, type LcmView, placesOf, positionIn } from "./lcmDisplay.ts"
import { imagesMatch } from "./lcmImages.ts"
import { audienceIds, knownVersions } from "./lcmAudience.ts"

const summaryRows = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  ids: ReadonlyArray<string>,
  fork: string | null,
  revision?: string
) =>
  sql<{
    replacement: number
    choice: number
    superseded: number
    base_revision_valid: number
    id: Summary["id"]
    chat_id: Summary["chatId"]
    level: number
    first_slot_id: Summary["firstSlotId"]
    last_slot_id: Summary["lastSlotId"]
    slot_count: number
    selected_revision_id: string
    row_version: number
    status: Summary["status"]
    error_json: string | null
    batch_id: string | null
    content: string
    token_count: number
    origin: Summary["origin"]
    revision_rollout_id: string | null
    revision_id: Summary["revisionId"]
    revision_number: number
    first_depth: number
    last_depth: number
    first_chain: string
    last_chain: string
    images_json: string | null
    audience_json: string | null
  }>`SELECT s.*, EXISTS(SELECT 1 FROM summary_revisions br WHERE br.id=s.selected_revision_id AND br.summary_id=s.id) AS base_revision_valid, max(s.row_version,coalesce(ro.seq,0),coalesce(co.seq,0)) AS row_version, r.id AS revision_id, r.rollout_id AS revision_rollout_id, r.content, r.token_count, r.origin,
            EXISTS(SELECT 1 FROM summarization_jobs j JOIN summaries rs ON rs.id=j.result_summary_id
              WHERE j.source_summary_id=s.id AND j.source_revision_id=r.id AND (j.fork_id IS NULL OR j.fork_id=${fork})
                AND j.explicit_requested=1 AND j.status='complete' AND rs.status IN ('complete','truncated')) AS replacement,
            EXISTS(SELECT 1 FROM lcm_summary_choices bc LEFT JOIN fork_overrides bo ON bo.id=${effectiveOverride(sql, "summary_choice", fork, "s.id")}
              WHERE bc.summary_id=s.id AND coalesce(bo.value_id,bc.chosen_id,s.id)<>s.id)
              OR coalesce(co.value_id,s.id)<>s.id AS choice,
            EXISTS(SELECT 1 FROM fork_overrides so WHERE so.id=${effectiveOverride(sql, "summary_superseded", fork, "s.id")}) AS superseded,
            (SELECT count(*) FROM summary_revisions p WHERE p.summary_id = s.id AND p.seq <= r.seq) AS revision_number, a.depth AS first_depth, b.depth AS last_depth, a.chain_id AS first_chain, b.chain_id AS last_chain
          FROM json_each(${JSON.stringify(ids)}) requested CROSS JOIN summaries s ON s.id=requested.value
          JOIN chats c ON c.id = s.chat_id
          LEFT JOIN fork_overrides ro ON ro.id=${effectiveOverride(sql, "summary_revision", fork, "s.id")}
          LEFT JOIN fork_overrides co ON co.id=${effectiveOverride(sql, "summary_choice", fork, "s.id")}
          JOIN summary_revisions r ON r.summary_id = s.id AND r.id = coalesce(${revision ?? null}, ro.value_id, s.selected_revision_id)
          JOIN slots a ON a.id = s.first_slot_id JOIN slots b ON b.id = s.last_slot_id
          WHERE s.sealed = 1 AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`

const inputRowsGeneric = (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<string>,
  fork: string | null,
  summaryEdit?: { changeset_id: string; application: string },
  base = false
) =>
  sql<{
    summary_id: string
    ordinal: number
    parent_slot_id: string | null
    chain_id?: string
    depth?: number
    version_valid: number
    slot_id: string
    version_id: string | null
    amend_count: number
    effective: string | null
    current_amends: number
    replaced_with_summaries: number
  }>`
        SELECT i.*, s.parent_slot_id, s.chain_id, s.depth, ${base ? sql`CASE WHEN i.version_id IS NULL OR i.version_id=s.selected_version_id THEN 1 ELSE EXISTS(SELECT 1 FROM versions iv WHERE iv.id=i.version_id AND iv.slot_id=i.slot_id) END` : sql`(i.version_id IS NULL OR iv.slot_id=i.slot_id)`} AS version_valid, ${
          base
            ? sql`0`
            : sql`EXISTS(SELECT 1 FROM fork_overrides o WHERE o.id=${effectiveOverride(sql, "replace", fork, "CASE WHEN iv.fork_id IS NULL THEN i.version_id ELSE iv.source_version_id END")}
          AND o.value_id=v.id AND o.summaries_done=1 AND EXISTS (
            SELECT 1 FROM changeset_items ci INDEXED BY changeset_items_after_version, json_each(ci.after_json, '$.preservedInputs') p
            WHERE ci.changeset_id=o.changeset_id AND ci.target_kind='version_replace'
              AND ci.target_id=o.target_id AND ci.after_json ->> '$.id'=v.id
              AND p.value ->> '$.id'=i.version_id AND p.value ->> '$.amends'=i.amend_count
              AND (json_type(p.value, '$.summaryIds') IS NULL OR EXISTS (
                SELECT 1 FROM json_each(p.value, '$.summaryIds') kept WHERE kept.value=i.summary_id))
              -- Agent edits preserve only the summaries actually rewritten with this input.
              -- Naming an unrelated summary cannot certify every dependent summary.
              AND (NOT EXISTS (SELECT 1 FROM changesets ac WHERE ac.id=ci.changeset_id AND ac.origin='agent')
                OR (ci.changeset_id=${summaryEdit?.changeset_id ?? null}
                  AND ci.after_json ->> '$.applicationId'=${summaryEdit?.application ?? null}))))`
        } AS replaced_with_summaries, CASE WHEN NOT ${base ? sql`(s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL)` : slotDeletedIn(sql, fork, "s")} AND ${base ? sql`s.context_excluded` : contextExcludedIn(sql, fork)} = 0
          AND NOT ${base ? sql`(v.deleted_at IS NOT NULL OR v.purged_at IS NOT NULL)` : shownVersionDeletedIn(sql, fork, "v")} AND v.status NOT IN ('generating', 'failed') AND v.content_length > 0
          THEN v.id ELSE NULL END AS effective, (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS current_amends
        FROM summary_inputs i JOIN slots s ON s.id = i.slot_id ${base ? sql`` : sql`LEFT JOIN versions iv ON iv.id=i.version_id`} LEFT JOIN versions v INDEXED BY versions_lcm_inputs ON v.id = ${base ? sql`s.selected_version_id` : shownIn(sql, fork, "s")}
        WHERE i.summary_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) ORDER BY i.summary_id,i.ordinal`

// Resolve ordinary per-fork message choices once, instead of repeating fork_steps probes
// for every input. Published hide ranges and preservation applications keep their full proof.
const inputRows = (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<string>,
  fork: string | null,
  summaryEdit?: { changeset_id: string; application: string },
  base = false,
  overrides?: string
) =>
  overrides === undefined
    ? inputRowsGeneric(sql, ids, fork, summaryEdit, base)
    : sql<InputRow>`
  WITH choices AS MATERIALIZED (
    SELECT value ->> '$.kind' AS kind,value ->> '$.target_id' AS target_id,
      value ->> '$.value_id' AS value_id,value ->> '$.flag' AS flag FROM json_each(${overrides})
  ) SELECT i.*,s.parent_slot_id,s.chain_id,s.depth,
    CASE WHEN i.version_id IS NULL OR i.version_id=v.id THEN 1 ELSE EXISTS(SELECT 1 FROM versions iv WHERE iv.id=i.version_id AND iv.slot_id=i.slot_id) END AS version_valid,
    0 AS replaced_with_summaries,
    CASE WHEN s.deleted_at IS NULL AND s.purged_at IS NULL AND coalesce(ds.flag,0)=0 AND coalesce(h.flag,s.context_excluded)=0
      AND v.deleted_at IS NULL AND v.purged_at IS NULL AND coalesce(dv.flag,0)=0
      AND v.status NOT IN ('generating','failed') AND v.content_length>0 THEN v.id END AS effective,
    (SELECT count(*) FROM version_history h WHERE h.version_id=v.id) AS current_amends
  FROM json_each(${JSON.stringify(ids)}) requested CROSS JOIN summary_inputs i ON i.summary_id=requested.value
    JOIN slots s ON s.id=i.slot_id
    LEFT JOIN choices so ON so.kind='select' AND so.target_id=s.id
    LEFT JOIN choices ro ON ro.kind='replace' AND ro.target_id=coalesce(so.value_id,s.selected_version_id)
    LEFT JOIN versions v ON v.id=coalesce(ro.value_id,so.value_id,s.selected_version_id)
    LEFT JOIN choices ds ON ds.kind='delete_slot' AND ds.target_id=s.id
    LEFT JOIN choices h ON h.kind='hide' AND h.target_id=s.id
    LEFT JOIN choices dv ON dv.kind='delete_version' AND dv.target_id=CASE WHEN v.fork_id IS NULL THEN v.id ELSE v.source_version_id END
  ORDER BY i.summary_id,i.ordinal`

// One row per summary crosses the driver, rather than one object per message input.
const summaryInputs = (...args: Parameters<typeof inputRows>) => {
  const sql = args[0]
  return Effect.map(
    sql<{ summary_id: string; inputs_json: string }>`SELECT summary_id,json_group_array(json_array(
      ordinal,slot_id,version_id,amend_count,parent_slot_id,version_valid,effective,current_amends,replaced_with_summaries)) AS inputs_json
      FROM (${inputRows(...args)}) GROUP BY summary_id`,
    (rows) =>
      rows.flatMap((r) =>
        (
          JSON.parse(r.inputs_json) as Array<
            [number, string, string | null, number, string | null, number, string | null, number, number]
          >
        ).map(
          ([
            ordinal,
            slot_id,
            version_id,
            amend_count,
            parent_slot_id,
            version_valid,
            effective,
            current_amends,
            replaced_with_summaries
          ]): InputRow => ({
            summary_id: r.summary_id,
            ordinal,
            slot_id,
            version_id,
            amend_count,
            parent_slot_id,
            version_valid,
            effective,
            current_amends,
            replaced_with_summaries
          })
        )
      )
  )
}

const summaryProofs = (...args: Parameters<typeof inputRows>) => {
  const sql = args[0]
  return sql<{ summary_id: string; count: number; valid: number | null; fresh: number }>`WITH proofs AS MATERIALIZED (
    SELECT i.summary_id,count(*) AS count,
      min(i.chain_id)=max(i.chain_id) AS one_chain,
      min(coalesce(i.version_valid,0)) AND min(i.ordinal)=0 AND max(i.ordinal)=count(*)-1
        AND min(i.depth-i.ordinal)=max(i.depth-i.ordinal) AS ordered,
      min(CASE WHEN i.version_id IS i.effective THEN i.version_id IS NULL OR i.amend_count=i.current_amends
        WHEN i.replaced_with_summaries=1 AND i.effective IS NOT NULL THEN i.current_amends=0 ELSE 0 END) AS fresh
    FROM (${inputRows(...args)}) i GROUP BY i.summary_id
  ) SELECT p.summary_id,p.count,p.fresh,
    CASE WHEN p.one_chain THEN p.ordered
      AND (SELECT slot_id FROM summary_inputs i WHERE i.summary_id=p.summary_id AND i.ordinal=0)=m.first_slot_id
      AND (SELECT slot_id FROM summary_inputs i WHERE i.summary_id=p.summary_id AND i.ordinal=p.count-1)=m.last_slot_id
    ELSE NULL END AS valid
    FROM proofs p JOIN summaries m ON m.id=p.summary_id`
}

const freshInputs = (...args: Parameters<typeof inputRows>) => {
  const sql = args[0]
  return sql<{
    summary_id: string
    count: number
    valid: number | null
    fresh: number
  }>`SELECT i.summary_id,count(*) AS count,NULL AS valid,
    min(CASE WHEN i.version_id IS i.effective THEN i.version_id IS NULL OR i.amend_count=i.current_amends
      WHEN i.replaced_with_summaries=1 AND i.effective IS NOT NULL THEN i.current_amends=0 ELSE 0 END) AS fresh
    FROM (${inputRows(...args)}) i GROUP BY i.summary_id`
}

const summaryChildren = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>) =>
  sql<{
    summary_id: string
    ordinal: number
    parent_id: Summary["id"]
    parent_revision_id: Summary["revisionId"]
    previous: string | null
    level: number
    first_slot_id: string
    last_slot_id: string
    slot_count: number
    chat_id: string
    status: string
    revision_valid: number
  }>`SELECT p.*, a.parent_slot_id AS previous, c.level,c.first_slot_id,c.last_slot_id,c.slot_count,c.chat_id,c.status,
      EXISTS(SELECT 1 FROM summary_revisions r WHERE r.id=p.parent_revision_id AND r.summary_id=c.id) AS revision_valid
    FROM summary_parents p LEFT JOIN summaries c ON c.id=p.parent_id LEFT JOIN slots a ON a.id=c.first_slot_id
    WHERE p.summary_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) ORDER BY p.ordinal`

const decodeSummary = Schema.decodeUnknownSync(Summary)

type SummaryRow = Effect.Success<ReturnType<typeof summaryRows>>[number]
type InputRow = Effect.Success<ReturnType<typeof inputRowsGeneric>>[number]
type ChildRow = Effect.Success<ReturnType<typeof summaryChildren>>[number]
interface SummaryFacts {
  readonly fork: string | null
  readonly view?: LcmView
  readonly rows: Map<string, SummaryRow>
  readonly proofs: Map<string, { count: number; valid: number | null; fresh: number }>
  readonly inputs: Map<string, ReadonlyArray<InputRow>>
  readonly children: Map<string, ReadonlyArray<ChildRow>>
}

/**
 * What one storage operation has read of summaries so far, when it keeps it (`readingOnce`):
 * each summary as a fork without insertions shows it, by fork and id, and whether a summary's
 * stored lineage holds (`lineageValidator`, fork-independent there). A reply's plan reads the
 * layer, assembles and maintains, each reading the same summaries; this reads each once.
 */
interface SummaryReadMemo {
  readonly summaries: Map<string, Summary>
  readonly projections: Map<string, Summary>
  readonly valid: Map<string, boolean>
  readonly layers: Map<string, { summaries: Array<Summary>; cursor: Summary["lastSlotId"] | null; cursorDepth: number }>
  readonly facts: Array<SummaryFacts>
  readonly commit: Array<() => void>
  /**
   * By fork and id: what a level-1 summary's range sends on the path, as maintenance signs it
   * (db/lcmMaintain.ts). Kept with the fork's facts: every slot of the range is an input, so the
   * LCM stamp moves with any change to it.
   */
  readonly ranges: Map<string, unknown>
}
export const SummaryReads = Context.Reference<SummaryReadMemo | null>("rp/SummaryReads", { defaultValue: () => null })

type Proof = { count: number; valid: number | null; fresh: number }
/** A path's summaries as kept for its leaf: those ending on it, with the summaries they pin. */
interface KeptLeaf {
  readonly leaf: string
  readonly chain: string
  readonly depth: number
  readonly ids: ReadonlyArray<string>
}
/**
 * What a connection keeps of one fork's summaries while the chat's LCM stamp holds
 * (db/lcmFactStore.ts): each fact is the fork's view of one summary, whatever the leaf, so a
 * plan at another leaf of the fork reads only the summaries the kept ones lack.
 */
interface KeptFacts {
  readonly rows: ReadonlyMap<string, SummaryRow>
  readonly proofs: ReadonlyMap<string, Proof>
  readonly inputs: ReadonlyMap<string, ReadonlyArray<InputRow>>
  readonly children: ReadonlyMap<string, ReadonlyArray<ChildRow>>
  /** Summaries whose freshness folds from these facts alone (no audience, images or application). */
  readonly pure: ReadonlySet<string>
  readonly valid: ReadonlyMap<string, boolean>
  /** By summary id: projections, and full summaries, of pure summaries only. */
  readonly projections: ReadonlyMap<string, Summary>
  readonly summaries: ReadonlyMap<string, Summary>
  readonly ranges: ReadonlyMap<string, unknown>
  /** The most recent leaves first, at most `KEPT_LEAVES`. */
  readonly leaves: ReadonlyArray<KeptLeaf>
  /** Every summary of the chat with a greater rowid was sealed after these were read. */
  readonly floor: number
  readonly characters: number
}
const KEPT_LEAVES = 4
const weightOf = factRowCharacters
const fullWeight = (summary: Summary) =>
  summary.inputs.reduce((n, input) => n + factRowCharacters(input), 64) +
  summary.children.reduce((n, child) => n + factRowCharacters(child), 0)

/** Runs `effect` keeping what it reads of summaries for the rest of it (`SummaryReads`). */
export const readingOnce = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SummaryReads, (kept) =>
    kept !== null
      ? effect
      : Effect.suspend(() => {
          const memo: SummaryReadMemo = {
            summaries: new Map(),
            projections: new Map(),
            valid: new Map(),
            facts: [],
            layers: new Map(),
            ranges: new Map(),
            commit: []
          }
          return Effect.provideService(
            Effect.tap(effect, () =>
              Effect.sync(() => {
                for (const save of memo.commit) save()
              })
            ),
            SummaryReads,
            memo
          ).pipe(Effect.provideService(BaseViews, new Map()))
        })
  )

/**
 * The summaries a path's layer can use and those they pin, as ids: every sealed summary ending on
 * the path to `leaf`, then their parts, recursively. With `kept`, only what the kept leaf nearest
 * up the path lacks is read: the summaries ending past it, and those sealed since (`top`).
 */
const pathSummaryIds = (
  sql: SqlClient.SqlClient,
  chatId: string,
  leaf: string,
  kept: KeptFacts | undefined,
  top: number
) =>
  Effect.gen(function* () {
    const closure = (ends: ReadonlyArray<string>) =>
      ends.length === 0
        ? Effect.succeed([] as Array<string>)
        : Effect.map(
            sql<{ id: string }>`WITH RECURSIVE wanted(id) AS (
              SELECT value FROM json_each(${JSON.stringify(ends)})
              UNION SELECT p.parent_id FROM wanted w CROSS JOIN summary_parents p ON p.summary_id=w.id
            ) SELECT id FROM wanted`,
            (rows) => rows.map((r) => r.id)
          )
    const [here] = yield* sql<{ chain_id: string; depth: number }>`SELECT chain_id,depth FROM slots
      WHERE id=${leaf} AND chat_id=${chatId}`
    const exact = kept?.leaves.find((l) => l.leaf === leaf)
    if (here && exact && top <= kept!.floor) return { here, ids: exact.ids }
    if (here && kept) {
      const segments = yield* sql<{ chain_id: string; lo: number; hi: number }>`${pathSegments(sql, chatId, leaf, null)}
        SELECT chain_id,lo,hi FROM segments`
      const onPath = (chain: string, depth: number) =>
        segments.some((g) => g.chain_id === chain && g.lo <= depth && depth <= g.hi)
      const base =
        exact ??
        kept.leaves
          .filter((l) => l.depth <= here.depth && onPath(l.chain, l.depth))
          .reduce<KeptLeaf | undefined>((best, l) => (best === undefined || l.depth > best.depth ? l : best), undefined)
      if (base) {
        // Summaries ending past the kept leaf: only the segments reaching below its depth.
        const past =
          base.depth < here.depth
            ? (yield* sql<{ id: string }>`${pathSegments(sql, chatId, leaf, here.depth - base.depth)}
              SELECT s.id FROM segments g CROSS JOIN slots p ON p.chain_id=g.chain_id AND p.depth BETWEEN max(g.lo,g.floor) AND g.hi
                CROSS JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id=p.id
              WHERE s.chat_id=${chatId} AND s.sealed=1`).map((r) => r.id)
            : []
        const sealed =
          top > kept.floor
            ? (yield* sql<{ id: string; chain_id: string; depth: number }>`SELECT s.id,b.chain_id,b.depth
                FROM summaries s JOIN slots b ON b.id=s.last_slot_id
                WHERE s.chat_id=${chatId} AND s.rowid>${kept.floor} AND s.sealed=1`)
                .filter((r) => onPath(r.chain_id, r.depth))
                .map((r) => r.id)
            : []
        const known = new Set(base.ids)
        const added = (yield* closure([...past, ...sealed].filter((id) => !known.has(id)))).filter(
          (id) => !known.has(id)
        )
        return { here, ids: added.length ? [...base.ids, ...new Set(added)] : base.ids }
      }
    }
    // Find only endpoints on this path, then their pinned descendants. No full path is
    // materialized in JavaScript: ordered input/child parent links prove the same chains.
    const ids = (yield* sql<{ id: string }>` ${pathSegments(sql, chatId, leaf, null)}, wanted(id) AS (
      SELECT s.id FROM segments g CROSS JOIN slots p ON p.chain_id=g.chain_id AND p.depth BETWEEN g.lo AND g.hi
        CROSS JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id=p.id
        WHERE s.chat_id=${chatId} AND s.sealed=1
      UNION SELECT p.parent_id FROM wanted w CROSS JOIN summary_parents p ON p.summary_id=w.id
    ) SELECT id FROM wanted`).map((r) => r.id)
    return { here, ids }
  })

/** Batch the proofs for an ordinary primary path, reusing what this connection kept of its fork. */
export const primeSummaryReads = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, leaf: string) =>
  Effect.gen(function* () {
    const kept = yield* SummaryReads
    const fork = yield* viewAt(sql, chatId, leaf)
    if (!kept || kept.facts.some((f) => f.fork === fork)) return
    const view = yield* lcmView(sql, chatId, fork)
    if (view.pieces !== null) {
      // Display paths still use their independent lineage/freshness checks. Batch only
      // the database facts, scoped to this transaction, including inserted endpoints.
      const [last] = yield* sql<{
        id: string
        chain_id: string
        depth: number
      }>`SELECT id,chain_id,depth FROM slots WHERE id=${leaf} AND chat_id=${chatId}`
      const end = last ? positionOf(view.pieces, { id: last.id, chainId: last.chain_id, depth: last.depth }) : null
      const inserted = view.pieces.flatMap((p) =>
        p.kind !== "run" && end !== null && p.start <= end ? [p.slotId] : []
      )
      const ids = (yield* sql<{ id: string }>` ${pathSegments(sql, chatId, leaf, null)}, endpoints(id) AS (
        SELECT s.id FROM segments g CROSS JOIN slots s ON s.chain_id=g.chain_id AND s.depth BETWEEN g.lo AND g.hi
        UNION SELECT value FROM json_each(${JSON.stringify(inserted)})
      ), wanted(id) AS (
        SELECT s.id FROM endpoints e CROSS JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id=e.id
          WHERE s.chat_id=${chatId} AND s.sealed=1
        UNION SELECT p.parent_id FROM wanted w CROSS JOIN summary_parents p ON p.summary_id=w.id
      ) SELECT id FROM wanted`).map((r) => r.id)
      if (ids.length === 0) return
      const rows = yield* summaryRows(sql, userId, ids, fork)
      // Preservation proofs for changeset revisions depend on their application.
      const plain = rows.filter((r) => r.origin !== "changeset").map((r) => r.id)
      const inputs = plain.length ? yield* summaryInputs(sql, plain, fork) : []
      const children = yield* summaryChildren(
        sql,
        rows.map((r) => r.id)
      )
      const group = <A extends { summary_id: string }>(items: ReadonlyArray<A>, all: ReadonlyArray<string>) => {
        const groups = new Map(all.map((id) => [id, [] as Array<A>]))
        for (const item of items) groups.get(item.summary_id)!.push(item)
        return groups
      }
      kept.facts.push({
        fork,
        view,
        rows: new Map(rows.map((r) => [r.id, r])),
        proofs: new Map(),
        inputs: group(inputs, plain),
        children: group(
          children,
          rows.map((r) => r.id)
        )
      })
      return
    }
    const retained = yield* lineageCache<ChildRow>(sql)
    // Corruption fixtures with relaxed storage invariants keep the independent row-by-row proof.
    if (!retained) return
    const store = yield* factStore<KeptFacts>(sql, chatId, JSON.stringify([userId, chatId, fork]))
    const prior = store?.hit
    const { here, ids } = yield* pathSummaryIds(sql, chatId, leaf, prior, store?.top ?? 0)
    // Only summaries the kept facts lack are read; the kept ones are this fork's view of them still.
    const missing = prior ? ids.filter((id) => !prior.rows.has(id)) : ids
    const rows = missing.length ? yield* summaryRows(sql, userId, missing, fork) : []
    const stamp = (r: SummaryRow) =>
      JSON.stringify([
        r.chat_id,
        r.level,
        r.first_slot_id,
        r.last_slot_id,
        r.slot_count,
        r.selected_revision_id,
        r.status
      ])
    if (prior) for (const [id, data] of prior.valid) kept.valid.set(id, data)
    const cached = new Map(
      rows.flatMap((r) => {
        const entry = retained.get(r.id, stamp(r))
        if (entry?.valid !== undefined) kept.valid.set(r.id, entry.valid)
        return entry ? [[r.id as string, entry] as const] : []
      })
    )
    // Changeset preservation is tied to each revision's application. Keep its full per-row proof.
    const plain = rows.filter((r) => r.origin !== "changeset").map((r) => r.id)
    const pure = rows
      .filter((r) => r.origin !== "changeset" && r.audience_json === null && r.images_json === null)
      .map((r) => r.id)
    const pureIds = new Set<string>([...(prior?.pure ?? []), ...pure])
    const changes = rows.length ? yield* messageView(sql, fork) : []
    const base = changes.length === 0
    const simple = changes.every((r) => r.kind !== "hide_range" && (r.kind !== "replace" || r.summaries_done === 0))
    const overrideJson = simple && !base ? JSON.stringify(changes) : undefined
    const unproven = pure.filter((id) => cached.get(id)?.valid === undefined)
    const proven = pure.filter((id) => cached.get(id)?.valid !== undefined)
    const proofs = [
      ...(unproven.length ? yield* summaryProofs(sql, unproven, fork, undefined, base, overrideJson) : []),
      ...(proven.length ? yield* freshInputs(sql, proven, fork, undefined, base, overrideJson) : [])
    ]
    const impure = plain.filter((id) => !pureIds.has(id))
    const inputs = impure.length ? yield* summaryInputs(sql, impure, fork, undefined, base) : []
    const unread = missing.filter((id) => !cached.has(id))
    const children = [
      ...(unread.length ? yield* summaryChildren(sql, unread) : []),
      ...[...cached.values()].flatMap((entry) => entry.children)
    ]
    // Kept arrays are shared with the store, so new rows group into new arrays only.
    const group = <A extends { summary_id: string }>(items: ReadonlyArray<A>) => {
      const groups = new Map<string, Array<A>>()
      for (const item of items) {
        const values = groups.get(item.summary_id)
        if (values) values.push(item)
        else groups.set(item.summary_id, [item])
      }
      return groups
    }
    const facts: SummaryFacts = {
      fork,
      rows: new Map([...(prior?.rows ?? []), ...rows.map((r) => [r.id, r] as const)]),
      proofs: new Map([...(prior?.proofs ?? []), ...proofs.map((p) => [p.summary_id, p] as const)]),
      inputs: new Map([...(prior?.inputs ?? []), ...group(inputs)]),
      children: new Map([...(prior?.children ?? []), ...group(children)])
    }
    // Empty arrays are facts too; an absent changeset entry deliberately requests the slow proof.
    for (const id of plain) if (!pureIds.has(id) && !facts.inputs.has(id)) facts.inputs.set(id, [])
    for (const id of missing) if (!facts.children.has(id)) facts.children.set(id, [])
    kept.facts.push(facts)
    const visiting = new Set<string>()
    const valid = (id: string): boolean | undefined => {
      if (kept.valid.has(id)) return kept.valid.get(id)!
      const row = facts.rows.get(id)
      if (!row || visiting.has(id)) return false
      if (!row.base_revision_valid) return false
      const input = facts.inputs.get(id)
      const proof = pureIds.has(id) ? (facts.proofs.get(id) ?? { count: 0, valid: 0, fresh: 1 }) : undefined
      if ((!input && !proof) || proof?.valid === null) return undefined
      const parts = facts.children.get(id)!
      visiting.add(id)
      let answer: boolean | undefined
      if (row.level === 1) {
        answer =
          !parts.length &&
          (proof
            ? proof.count === row.slot_count && !!proof.valid
            : input!.length === row.slot_count &&
              input![0]?.slot_id === row.first_slot_id &&
              input!.at(-1)?.slot_id === row.last_slot_id &&
              input!.every(
                (i, n) =>
                  i.ordinal === n && !!i.version_valid && (n === 0 || i.parent_slot_id === input![n - 1]!.slot_id)
              ))
      } else {
        answer = (proof ? proof.count : input!.length) === 0 && parts.length > 0
        let count = 0
        let previous: string | undefined
        for (const [n, child] of parts.entries()) {
          if (!answer) break
          if (
            child.ordinal !== n ||
            child.level >= row.level ||
            child.chat_id !== row.chat_id ||
            child.status === "failed" ||
            !child.revision_valid ||
            (n === 0 ? child.first_slot_id !== row.first_slot_id : child.previous !== previous)
          ) {
            answer = false
            break
          }
          answer = valid(child.parent_id)
          count += child.slot_count
          previous = child.last_slot_id
        }
        if (answer && (count !== row.slot_count || previous !== row.last_slot_id)) answer = false
      }
      visiting.delete(id)
      if (answer !== undefined) kept.valid.set(id, answer)
      return answer
    }
    for (const id of missing) valid(id)
    kept.commit.push(() => {
      for (const row of rows) {
        const old = cached.get(row.id)
        const checked = kept.valid.get(row.id)
        if (!old || old.valid !== checked) retained.set(row.id, stamp(row), facts.children.get(row.id) ?? [], checked)
      }
    })
    if (prior) {
      for (const [id, data] of prior.projections) kept.projections.set(`${fork}\u0000${id}`, data)
      for (const [id, data] of prior.summaries) kept.summaries.set(`${fork}\u0000${id}`, data)
      for (const [id, data] of prior.ranges) kept.ranges.set(`${fork}\u0000${id}`, data)
    }
    // Pure rows need no asynchronous per-summary work. Fold their freshness and DTOs once,
    // leaving audience/image/application proofs to readSummary when any is required.
    const materialize = (id: string): Summary | undefined => {
      const key = `${fork}\u0000${id}`
      const hit = kept.projections.get(key)
      if (hit) return hit
      const row = facts.rows.get(id)
      if (
        !row ||
        !kept.valid.get(id) ||
        row.origin === "changeset" ||
        row.audience_json !== null ||
        row.images_json !== null
      )
        return undefined
      const proof = facts.proofs.get(id)
      const parts = facts.children.get(id)!
      const resolved = parts.map((p) => materialize(p.parent_id))
      if (resolved.some((p) => p === undefined)) return undefined
      const fresh =
        !row.choice &&
        !(row.replacement && row.origin === "generated") &&
        (proof?.fresh ?? 1) === 1 &&
        parts.every((p, n) => resolved[n]!.fresh && resolved[n]!.revisionId === p.parent_revision_id)
      const summary: Summary = {
        id: row.id,
        chatId: row.chat_id,
        level: row.level,
        firstSlotId: row.first_slot_id,
        lastSlotId: row.last_slot_id,
        from: row.first_depth + 1,
        to: row.last_depth + 1,
        slotCount: row.slot_count,
        revisionNumber: row.revision_number,
        revisionId: row.revision_id,
        rolloutId: row.revision_rollout_id,
        content: row.content,
        tokens: row.token_count,
        origin: row.origin,
        status: row.superseded ? "superseded" : row.status,
        error: row.error_json,
        batchId: row.batch_id,
        rowVersion: row.row_version,
        fresh,
        inputs: [],
        children: parts.map((p) => ({ summaryId: p.parent_id, revisionId: p.parent_revision_id }))
      }
      kept.projections.set(key, summary)
      return summary
    }
    for (const id of missing) materialize(id)
    if (store)
      kept.commit.push(() => {
        // Only this fork's pure summaries are kept whole: the others' freshness reads more than facts.
        const prefix = `${fork}\u0000`
        const own = <A>(entries: Map<string, A>) => {
          const out = new Map<string, A>()
          for (const [key, value] of entries)
            if (key.startsWith(prefix)) {
              const id = key.slice(prefix.length)
              if (pureIds.has(id) && facts.rows.has(id)) out.set(id, value)
            }
          return out
        }
        const projections = own(kept.projections)
        const summaries = own(kept.summaries)
        const ranges = own(kept.ranges)
        let characters = prior?.characters ?? 0
        for (const [id, range] of ranges) if (!prior?.ranges.has(id)) characters += JSON.stringify(range).length
        for (const row of rows) characters += weightOf(row)
        for (const [id, summary] of summaries) if (!prior?.summaries.has(id)) characters += fullWeight(summary)
        characters += inputs.reduce((n, input) => n + factRowCharacters(input), 0)
        characters += children.reduce((n, child) => n + factRowCharacters(child), 0)
        const leaves = here
          ? [
              { leaf, chain: here.chain_id, depth: here.depth, ids },
              ...(prior?.leaves ?? []).filter((l) => l.leaf !== leaf)
            ].slice(0, KEPT_LEAVES)
          : (prior?.leaves ?? [])
        // A kept leaf costs its ids, which list the path's summaries.
        const leafCharacters = (list: ReadonlyArray<KeptLeaf>) => list.reduce((n, l) => n + 40 * l.ids.length, 0)
        characters += leafCharacters(leaves) - leafCharacters(prior?.leaves ?? [])
        store.save(
          {
            rows: facts.rows,
            proofs: facts.proofs,
            inputs: facts.inputs,
            children: facts.children,
            pure: pureIds,
            valid: new Map([...kept.valid].filter(([id]) => facts.rows.has(id))),
            projections,
            summaries,
            ranges,
            leaves,
            floor: Math.max(store.top, prior?.floor ?? 0),
            characters
          },
          characters
        )
      })
  })

/**
 * Completes the primed projections of pure summaries `ids` with their inputs in one read, as
 * `readSummary` would one summary at a time, so a pass over a whole path reads them once.
 * Only for a fork that shows no inserted slots, whose summaries `primeSummaryReads` read.
 */
export const completeSummaries = (sql: SqlClient.SqlClient, chatId: string, leaf: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const kept = yield* SummaryReads
    if (!kept) return
    const fork = yield* viewAt(sql, chatId, leaf)
    const key = (id: string) => `${fork}\u0000${id}`
    const facts = kept.facts.find((f) => f.fork === fork)
    if (!facts) return
    const wanted = ids.filter(
      (id) =>
        !kept.summaries.has(key(id)) && kept.projections.has(key(id)) && facts.rows.has(id) && !facts.inputs.has(id)
    )
    if (!wanted.length) return
    const inputs = new Map<string, Array<{ slotId: string; versionId: string | null; amendCount: number }>>()
    for (const i of yield* summaryInputs(sql, wanted, fork)) {
      const input = { slotId: i.slot_id, versionId: i.version_id, amendCount: i.amend_count }
      const list = inputs.get(i.summary_id)
      if (list) list.push(input)
      else inputs.set(i.summary_id, [input])
    }
    for (const id of wanted)
      kept.summaries.set(key(id), decodeSummary({ ...kept.projections.get(key(id))!, inputs: inputs.get(id) ?? [] }))
  })

export const readSummary = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  id: string,
  revision?: string,
  memo = new Map<string, Summary>(),
  view?: LcmView
) => {
  let views = view === undefined ? [] : [view]
  const read = (summaryId: string): Effect.Effect<Summary, NotFound | import("effect/sql").SqlError.SqlError> =>
    Effect.gen(function* () {
      const cached = memo.get(summaryId)
      if (cached) return cached
      const scope = yield* SummaryReads
      const primed = scope?.facts.find((f) => f.rows.has(summaryId))?.rows.get(summaryId)
      const owner = primed ?? (yield* sql<{ chat_id: string }>`SELECT chat_id FROM summaries WHERE id=${summaryId}`)[0]
      const fork = yield* viewAt(sql, owner?.chat_id ?? "", null)
      let shown = views.find((v) => v.fork === fork)
      if (shown === undefined) {
        const facts = (yield* SummaryReads)?.facts.find((f) => f.fork === fork && f.rows.has(summaryId))
        shown = facts ? (facts.view ?? { fork, pieces: null }) : yield* lcmView(sql, owner?.chat_id ?? "", fork)
        views = [...views, shown]
      }
      // A summary read as it is now, in a fork that shows no inserted slots, is the same all operation long.
      const kept = summaryId === id && revision !== undefined ? null : yield* SummaryReads
      const key = `${fork}\u0000${summaryId}`
      const hit = shown.pieces === null ? kept?.summaries.get(key) : undefined
      if (hit !== undefined) {
        memo.set(summaryId, hit)
        return hit
      }
      const facts = kept?.facts.find((f) => f.fork === fork && f.rows.has(summaryId))
      const projection = kept?.projections.get(key)
      if (projection && facts) {
        const summary = decodeSummary({
          ...projection,
          inputs: (facts.inputs.get(summaryId) ?? (yield* summaryInputs(sql, [summaryId], fork))).map((i) => ({
            slotId: i.slot_id,
            versionId: i.version_id,
            amendCount: i.amend_count
          }))
        })
        kept!.summaries.set(key, summary)
        memo.set(summaryId, summary)
        return summary
      }
      const row =
        summaryId === id && revision !== undefined
          ? (yield* summaryRows(sql, userId, [summaryId], fork, revision))[0]
          : (facts?.rows.get(summaryId) ?? (yield* summaryRows(sql, userId, [summaryId], fork))[0])
      if (!row) return yield* new NotFound({ entity: "summary", id: summaryId })
      const [summaryEdit] =
        row.origin === "changeset"
          ? yield* sql<{ changeset_id: string; application: string }>`
        SELECT si.changeset_id,si.after_json ->> '$.applicationId' AS application FROM changesets ac
        JOIN changeset_items si ON si.changeset_id=ac.id AND si.target_kind='summary_revision'
        WHERE ac.chat_id=${row.chat_id} AND ac.origin='agent' AND si.target_id=${row.id}
          AND si.after_json ->> '$.id'=${row.revision_id} LIMIT 1`
          : []
      // Fresh in the fork in view: its inputs are what that fork shows (spec/FORK-INDEPENDENCE-DELTA.md §3).
      // Audience projection below mutates effective, so never mutate the shared facts.
      const inputs = (facts?.inputs.get(summaryId) ?? (yield* summaryInputs(sql, [summaryId], fork, summaryEdit))).map(
        (i) => ({ ...i })
      )
      // A view's own summary (db/lcmAudience.ts): a message its audience didn't know is absent from
      // it, as a hidden one is, so a correction of who was there makes it stale.
      if (row.audience_json !== null) {
        const ids = inputs.flatMap((i) => (i.effective === null ? [] : [i.effective]))
        const known = yield* knownVersions(sql, ids, audienceIds(row.audience_json), fork)
        for (const i of inputs) if (i.effective !== null && !known.has(i.effective)) i.effective = null
      }
      const children = facts?.children.get(summaryId) ?? (yield* summaryChildren(sql, [summaryId]))
      let fresh = inputs.every(
        (i) =>
          (i.version_id === i.effective && (i.version_id === null || i.amend_count === i.current_amends)) ||
          (i.effective !== null && i.replaced_with_summaries === 1 && i.current_amends === 0)
      )
      // Written with other images than this fork sends for the same inputs: stale here, as after an edit.
      if (fresh && !(yield* imagesMatch(sql, row.chat_id, row.id, row.images_json, fork))) fresh = false
      // An explicit rerun establishes an active generated replacement. Old lineage remains
      // pinned for replay, while live generated ancestors must incorporate the replacement.
      if (row.choice || (row.replacement && row.origin === "generated")) fresh = false
      for (const child of children) {
        const parent = yield* read(child.parent_id)
        const [sameGroup] =
          row.origin === "changeset" && parent.origin === "changeset"
            ? yield* sql`SELECT 1
          FROM changeset_items a JOIN changesets ac ON ac.id=a.changeset_id
          JOIN changeset_items b ON b.target_kind='summary_revision' JOIN changesets bc ON bc.id=b.changeset_id
          WHERE a.target_kind='summary_revision' AND a.target_id=${row.id} AND a.after_json ->> '$.id'=${row.revision_id}
            AND b.target_id=${parent.id} AND b.after_json ->> '$.id'=${parent.revisionId} AND ac.group_id=bc.group_id
            AND a.after_json ->> '$.applicationId'=b.after_json ->> '$.applicationId' LIMIT 1`
            : []
        fresh &&= parent.fresh && (parent.revisionId === child.parent_revision_id || sameGroup !== undefined)
      }
      // In a fork that shows inserted slots, its numbers are positions, and a slot shown between
      // its first and last that it doesn't cover is an insertion inside it: stale, as after an
      // edit there (spec/MESSAGE-INSERT.md §3.4).
      let from = row.first_depth + 1,
        to = row.last_depth + 1
      if (shown.pieces !== null) {
        const first = positionOf(shown.pieces, {
          id: row.first_slot_id,
          chainId: row.first_chain,
          depth: row.first_depth
        })
        const last = positionOf(shown.pieces, { id: row.last_slot_id, chainId: row.last_chain, depth: row.last_depth })
        if (first !== null && last !== null && last >= first) {
          from = first + 1
          to = last + 1
          if (to - from + 1 > row.slot_count) fresh = false
        }
        // A fork that moves messages (owner, 2026-11-16): a summary over the old order is stale
        // there, as after an edit: its first and last are out of order, or its inputs, in the
        // order it read them, aren't in order on the display path.
        if (showsMoves(shown.pieces)) {
          if (first === null || last === null || last < first) fresh = false
          else if (fresh && inputs.length > 0) {
            const places = yield* placesOf(
              sql,
              row.chat_id,
              inputs.map((i) => i.slot_id)
            )
            let previous = -1
            for (const i of inputs) {
              const position = positionIn(shown.pieces, places.get(i.slot_id))
              if (position === null || position <= previous) {
                fresh = false
                break
              }
              previous = position
            }
          }
        }
      }
      const summary = decodeSummary({
        id: row.id,
        chatId: row.chat_id,
        level: row.level,
        firstSlotId: row.first_slot_id,
        lastSlotId: row.last_slot_id,
        from,
        to,
        slotCount: row.slot_count,
        revisionNumber: row.revision_number,
        revisionId: row.revision_id,
        rolloutId: row.revision_rollout_id,
        content: row.content,
        tokens: row.token_count,
        origin: row.origin,
        status: row.superseded ? "superseded" : row.status,
        error: row.error_json,
        batchId: row.batch_id,
        rowVersion: row.row_version,
        fresh,
        inputs: inputs.map((i) => ({ slotId: i.slot_id, versionId: i.version_id, amendCount: i.amend_count })),
        children: children.map((p) => ({ summaryId: p.parent_id, revisionId: p.parent_revision_id })),
        ...(row.audience_json === null ? {} : { audience: audienceIds(row.audience_json) })
      })
      memo.set(summaryId, summary)
      if (shown.pieces === null) kept?.summaries.set(key, summary)
      return summary
    })
  return read(id)
}

const displayRequest = (sent: string | null): ContextDisplay | null => {
  const wire = sent ? (JSON.parse(sent) as WireContext) : null
  // Project the sanitized capture explicitly: transport metadata, digests and raw usage stay in storage.
  const request: ContextDisplay | null = wire?.display
    ? {
        ...wire.display,
        samplers: wire.samplers,
        messages: wire.messages.map((message) => ({
          role: message.role,
          name: message.name ?? null,
          content: message.content,
          ...(message.prefill ? { prefill: message.prefill } : {}),
          tokens: tokensOf(message),
          sources: message.sources ?? [],
          ...(message.parts ? { parts: message.parts } : {}),
          ...(message.groups ? { groups: message.groups } : {}),
          breakpoint: message.breakpoint ?? null
        }))
      }
    : null

  return request
}

export const makeLcmReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const details = (userId: UserId, summaryId: string, revisionId?: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{
        chat_id: string
        fork_id: string | null
        rollout_id: string | null
        job_id: string | null
        attempts: number | null
        model: string | null
        started_at: number | null
        completed_at: number | null
        sent: string | null
        parts: number
      }>`SELECT s.chat_id,r.fork_id,r.id AS rollout_id,j.id AS job_id,j.attempts,m.model_key AS model,
          r.started_at,r.completed_at,p.sent_context_json AS sent,
          (SELECT count(*) FROM summary_parents sp WHERE sp.summary_id=s.id) AS parts
          FROM summaries s JOIN chats c ON c.id=s.chat_id
          LEFT JOIN summary_revisions revision ON revision.id=${revisionId ?? null} AND revision.summary_id=s.id
          LEFT JOIN rollouts r ON r.id=CASE WHEN ${revisionId ?? null} IS NULL THEN s.rollout_id ELSE revision.rollout_id END
          LEFT JOIN rollout_payloads p ON p.rollout_id=r.id
          LEFT JOIN models m ON m.id=r.model_id
          LEFT JOIN summarization_jobs j ON j.id=coalesce((SELECT job_id FROM summary_attempts WHERE rollout_id=r.id),
            (SELECT id FROM summarization_jobs WHERE result_summary_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1))
          WHERE s.id=${summaryId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL`
      if (!row) return yield* new NotFound({ entity: "summary", id: summaryId })
      const requests =
        row.rollout_id === null
          ? []
          : yield* sql<LlmRequestRow>`SELECT * FROM llm_requests
          WHERE rollout_id=${row.rollout_id} AND owner_user_id=${userId} ORDER BY started_at,id`
      const request = displayRequest(row.sent)
      const storedAttempts =
        row.rollout_id === null
          ? []
          : yield* sql<{ rollout_id: string; sent: string | null }>`
          SELECT a.rollout_id,p.sent_context_json AS sent FROM summary_attempts a
          LEFT JOIN rollout_payloads p ON p.rollout_id=a.rollout_id
          WHERE a.job_id=(SELECT job_id FROM summary_attempts WHERE rollout_id=${row.rollout_id})
          AND a.epoch <= (SELECT epoch FROM summary_attempts WHERE rollout_id=${row.rollout_id})
          ORDER BY a.epoch`
      const attempts = [...storedAttempts]
      if (row.rollout_id !== null && !attempts.some((a) => a.rollout_id === row.rollout_id))
        attempts.push({ rollout_id: row.rollout_id, sent: row.sent })
      const generations = yield* Effect.forEach(attempts, (attempt) =>
        Effect.gen(function* () {
          const ledger = yield* sql<
            LlmRequestRow & { summary_response: string | null }
          >`SELECT q.*,s.response AS summary_response FROM llm_requests q
            LEFT JOIN summary_responses s ON s.request_id=q.id
            WHERE q.owner_user_id=${userId} AND q.rollout_id=${attempt.rollout_id} ORDER BY q.started_at,q.id`
          return new SummaryAttempt({
            rolloutId: attempt.rollout_id,
            request: displayRequest(attempt.sent),
            requests: ledger.map(toLlmRequest),
            responses: ledger.flatMap((q) =>
              q.summary_response === null ? [] : [{ requestId: q.id, response: q.summary_response }]
            )
          })
        })
      )
      return new SummaryDetails({
        chatId: row.chat_id as ChatId,
        forkId: row.fork_id as ForkId | null,
        jobId: row.job_id,
        attempts: storedAttempts.length || row.attempts,
        parts: row.parts,
        model:
          requests.findLast((request) => request.purpose === "summarize" || request.purpose === "condense")
            ?.model_key ??
          row.model ??
          request?.model?.model ??
          null,
        startedAt: row.started_at,
        endedAt: row.completed_at,
        requests: requests.map(toLlmRequest),
        generations,
        request
      })
    })
  return {
    GetSummaryDetails: ({ userId, summaryId }) => details(userId, summaryId).pipe(query("GetSummaryDetails")),
    GetSummaryRevisionRequest: ({ userId, revisionId }) =>
      Effect.gen(function* () {
        const [revision] = yield* sql<{ summary_id: string }>`SELECT r.summary_id FROM summary_revisions r
        JOIN summaries s ON s.id=r.summary_id JOIN chats c ON c.id=s.chat_id
        WHERE r.id=${revisionId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL`
        if (!revision) return yield* new NotFound({ entity: "summary revision", id: revisionId })
        return yield* details(userId, revision.summary_id, revisionId)
      }).pipe(query("GetSummaryRevisionRequest")),
    GetSummary: ({ userId, summaryId, forkId }) =>
      readSummary(sql, userId, summaryId).pipe(inSummaryFork(sql, userId, summaryId, forkId), query("GetSummary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
