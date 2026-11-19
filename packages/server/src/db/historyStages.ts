// Short preparation transactions keep their rows in the writer's TEMP schema. No version,
// changeset, overlay or receipt exists until ApplyHistoryEdits publishes the complete plan.
import { createHash, type Hash } from "node:crypto"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { HistoryRejected, type HistoryEdit } from "@dreamspan/shared/historyApi.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { historyFork } from "./historyShared.ts"
import type { makeBulkHistory } from "./historyBulk.ts"

type Bulk = Effect.Success<ReturnType<typeof makeBulkHistory>>
interface Plan {
  token: string
  userId: string
  chatId: string
  forkId: string
  groupId: string
  changesetId: string
  existingGroup: boolean
  stamp: string
  total: number
  processed: number
  bytes: number
  rows: number
  count: number
  expires: number
  summariesIncluded: boolean
  summaryIds?: ReadonlyArray<string>
  digest: Hash
  targets: Set<string>
  copies: Map<string, string>
  ordinals: Map<string, number>
}
const plans = new WeakMap<SqlClient.SqlClient, Map<string, Plan>>()
const pending = (sql: SqlClient.SqlClient) => {
  let map = plans.get(sql)
  if (!map) {
    map = new Map()
    plans.set(sql, map)
  }
  return map
}
const historyEditDigest = (edits: ReadonlyArray<HistoryEdit>, hash = createHash("sha256")) => {
  for (const e of edits)
    hash.update(JSON.stringify([e.kind, e.targetId, e.beforeId, e.before, e.after, e.atSlotId ?? null]) + "\n")
  return hash
}
const stamp = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, userId: string, chatId: string, forkId: string) {
  yield* historyFork(sql, userId, chatId, forkId)
  const [row] = yield* sql<{
    stamp: string
  }>`SELECT json_array(c.row_version,c.shell_stamp,c.state_seq,c.current_fork_id,c.active_leaf_slot_id,
    f.row_version,f.tip_slot_id,(SELECT count(*) FROM forks WHERE chat_id=c.id)) AS stamp
    FROM chats c JOIN forks f ON f.id=${forkId} WHERE c.id=${chatId} AND c.owner_user_id=${userId}`
  return row!.stamp
})
const reject = () =>
  new HistoryRejected({ message: "History changed while this edit was prepared. Read it again before replacing." })
const bulkColumns =
  "n,target,current_id,after_id,content,slot,copy,override_id,own,item,seq,reduce_seq,before_json,after_json,ordinal,expected_updated"

export const prepareHistoryStage = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  bulk: Bulk,
  input: {
    userId: string
    chatId: string
    forkId: string
    groupId?: string
    token?: string
    total: number
    summariesIncluded: boolean
    summaryIds?: ReadonlyArray<string>
    edits: ReadonlyArray<HistoryEdit>
  }
) {
  const map = pending(sql)
  const now = Date.now()
  let plan = input.token ? map.get(input.token) : undefined
  if (input.token && (!plan || plan.userId !== input.userId || plan.expires < now)) return yield* reject()
  // A rejected chunk rolls its SQL back. Keep the token's metadata at the same
  // committed prefix too, so a corrected chunk can retry without phantom copies.
  if (plan)
    plan = {
      ...plan,
      digest: plan.digest.copy(),
      targets: new Set(plan.targets),
      copies: new Map(plan.copies),
      ordinals: new Map(plan.ordinals)
    }
  const current = yield* stamp(sql, input.userId, input.chatId, input.forkId)
  if (!plan) {
    const groupId = input.groupId ?? uuidv7()
    let [record] = yield* sql<{
      id: string
    }>`SELECT id FROM changesets WHERE group_id=${groupId} AND fork_id=${input.forkId}`
    if (input.groupId) {
      const [owned] = yield* sql`SELECT 1 FROM changeset_groups WHERE id=${groupId} AND owner_user_id=${input.userId}`
      if (!owned) return yield* reject()
    }
    if (record) {
      const [child] = yield* sql`SELECT 1 FROM forks f JOIN changesets c ON c.id=${record.id}
        WHERE f.parent_fork_id=${input.forkId} AND f.branched_at>=c.seq LIMIT 1`
      if (child) record = undefined
    }
    plan = {
      token: uuidv7(),
      userId: input.userId,
      chatId: input.chatId,
      forkId: input.forkId,
      groupId,
      changesetId: record?.id ?? uuidv7(),
      existingGroup: input.groupId !== undefined,
      stamp: current,
      total: input.total,
      processed: 0,
      bytes: 0,
      rows: 0,
      count: 0,
      expires: now + 120000,
      summariesIncluded: input.summariesIncluded,
      ...(input.summaryIds === undefined ? {} : { summaryIds: input.summaryIds }),
      digest: createHash("sha256"),
      targets: new Set(),
      copies: new Map(),
      ordinals: new Map()
    }
  }
  if (
    current !== plan.stamp ||
    plan.chatId !== input.chatId ||
    plan.forkId !== input.forkId ||
    plan.total !== input.total ||
    plan.summariesIncluded !== input.summariesIncluded ||
    JSON.stringify(plan.summaryIds) !== JSON.stringify(input.summaryIds) ||
    (input.groupId ?? null) !== (plan.existingGroup ? plan.groupId : null)
  )
    return yield* reject()
  if (!input.edits.length || input.edits.length > 500 || plan.processed + input.edits.length > plan.total)
    return yield* reject()
  const bytes = input.edits.reduce(
    (n, e) => n + Buffer.byteLength(e.before, "utf8") + Buffer.byteLength(e.after, "utf8"),
    0
  )
  if (plan.bytes + bytes > 8388608) return yield* reject()
  for (const edit of input.edits) {
    if (edit.kind !== "version_replace" || plan.targets.has(edit.targetId)) return yield* reject()
    plan.targets.add(edit.targetId)
  }
  const fork = yield* historyFork(sql, input.userId, input.chatId, input.forkId)
  const made = yield* bulk.prepare({
    userId: input.userId,
    fork,
    edits: input.edits,
    groupId: plan.groupId,
    changesetId: plan.changesetId,
    applicationId: plan.token,
    existingGroup: plan.existingGroup,
    summariesIncluded: plan.summariesIncluded,
    ...(plan.summaryIds === undefined ? {} : { summaryIds: plan.summaryIds }),
    copies: plan.copies,
    ordinals: plan.ordinals
  })
  yield* sql.unsafe(
    `CREATE TEMP TABLE IF NOT EXISTS history_prepared_rows AS SELECT '' AS token,${bulkColumns} FROM history_bulk WHERE false`
  )
  yield* sql`CREATE INDEX IF NOT EXISTS history_prepared_token ON history_prepared_rows(token)`
  // A failed enclosing transaction may roll TEMP deletions back. Reconcile orphaned
  // rows independently of the in-memory token cache before accepting more preparation.
  yield* sql`DELETE FROM history_prepared_rows WHERE token NOT IN (SELECT value FROM json_each(${JSON.stringify([...map.keys(), plan.token])}))`
  for (const [key, old] of map)
    if (old.expires < now || (map.size >= 8 && key !== plan.token)) {
      yield* sql`DELETE FROM history_prepared_rows WHERE token=${key}`
      map.delete(key)
    }
  yield* sql.unsafe(
    `INSERT INTO history_prepared_rows SELECT ?,n+?,target,current_id,after_id,content,slot,copy,override_id,own,item,
    seq+?,reduce_seq+?,before_json,after_json,ordinal,expected_updated FROM history_bulk`,
    [plan.token, plan.rows, plan.count, plan.count]
  )
  yield* sql`DELETE FROM history_bulk`
  plan.rows += made.rows
  plan.count += made.count
  plan.processed += input.edits.length
  plan.bytes += bytes
  historyEditDigest(input.edits, plan.digest)
  map.set(plan.token, plan)
  return plan.token
})

export const consumeHistoryStage = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  input: {
    userId: string
    prepared?: string | undefined
    groupId?: string | undefined
    applications: ReadonlyArray<{
      chatId: string
      forkId: string
      summariesIncluded?: boolean
      summaryIds?: ReadonlyArray<string>
      edits: ReadonlyArray<HistoryEdit>
    }>
  }
) {
  if (!input.prepared) return undefined
  const map = pending(sql)
  const plan = map.get(input.prepared)
  if (!plan || plan.userId !== input.userId || plan.expires < Date.now() || input.applications.length !== 1)
    return yield* reject()
  const app = input.applications[0]!
  let end = 0
  while (end < app.edits.length && app.edits[end]!.kind === "version_replace") end++
  if (
    plan.processed !== plan.total ||
    end !== plan.total ||
    app.edits.slice(end).some((e) => e.kind === "version_replace") ||
    app.chatId !== plan.chatId ||
    app.forkId !== plan.forkId ||
    (app.summariesIncluded ?? false) !== plan.summariesIncluded ||
    JSON.stringify(app.summaryIds) !== JSON.stringify(plan.summaryIds) ||
    (input.groupId ?? null) !== (plan.existingGroup ? plan.groupId : null) ||
    historyEditDigest(app.edits.slice(0, end)).digest("hex") !== plan.digest.copy().digest("hex")
  )
    return yield* reject()
  if ((yield* stamp(sql, input.userId, app.chatId, app.forkId)) !== plan.stamp) return yield* reject()
  yield* sql`DELETE FROM history_bulk`
  yield* sql.unsafe(
    `INSERT INTO history_bulk SELECT ${bulkColumns} FROM history_prepared_rows WHERE token=? ORDER BY n`,
    [plan.token]
  )
  const [changed] = yield* sql`SELECT 1 FROM history_bulk b LEFT JOIN versions v ON v.id=b.current_id
    LEFT JOIN version_texts t ON t.version_seq=v.seq
    WHERE v.id IS NULL OR t.content<>(b.before_json ->> '$.content') OR v.updated_at<>b.expected_updated LIMIT 1`
  if (changed) return yield* reject()
  yield* sql`DELETE FROM history_prepared_rows WHERE token=${plan.token}`
  // Keep the bounded token metadata until expiry/eviction: publication may still roll
  // back in an enclosing agent transaction. A committed publication changes its stamp.
  return plan
})
