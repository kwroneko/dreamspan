import { messageView } from "./lcmBaseView.ts"
import { pathSegments } from "./pathSegments.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { imageExcludedIn, originalSql, shownIn, shownVersionDeletedIn, slotDeletedIn, viewAt } from "./forkState.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { RequestImage } from "../assembler/types.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { windowPieces } from "./displayPath.ts"
import { lcmView, placesOf, positionIn } from "./lcmDisplay.ts"
import { readKnowers } from "./knowers.ts"
import { knownVersions } from "./lcmAudience.ts"

export interface LcmSlot {
  id: Summary["firstSlotId"]
  parent: string | null
  depth: number
  /** The slot's place on the fork's display path (spec/MESSAGE-INSERT.md §3.4); its depth without insertions. */
  position: number
  /** The slot before it on the display path; its parent without insertions. */
  previous: string | null
  /** 1 for an inserted message. */
  inserted: number
  content: string
  /** Owner-scoped attachment metadata; the planning reader adds estimates for its model. */
  images?: ReadonlyArray<RequestImage>
  versionId: Summary["inputs"][number]["versionId"]
  amendCount: number
  generating: number
  /** Live children that aren't inserted: alternates below it, which make it a branch point. */
  children: number
}
/**
 * `choices`: a fork's effective message overrides (db/lcmBaseView.ts) as a table, so a path's
 * columns join them instead of probing the fork's steps for each slot (`lcmPathColumns`).
 * Only without published LCM ranges' hides, whose rule needs the probe.
 */
const choicesCte = (sql: SqlClient.SqlClient, overrides: string) => sql`choices AS MATERIALIZED (
    SELECT value ->> '$.kind' AS kind,value ->> '$.target_id' AS target_id,
      value ->> '$.value_id' AS value_id,value ->> '$.flag' AS flag FROM json_each(${overrides})
  )`

/** `lcmPathColumns` reading a fork's overrides from `choices` (`choicesCte`): the same values. */
const choiceColumns = (sql: SqlClient.SqlClient, includeContent = true) => {
  const live = sql`s.deleted_at IS NULL AND s.purged_at IS NULL AND coalesce(ds.flag,0)=0 AND coalesce(h.flag,s.context_excluded)=0
        AND v.deleted_at IS NULL AND v.purged_at IS NULL AND coalesce(dv.flag,0)=0`
  return sql`p.id, s.parent_slot_id AS parent, s.depth, p.position, s.parent_slot_id AS previous, s.inserted,
      CASE WHEN ${live} AND v.status NOT IN ('generating','failed') AND (v.content_length > 0 OR EXISTS(SELECT 1 FROM version_attachments a WHERE a.version_id = v.id)) THEN v.id END AS versionId,
      ${
        includeContent
          ? sql`CASE WHEN ${live} AND v.status NOT IN ('generating','failed') THEN CASE WHEN v.content_length > 0 THEN t.content WHEN EXISTS(SELECT 1 FROM version_attachments a WHERE a.version_id = v.id) THEN '[Image]' ELSE '' END ELSE '' END AS content,`
          : sql`'' AS content,`
      }
      (SELECT json_group_array(json_object('mediaId',m.id,'sha256',m.sha256,'width',m.width,'height',m.height))
        FROM version_attachments a JOIN media_assets m ON m.id=a.media_id WHERE a.version_id=v.id AND coalesce((SELECT ie.flag FROM choices ie
          WHERE ie.kind='image_exclude' AND ie.target_id=(${sql.literal(originalSql("v"))}) || ':' || a.media_id),0) <> 1 ORDER BY a.ordinal) AS images_json,
      (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amendCount,
      coalesce(v.status = 'generating',0) AS generating,
      (SELECT count(*) FROM slots child WHERE child.parent_slot_id = p.id AND child.deleted_at IS NULL AND child.inserted = 0) AS children
      FROM path p JOIN slots s ON s.id = p.id
      LEFT JOIN choices so ON so.kind='select' AND so.target_id=s.id
      LEFT JOIN choices ro ON ro.kind='replace' AND ro.target_id=coalesce(so.value_id,s.selected_version_id)
      LEFT JOIN versions v ON v.id = coalesce(ro.value_id,so.value_id,s.selected_version_id)
      LEFT JOIN choices ds ON ds.kind='delete_slot' AND ds.target_id=s.id
      LEFT JOIN choices h ON h.kind='hide' AND h.target_id=s.id
      LEFT JOIN choices dv ON dv.kind='delete_version' AND dv.target_id=${sql.literal(originalSql("v"))}
      ${
        includeContent
          ? sql`LEFT JOIN version_texts t ON t.version_seq = v.seq AND v.content_length > 0
        AND v.status NOT IN ('generating','failed') AND ${live}`
          : sql``
      }
      ORDER BY p.position`
}

// Keep LEFT joins on individual tables. A joined view on their right is
// materialized in full by SQLite, even for a bounded path window.
export const lcmPathColumns = (
  sql: SqlClient.SqlClient,
  fork: string | null,
  base = false,
  includeContent = true
) => sql`p.id, s.parent_slot_id AS parent, s.depth, p.position, s.parent_slot_id AS previous, s.inserted,
      CASE WHEN NOT ${base ? sql`(s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL)` : slotDeletedIn(sql, fork, "s")} AND ${base ? sql`s.context_excluded` : contextExcludedIn(sql, fork)} = 0
        AND NOT ${base ? sql`(v.deleted_at IS NOT NULL OR v.purged_at IS NOT NULL)` : shownVersionDeletedIn(sql, fork, "v")} AND v.status NOT IN ('generating','failed') AND (v.content_length > 0 OR EXISTS(SELECT 1 FROM version_attachments a WHERE a.version_id = v.id)) THEN v.id END AS versionId,
      ${
        includeContent
          ? sql`CASE WHEN NOT ${base ? sql`(s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL)` : slotDeletedIn(sql, fork, "s")} AND ${base ? sql`s.context_excluded` : contextExcludedIn(sql, fork)} = 0
        AND NOT ${base ? sql`(v.deleted_at IS NOT NULL OR v.purged_at IS NOT NULL)` : shownVersionDeletedIn(sql, fork, "v")} AND v.status NOT IN ('generating','failed') THEN CASE WHEN v.content_length > 0 THEN t.content WHEN EXISTS(SELECT 1 FROM version_attachments a WHERE a.version_id = v.id) THEN '[Image]' ELSE '' END ELSE '' END AS content,`
          : sql`'' AS content,`
      }
      (SELECT json_group_array(json_object('mediaId',m.id,'sha256',m.sha256,'width',m.width,'height',m.height))
        FROM version_attachments a JOIN media_assets m ON m.id=a.media_id WHERE a.version_id=v.id AND NOT ${base ? sql`0` : imageExcludedIn(sql, fork, `(${originalSql("v")})`, "a.media_id")} ORDER BY a.ordinal) AS images_json,
      (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amendCount,
      coalesce(v.status = 'generating',0) AS generating,
      (SELECT count(*) FROM slots child WHERE child.parent_slot_id = p.id AND child.deleted_at IS NULL AND child.inserted = 0) AS children
      FROM path p JOIN slots s ON s.id = p.id LEFT JOIN versions v ON v.id = ${base ? sql`s.selected_version_id` : shownIn(sql, fork, "s")}
      ${
        includeContent
          ? sql`LEFT JOIN version_texts t ON t.version_seq = v.seq AND v.content_length > 0
        AND v.status NOT IN ('generating','failed') AND NOT ${base ? sql`(s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL)` : slotDeletedIn(sql, fork, "s")}
        AND ${base ? sql`s.context_excluded` : contextExcludedIn(sql, fork)} = 0 AND NOT ${base ? sql`(v.deleted_at IS NOT NULL OR v.purged_at IS NOT NULL)` : shownVersionDeletedIn(sql, fork, "v")}`
          : sql``
      }
      ORDER BY p.position`

/**
 * The slots from `first` (or the root) to `leaf`, oldest first, with the versions the fork in
 * view shows (ForkView; else the fork through `leaf`). `limit` stops the walk after that many
 * slots, so asking for a range that isn't a chain can't read a whole path. In a fork that shows
 * inserted slots, it's the stretch of its display path from `first` to `leaf`, inserted slots
 * included, numbered by position (`first` not before `leaf` there: the last `limit` positions).
 */
export const lcmPath = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string,
  first?: string,
  limit = Number.MAX_SAFE_INTEGER,
  identities?: ReadonlyArray<string>,
  /** Maintenance pins identities and revisions, without reading the messages' prose. */
  includeContent = true
) =>
  identities === undefined
    ? wholePath(sql, userId, chatId, leaf, first, limit, includeContent)
    : Effect.gen(function* () {
        // A view's path (db/lcmAudience.ts): a message its character didn't know is absent.
        const path = yield* wholePath(sql, userId, chatId, leaf, first, limit, includeContent)
        const versions = path.flatMap((slot) => (slot.versionId === null ? [] : [slot.versionId]))
        const known = yield* knownVersions(sql, versions, identities, yield* viewAt(sql, chatId, leaf))
        // A partial join is rendered from the same frozen rows as a reply. It remains a
        // versioned input, so changing its known text invalidates the summary as usual.
        const joins =
          versions.length === 0
            ? []
            : yield* sql<{ id: string }>`
          SELECT v.id FROM json_each(${JSON.stringify(versions)}) requested CROSS JOIN versions v ON v.id=requested.value
          CROSS JOIN chat_merges m ON m.slot_id=v.slot_id WHERE m.chat_id=${chatId}`
        const projected = new Map(
          (yield* readKnowers(
            sql,
            chatId,
            sql`1`,
            joins.map((j) => j.id),
            identities
          )).map((v) => [v.versionId, v])
        )
        for (const version of projected.values()) if (!version.readable) known.delete(version.versionId)

        return path.map((slot) =>
          slot.versionId === null || known.has(slot.versionId)
            ? projected.has(slot.versionId ?? "")
              ? { ...slot, content: projected.get(slot.versionId!)!.content ?? slot.content }
              : slot
            : { ...slot, versionId: null, content: "", images: [], amendCount: 0 }
        )
      })

const wholePath = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string,
  first?: string,
  limit = Number.MAX_SAFE_INTEGER,
  includeContent = true
) =>
  Effect.gen(function* () {
    const [owned] = yield* sql`SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
    if (!owned) return yield* new NotFound({ entity: "chat path", id: leaf })
    const fork = yield* viewAt(sql, chatId, leaf)
    const changes = yield* messageView(sql, fork)
    const { pieces } = yield* lcmView(sql, chatId, fork)
    // Display windows with insertions underestimate the outer path's size: SQLite scans
    // the first choices alias for every position. Keep their indexed fork-step probes.
    // Structural paths can join choices, unless a published range's hide needs its probe.
    const overrides =
      pieces === null && changes.length > 0 && changes.every((c) => c.kind !== "hide_range")
        ? JSON.stringify(changes)
        : undefined
    const columns =
      overrides === undefined
        ? lcmPathColumns(sql, fork, changes.length === 0, includeContent)
        : choiceColumns(sql, includeContent)
    const choices = overrides === undefined ? sql`` : sql`, ${choicesCte(sql, overrides)}`
    const decode = (rows: ReadonlyArray<LcmSlot & { images_json: string }>) =>
      rows.map(({ images_json, ...row }) => ({
        ...row,
        images: row.versionId ? (JSON.parse(images_json) as RequestImage[]) : []
      }))
    const end = pieces === null ? null : positionIn(pieces, (yield* placesOf(sql, chatId, [leaf])).get(leaf))
    if (pieces === null || end === null)
      return decode(
        yield* sql<LcmSlot & { images_json: string }>`${pathSegments(sql, chatId, leaf, limit)},
          bounds(lo) AS (SELECT f.depth FROM slots f JOIN segments g ON f.chain_id=g.chain_id AND f.depth BETWEEN g.lo AND g.hi WHERE f.id=${first ?? null}),
          path AS (SELECT s.id,s.parent_slot_id,s.depth AS position FROM segments g CROSS JOIN slots s
            ON s.chain_id=g.chain_id AND s.depth BETWEEN max(g.lo,g.floor,coalesce((SELECT lo FROM bounds),0)) AND g.hi)${choices}
          SELECT ${columns}`
      )
    // The display stretch, read from one position earlier for the slot before its first.
    const from = first === undefined ? null : positionIn(pieces, (yield* placesOf(sql, chatId, [first])).get(first))
    const start = Math.max(0, end - Math.min(limit, end + 1) + 1, from !== null && from <= end ? from : 0)
    const rows = decode(
      yield* sql<LcmSlot & { images_json: string }>`WITH w(chain_id, lo, hi, slot_id, start) AS (
          SELECT value ->> 0, value ->> 1, value ->> 2, value ->> 3, value ->> 4 FROM json_each(${windowPieces(pieces, Math.max(0, start - 1), end)})
        ), path(id, position) AS (
          SELECT s.id, w.start + s.depth - w.lo FROM w CROSS JOIN slots s ON s.chain_id = w.chain_id AND s.depth BETWEEN w.lo AND w.hi
          WHERE w.slot_id IS NULL
          UNION ALL SELECT w.slot_id, w.start FROM w WHERE w.slot_id IS NOT NULL
        )${choices} SELECT ${columns}`
    )
    const stretch = rows.map((row, n) => ({ ...row, previous: n === 0 ? null : rows[n - 1]!.id }))
    return start > 0 ? stretch.slice(1) : stretch
  })
export const slotInput = (s: LcmSlot): Summary["inputs"][number] => ({
  slotId: s.id,
  versionId: s.versionId,
  amendCount: s.versionId ? s.amendCount : 0
})
