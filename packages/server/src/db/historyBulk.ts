// Batch the same fork-local version replacements as historyWrites. TEMP rows are private to
// the writer connection; all validation, copies, overrides and receipts commit together.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { HistoryEdit } from "@rp/shared/historyApi.ts"
import { HistoryRejected } from "@rp/shared/historyApi.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { effectiveOverride, selectedIn, slotDeletedIn, versionDeletedIn } from "./forkState.ts"
import { onDisplayPath, pathPieces } from "./displayPath.ts"

const excluded = new Set([
  "raw_content",
  "raw_reasoning",
  "raw_sections",
  "rewrite_json",
  "seq",
  "id",
  "ordinal",
  "content",
  "origin",
  "source_version_id",
  "fork_id",
  "fork_seq",
  "changeset_id",
  "created_at",
  "updated_at"
])
interface Current {
  target: string
  id: string
  content: string
  slot: string
  chain: string
  depth: number
  ordinal: number
  updated_at: number
  live: number
  shown: number
  summaries_done: number | null
  changeset_id: string | null
  own_id: string | null
  own_forked: number
  amends: number
  proof: string | null
}

export const makeBulkHistory = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  // Stable SQL, prepared once by the driver's cache, rather than compiling a target-id
  // literal and re-reading pragma_table_info for every message.
  const metadata = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('versions')`)
    .map((c) => c.name)
    .filter((name) => !excluded.has(name) && name !== "content_length")
  const payload = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('version_texts')`)
    .map((c) => c.name)
    .filter((name) => !excluded.has(name) && name !== "version_seq")
  const prepare = Effect.fnUntraced(function* (input: {
    userId: string
    fork: { id: string; chat_id: string; tip_slot_id: string | null }
    edits: ReadonlyArray<HistoryEdit>
    groupId: string
    changesetId: string
    applicationId: string
    existingGroup: boolean
    summariesIncluded: boolean
    copies: Map<string, string>
    ordinals?: Map<string, number>
  }) {
    const { fork, edits, groupId, changesetId, applicationId, copies } = input
    const pieces = yield* pathPieces(sql, fork.chat_id, fork.id, fork.tip_slot_id)
    const rows = yield* sql<Current>`
      SELECT o.id AS target,v.id,v.content,s.id AS slot,s.chain_id AS chain,s.depth,v.updated_at,(SELECT max(ordinal) FROM versions WHERE slot_id=s.id) AS ordinal,
        (NOT ${slotDeletedIn(sql, fork.id, "s")} AND NOT ${versionDeletedIn(sql, fork.id, "o")}
          AND v.status<>'generating' AND v.deleted_at IS NULL AND v.purged_at IS NULL) AS live,
        o.id=${selectedIn(sql, fork.id, "s")} AS shown,
        p.summaries_done,p.changeset_id,own.id AS own_id,
        EXISTS(SELECT 1 FROM forks c WHERE c.parent_fork_id=own.fork_id AND c.branched_at>=own.seq) AS own_forked,
        ${input.summariesIncluded ? sql`(SELECT count(*) FROM version_history WHERE version_id=v.id)` : sql`0`} AS amends,
        ${
          input.summariesIncluded
            ? sql`(SELECT ci.after_json FROM changeset_items ci WHERE ci.changeset_id=p.changeset_id
          AND ci.target_kind='version_replace' AND ci.target_id=o.id AND ci.after_json ->> '$.id'=v.id AND p.summaries_done=1)`
            : sql`NULL`
        } AS proof
      FROM json_each(${JSON.stringify(edits.map((e) => e.targetId))}) wanted
      CROSS JOIN versions o ON o.id=wanted.value AND o.fork_id IS NULL
      CROSS JOIN slots s ON s.id=o.slot_id AND s.chat_id=${fork.chat_id}
      LEFT JOIN fork_overrides p ON p.id=${effectiveOverride(sql, "replace", fork.id, "o.id")}
      CROSS JOIN version_records v ON v.id=coalesce(p.value_id,o.id)
      LEFT JOIN fork_overrides own ON own.id=(SELECT x.id FROM fork_overrides x
        WHERE x.fork_id=${fork.id} AND x.kind='replace' AND x.target_id=o.id ORDER BY x.seq DESC LIMIT 1)`
    const byTarget = new Map(rows.map((r) => [r.target, r]))
    const previous = yield* sql<{ id: number; target_id: string }>`SELECT id,target_id FROM changeset_items
      WHERE changeset_id=${changesetId} AND target_kind='version_replace'`
    const items = new Map(previous.map((r) => [r.target_id, r.id]))
    const storedCopies = new Map<string, string>()
    if (input.existingGroup) {
      const saved = yield* sql<{ id: string; source: string; content: string; before: string }>`
        SELECT v.id,v.source_version_id AS source,v.content,i.before_json ->> '$.id' AS before
        FROM changesets c JOIN changeset_items i ON i.changeset_id=c.id AND i.target_kind='version_replace'
        JOIN version_records v ON v.changeset_id=c.id AND v.source_version_id=i.target_id
        WHERE c.group_id=${groupId} AND v.purged_at IS NULL`
      for (const row of saved) storedCopies.set(`${row.source}:${row.before}:${row.content}`, row.id)
    }
    let count = 0
    const ordinals = input.ordinals ?? new Map<string, number>()
    const pending = []
    for (const edit of edits) {
      const current = byTarget.get(edit.targetId)
      if (!current || !onDisplayPath(pieces, { id: current.slot, chainId: current.chain, depth: current.depth }))
        return yield* new NotFound({ entity: "history target", id: edit.targetId })
      if (current.id !== edit.beforeId || current.content !== edit.before)
        return yield* new HistoryRejected({
          message: "History changed since the preview. Search again before replacing."
        })
      if (edit.before === edit.after) continue
      if (!current.live) return yield* new HistoryRejected({ message: "A target is no longer editable." })
      const copyKey = `${current.id}:${edit.after}`
      const shared = copies.get(copyKey) ?? storedCopies.get(`${edit.targetId}:${current.id}:${edit.after}`)
      const afterId = shared ?? uuidv7()
      copies.set(copyKey, afterId)
      const inherited = current.proof
        ? ((JSON.parse(current.proof) as { preservedInputs?: Array<{ id: string; amends: number }> }).preservedInputs ??
          [])
        : []
      const preservedInputs = input.summariesIncluded
        ? [...inherited.filter((p) => p.id !== current.id), { id: current.id, amends: current.amends }]
        : []
      const ordinal = shared ? 0 : (ordinals.get(current.slot) ?? current.ordinal) + 1
      if (!shared) ordinals.set(current.slot, ordinal)
      const reduce = current.shown === 1 && edit.after.length < edit.before.length
      const reduceSeq = reduce ? ++count : null
      const seq = ++count
      pending.push({
        n: pending.length,
        target: edit.targetId,
        current: current.id,
        after: edit.after,
        afterId,
        slot: current.slot,
        copy: shared ? 0 : 1,
        ordinal,
        updated: current.updated_at,
        override: current.own_id && !current.own_forked ? current.own_id : uuidv7(),
        own: current.own_id && !current.own_forked ? 1 : 0,
        item: items.get(edit.targetId) ?? null,
        seq,
        reduceSeq,
        before: JSON.stringify({
          id: current.id,
          content: current.content,
          slotId: current.slot,
          summariesDone: current.summaries_done ?? 0,
          changesetId: current.changeset_id ?? null
        }),
        afterJson: JSON.stringify({ id: afterId, content: edit.after, preservedInputs, applicationId })
      })
    }
    const base = 0
    yield* sql`CREATE TEMP TABLE IF NOT EXISTS history_bulk (
      n INTEGER PRIMARY KEY,target TEXT,current_id TEXT,after_id TEXT,content TEXT,slot TEXT,copy INTEGER,
      override_id TEXT,own INTEGER,item INTEGER,seq INTEGER,reduce_seq INTEGER,before_json TEXT,after_json TEXT,ordinal INTEGER,expected_updated INTEGER)`
    yield* sql`DELETE FROM history_bulk`
    yield* sql`WITH rows(value) AS MATERIALIZED (SELECT jsonb(value) FROM json_each(${JSON.stringify(pending)}))
      INSERT INTO history_bulk SELECT value ->> '$.n',value ->> '$.target',value ->> '$.current',
      value ->> '$.afterId',value ->> '$.after',value ->> '$.slot',value ->> '$.copy',value ->> '$.override',
      value ->> '$.own',value ->> '$.item',${base}+(value ->> '$.seq'),
      ${base}+(value ->> '$.reduceSeq'),value ->> '$.before',value ->> '$.afterJson',value ->> '$.ordinal',value ->> '$.updated'
      FROM rows`
    return { count, rows: pending.length }
  })
  const publish = Effect.fnUntraced(function* (input: {
    fork: { id: string; chat_id: string }
    changesetId: string
    summariesIncluded: boolean
    count: number
  }) {
    const { fork, changesetId, count } = input
    if (!count) return
    const [reserved] = yield* sql<{ base: number }>`UPDATE chats SET state_seq=state_seq+${count}
      WHERE id=${fork.chat_id} RETURNING state_seq-${count} AS base`
    yield* sql`UPDATE history_bulk SET seq=seq+${reserved!.base},reduce_seq=reduce_seq+${reserved!.base}`
    const now = Date.now()
    // Insert the same metadata and payload as the view's INSTEAD OF trigger, in two
    // set statements. The reverse payload FK stays deferred until this transaction commits.
    yield* sql.unsafe(
      `INSERT INTO versions (id,ordinal,origin,source_version_id,fork_id,changeset_id,created_at,updated_at,${metadata.join(",")})
      SELECT b.after_id,b.ordinal,'changeset',b.target,?,?,?, ?,${metadata.map((c) => `v.${c}`).join(",")}
      FROM history_bulk b CROSS JOIN versions v ON v.id=b.current_id WHERE b.copy=1 ORDER BY b.n`,
      [fork.id, changesetId, now, now]
    )
    yield* sql.unsafe(
      `INSERT INTO version_texts(version_seq,content,${payload.join(",")})
      SELECT n.seq,b.content,${payload.map((c) => `t.${c}`).join(",")} FROM history_bulk b
      CROSS JOIN versions n ON n.id=b.after_id CROSS JOIN versions v ON v.id=b.current_id
      CROSS JOIN version_texts t ON t.version_seq=v.seq WHERE b.copy=1 ORDER BY b.n`
    )
    yield* sql`INSERT INTO version_attachments(version_id,ordinal,media_id,kind,alt_text)
      SELECT b.after_id,a.ordinal,a.media_id,a.kind,a.alt_text FROM history_bulk b
      JOIN version_attachments a ON a.version_id=b.current_id WHERE b.copy=1`
    yield* sql`INSERT INTO history_changes(slot_id,fork_id,chat_id,depth,revision,seq)
      SELECT b.slot,${fork.id},${fork.chat_id},s.depth,1,b.reduce_seq FROM history_bulk b JOIN slots s ON s.id=b.slot
      WHERE b.reduce_seq IS NOT NULL`
    yield* sql`UPDATE changeset_items SET after_json=b.after_json FROM history_bulk b WHERE changeset_items.id=b.item`
    yield* sql`INSERT INTO changeset_items(changeset_id,target_kind,target_id,before_json,after_json)
      SELECT ${changesetId},'version_replace',target,before_json,after_json FROM history_bulk WHERE item IS NULL ORDER BY n`
    yield* sql`UPDATE fork_overrides SET value_id=b.after_id,flag=NULL,seq=b.seq,bin_item_id=NULL,
      summaries_done=${input.summariesIncluded ? 1 : 0},changeset_id=${changesetId},origin='user'
      FROM history_bulk b WHERE fork_overrides.id=b.override_id AND b.own=1`
    yield* sql`INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id,flag,bin_item_id,summaries_done,changeset_id,origin)
      SELECT b.override_id,${fork.chat_id},${fork.id},b.seq,'replace',b.target,b.slot,s.depth,b.after_id,NULL,NULL,
        ${input.summariesIncluded ? 1 : 0},${changesetId},'user' FROM history_bulk b JOIN slots s ON s.id=b.slot WHERE b.own=0 ORDER BY b.n`
    yield* sql`DELETE FROM history_bulk`
  })
  return {
    prepare,
    publish,
    apply: Effect.fnUntraced(function* (input: Parameters<typeof prepare>[0]) {
      const ready = yield* prepare(input)
      yield* publish({ ...input, count: ready.count })
    })
  }
})

export const bulkUndoHistory = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  fork: { id: string; chat_id: string; tip_slot_id: string | null },
  changesetId: string,
  items: ReadonlyArray<{ id: number; target_id: string; before_json: string; after_json: string }>
) {
  const pieces = yield* pathPieces(sql, fork.chat_id, fork.id, fork.tip_slot_id)
  const rows = yield* sql<{
    target: string
    id: string
    content: string
    slot: string
    chain: string
    depth: number
    own_id: string | null
    own_forked: number
  }>`
    SELECT o.id AS target,v.id,v.content,s.id AS slot,s.chain_id AS chain,s.depth,own.id AS own_id,
      EXISTS(SELECT 1 FROM forks c WHERE c.parent_fork_id=own.fork_id AND c.branched_at>=own.seq) AS own_forked
    FROM json_each(${JSON.stringify(items.map((i) => i.target_id))}) wanted
    CROSS JOIN versions o ON o.id=wanted.value AND o.fork_id IS NULL CROSS JOIN slots s ON s.id=o.slot_id AND s.chat_id=${fork.chat_id}
    LEFT JOIN fork_overrides p ON p.id=${effectiveOverride(sql, "replace", fork.id, "o.id")}
    CROSS JOIN version_records v ON v.id=coalesce(p.value_id,o.id)
    LEFT JOIN fork_overrides own ON own.id=(SELECT x.id FROM fork_overrides x
      WHERE x.fork_id=${fork.id} AND x.kind='replace' AND x.target_id=o.id ORDER BY x.seq DESC LIMIT 1)`
  const byTarget = new Map(rows.map((r) => [r.target, r]))
  const conflicts: number[] = []
  const pending = []
  for (const item of items) {
    const before = JSON.parse(item.before_json) as {
      id: string
      content: string
      slotId: string
      summariesDone?: number
      changesetId?: string | null
    }
    const after = JSON.parse(item.after_json) as { id: string; content: string }
    const current = byTarget.get(item.target_id)
    if (
      !current ||
      !onDisplayPath(pieces, { id: current.slot, chainId: current.chain, depth: current.depth }) ||
      current.id !== after.id ||
      current.content !== after.content
    ) {
      conflicts.push(item.id)
      continue
    }
    const n: number = pending.length
    pending.push({
      n,
      item: item.id,
      target: item.target_id,
      slot: before.slotId,
      value: before.id === item.target_id ? null : before.id,
      override: current.own_id && !current.own_forked ? current.own_id : uuidv7(),
      own: current.own_id && !current.own_forked ? 1 : 0,
      summaries: before.summariesDone === 1 ? 1 : 0,
      changeset: before.changesetId ?? null
    })
  }
  if (!pending.length) return { undone: 0, conflicts }
  const count = pending.length * 3
  const [reserved] = yield* sql<{
    base: number
  }>`UPDATE chats SET state_seq=state_seq+${count} WHERE id=${fork.chat_id} RETURNING state_seq-${count} AS base`
  const base = reserved!.base
  yield* sql`CREATE TEMP TABLE IF NOT EXISTS history_bulk_undo (n INTEGER PRIMARY KEY,item INTEGER,target TEXT,slot TEXT,value_id TEXT,
    override_id TEXT,own INTEGER,summaries INTEGER,changeset TEXT,reduce_seq INTEGER,override_seq INTEGER,revert_seq INTEGER)`
  yield* sql`DELETE FROM history_bulk_undo`
  yield* sql`WITH rows(value) AS MATERIALIZED (SELECT jsonb(value) FROM json_each(${JSON.stringify(pending)}))
    INSERT INTO history_bulk_undo SELECT value ->> '$.n',value ->> '$.item',value ->> '$.target',value ->> '$.slot',value ->> '$.value',
    value ->> '$.override',value ->> '$.own',value ->> '$.summaries',value ->> '$.changeset',
    ${base}+3*(value ->> '$.n')+1,${base}+3*(value ->> '$.n')+2,${base}+3*(value ->> '$.n')+3
    FROM rows`
  yield* sql`INSERT INTO history_changes(slot_id,fork_id,chat_id,depth,revision,seq)
    SELECT b.slot,${fork.id},${fork.chat_id},s.depth,1,b.reduce_seq FROM history_bulk_undo b JOIN slots s ON s.id=b.slot`
  yield* sql`UPDATE fork_overrides SET value_id=b.value_id,flag=NULL,seq=b.override_seq,bin_item_id=NULL,summaries_done=b.summaries,
    changeset_id=b.changeset,origin='user' FROM history_bulk_undo b WHERE fork_overrides.id=b.override_id AND b.own=1`
  yield* sql`INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id,flag,bin_item_id,summaries_done,changeset_id,origin)
    SELECT b.override_id,${fork.chat_id},${fork.id},b.override_seq,'replace',b.target,b.slot,s.depth,b.value_id,NULL,NULL,b.summaries,b.changeset,'user'
    FROM history_bulk_undo b JOIN slots s ON s.id=b.slot WHERE b.own=0 ORDER BY b.n`
  yield* sql`INSERT INTO changeset_reverts(changeset_id,fork_id,item_id,seq)
    SELECT ${changesetId},${fork.id},item,revert_seq FROM history_bulk_undo WHERE true
    ON CONFLICT(fork_id,item_id) DO UPDATE SET seq=excluded.seq`
  yield* sql`DELETE FROM history_bulk_undo`
  return { undone: pending.length, conflicts }
})
