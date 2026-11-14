// What forks show, resolved in the reader worker from one read of their chat's slot tree and
// one read of each lineage fork's own override rows (db/forkSummaries.ts). It is the rule of
// db/forkState.ts applied in JavaScript: the effective row of (kind, target) in fork G is the
// nearest lineage entry with a row for it at a sequence number within that entry's bound, the
// newest such row there. fork_steps index the same rule for point lookups; a fork's whole path
// would need one lookup per message and kind, which dominated dense branch families.
import type { SqlClient, SqlError } from "effect/sql"
import { Effect } from "effect"
import { eventOrder } from "./forkState.ts"
import { slotHumanAuthorsSql, slotParticipantsSql } from "./participation.ts"

/** The override kinds the shell walk reads. */
const KINDS = `('select', 'replace', 'delete_slot', 'suppress_event')`

interface OverrideRow {
  readonly seq: number
  readonly value_id: string | null
  readonly flag: number | null
}
/** A fork's own rows: kind -> target -> rows, newest first. */
type OwnRows = Map<string, Map<string, Array<OverrideRow>>>

/** A lineage entry: a fork and the newest sequence number of its rows that apply (null: all). */
interface LineageEntry {
  readonly fork: string
  readonly bound: number | null
}

/**
 * Lineages of forks (nearest first) and a bounded cache of lineage forks' own rows, read on
 * demand: each fork's rows are read once while they stay cached.
 */
const makeOverrideResolver = (sql: SqlClient.SqlClient, budget: number) => {
  const lineages = new Map<string, ReadonlyArray<LineageEntry>>()
  const rows = new Map<string, OwnRows>()
  const sizes = new Map<string, number>()
  let held = 0
  const lineageOf = (forkIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const missing = forkIds.filter((id) => !lineages.has(id))
      if (missing.length === 0) return
      const found = yield* sql<{ root: string; fork_id: string; bound: number | null }>`
        WITH RECURSIVE lineage(root, fork_id, bound, n) AS (
          SELECT f.id, f.id, NULL, 0 FROM json_each(${JSON.stringify(missing)}) j CROSS JOIN forks f ON f.id = j.value
          UNION ALL SELECT l.root, c.parent_fork_id, c.branched_at, l.n + 1 FROM lineage l JOIN forks c ON c.id = l.fork_id
          WHERE c.parent_fork_id IS NOT NULL)
        SELECT root, fork_id, bound FROM lineage ORDER BY root, n`
      const byRoot = new Map<string, Array<LineageEntry>>()
      for (const row of found) {
        const list = byRoot.get(row.root) ?? []
        list.push({ fork: row.fork_id, bound: row.bound })
        byRoot.set(row.root, list)
      }
      for (const id of missing) lineages.set(id, byRoot.get(id) ?? [])
    })
  /** Reads the own rows of every lineage fork of `forkIds` not cached yet. */
  const load = (forkIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* lineageOf(forkIds)
      const keep = new Set<string>()
      for (const id of forkIds) for (const entry of lineages.get(id)!) keep.add(entry.fork)
      const missing = [...keep].filter((id) => !rows.has(id))
      if (missing.length > 0) {
        const found = yield* sql<{
          fork_id: string
          kind: string
          target_id: string
          seq: number
          value_id: string | null
          flag: number | null
        }>`SELECT o.fork_id, o.kind, o.target_id, o.seq, o.value_id, o.flag FROM json_each(${JSON.stringify(missing)}) j
          CROSS JOIN fork_overrides o ON o.fork_id = j.value AND o.kind IN ${sql.literal(KINDS)}`
        for (const id of missing) {
          rows.set(id, new Map())
          sizes.set(id, 0)
        }
        const multiple: Array<Array<OverrideRow>> = []
        for (const row of found) {
          const own = rows.get(row.fork_id)!
          let byTarget = own.get(row.kind)
          if (byTarget === undefined) own.set(row.kind, (byTarget = new Map()))
          const list = byTarget.get(row.target_id)
          const entry = { seq: row.seq, value_id: row.value_id, flag: row.flag }
          if (list === undefined) byTarget.set(row.target_id, [entry])
          else {
            if (list.length === 1) multiple.push(list)
            list.push(entry)
          }
          sizes.set(row.fork_id, sizes.get(row.fork_id)! + 1)
        }
        for (const list of multiple) list.sort((a, b) => b.seq - a.seq)
        held += found.length
      }
      // Oldest first, never what this batch needs.
      for (const [id, size] of sizes) {
        if (held <= budget) break
        if (keep.has(id)) continue
        rows.delete(id)
        sizes.delete(id)
        held -= size
      }
    })
  /**
   * A lookup of `kind` in `fork` (loaded): the lineage entries with rows of that kind, nearest
   * first, so each lookup costs a probe per such entry.
   */
  const lookup = (fork: string, kind: string) => {
    const entries: Array<{ readonly byTarget: Map<string, Array<OverrideRow>>; readonly bound: number | null }> = []
    for (const entry of lineages.get(fork)!) {
      const byTarget = rows.get(entry.fork)!.get(kind)
      if (byTarget !== undefined) entries.push({ byTarget, bound: entry.bound })
    }
    return (target: string | null): OverrideRow | undefined => {
      if (target === null) return undefined
      for (const entry of entries) {
        const list = entry.byTarget.get(target)
        if (list === undefined) continue
        for (const row of list) if (entry.bound === null || row.seq <= entry.bound) return row
      }
      return undefined
    }
  }
  return { load, lookup }
}

/** A fork's lookups of the kinds the walk reads. */
interface ForkLookups {
  readonly select: (target: string | null) => OverrideRow | undefined
  readonly replace: (target: string | null) => OverrideRow | undefined
  readonly deleteSlot: (target: string | null) => OverrideRow | undefined
  readonly suppress: (target: string | null) => OverrideRow | undefined
}

/** A message as a fork's path shows it: the columns `shellSlotsQuery` reads (db/shellQueries.ts). */
export interface PathSlot {
  /**
   * The fork whose walk made the row. Forks that show a message's own selection share one row,
   * so a path's rows can name another fork: `paths` keys each path by its fork.
   */
  fork_id: string
  id: string
  chat_id: string
  parent_slot_id: string | null
  created_at: number
  deleted_at: number | null
  speaker: string | null
  at: number
  depth: number
  version_seq: number
  content_length: number
  status: string
  participants: string
  human_authors: string
}

/** A slot of a chat's tree with its own selection, and that version's columns (null: none). */
interface TreeSlot {
  readonly id: string
  readonly chat_id: string
  readonly parent_slot_id: string | null
  readonly depth: number
  readonly created_at: number
  readonly deleted_at: number | null
  readonly selected_version_id: string
  readonly version_id: string | null
  readonly status: string
  readonly speaker: string | null
  readonly at: number
  readonly version_seq: number
  readonly content_length: number
}

interface VersionMeta {
  readonly slot_id: string
  readonly status: string
  readonly speaker: string | null
  readonly origin: string
  readonly created_at: number
  readonly version_seq: number
  readonly content_length: number
}

interface ChatEvent {
  readonly id: string
  readonly source_fork_id: string | null
  readonly chat_id: string
  readonly slot_id: string | null
  readonly version_id: string | null
  readonly scope: string
  readonly key: string
  readonly value_json: string
  readonly fork_label: Uint8Array | null
  readonly superseded: number
}

/** A state event as `shellEventsQuery` reads it for a fork. */
export interface PathEvent {
  readonly fork_id: string
  readonly source_fork_id: string | null
  readonly chat_id: string
  readonly slot_id: string | null
  readonly scope: string
  readonly key: string
  readonly value_json: string
}

const treeQuery = `SELECT s.id, s.chat_id, s.parent_slot_id, s.depth, s.created_at,
    CASE WHEN s.deleted_at IS NOT NULL OR s.purged_at IS NOT NULL THEN 1 END AS deleted_at, s.selected_version_id,
    v.id AS version_id, v.status, v.speaker_entity_id AS speaker,
    CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END AS at,
    v.seq AS version_seq, v.content_length
  FROM json_each(?) j CROSS JOIN slots s ON s.chat_id = j.value
  LEFT JOIN versions v ON v.slot_id = s.id AND v.id = s.selected_version_id`

/**
 * The paths and events of forks (`shellSlotsQuery`'s and `shellEventsQuery`'s rows), for many
 * forks of few chats: each chat's tree and events are read once and kept while its forks are
 * walked, each lineage fork's override rows once while they stay cached (up to `budget` rows).
 */
export const makePathResolver = (sql: SqlClient.SqlClient, evidence: boolean, budget = 400_000) => {
  const overrides = makeOverrideResolver(sql, budget)
  const trees = new Map<string, Map<string, TreeSlot>>()
  const chatEvents = new Map<
    string,
    { events: ReadonlyArray<ChatEvent>; labels: Map<string, { point: Uint8Array; end: Uint8Array }> }
  >()
  const metas = new Map<string, VersionMeta>()
  const evidenceOf = new Map<string, { participants: string; human_authors: string }>()
  /** Keeps only `chats`' trees, events and evidence, once more are held. */
  const retain = (chats: ReadonlySet<string>) => {
    if (trees.size <= chats.size) return
    for (const id of [...trees.keys()]) {
      if (chats.has(id)) continue
      for (const slotId of trees.get(id)!.keys()) evidenceOf.delete(slotId)
      trees.delete(id)
      chatEvents.delete(id)
    }
    if (metas.size > budget) metas.clear()
  }
  const treesOf = (chatIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const missing = chatIds.filter((id) => !trees.has(id))
      if (missing.length === 0) return
      for (const id of missing) trees.set(id, new Map())
      for (const slot of yield* sql.unsafe<TreeSlot>(treeQuery, [JSON.stringify(missing)]))
        trees.get(slot.chat_id)!.set(slot.id, slot)
    })
  // Each walked fork's lookups, for the batch whose rows are loaded.
  let lookups = new Map<string, ForkLookups>()
  const lookupsOf = (fork: string) => {
    let known = lookups.get(fork)
    if (known === undefined) {
      known = {
        select: overrides.lookup(fork, "select"),
        replace: overrides.lookup(fork, "replace"),
        deleteSlot: overrides.lookup(fork, "delete_slot"),
        suppress: overrides.lookup(fork, "suppress_event")
      }
      lookups.set(fork, known)
    }
    return known
  }
  // A message as every fork that shows its own selection shows it, per tree slot.
  const baseSlots = new WeakMap<TreeSlot, PathSlot>()
  const slotOf = (fork: string, node: TreeSlot, meta: VersionMeta | undefined, deleted: boolean): PathSlot => {
    const known = evidence ? evidenceOf.get(node.id) : undefined
    return {
      fork_id: fork,
      id: node.id,
      chat_id: node.chat_id,
      parent_slot_id: node.parent_slot_id,
      created_at: node.created_at,
      depth: node.depth,
      deleted_at: deleted ? 1 : null,
      status: meta === undefined ? node.status : meta.status,
      speaker: meta === undefined ? node.speaker : meta.speaker,
      at:
        meta === undefined
          ? node.at
          : meta.origin === "edited" || meta.origin === "changeset"
            ? node.created_at
            : meta.created_at,
      version_seq: meta === undefined ? node.version_seq : meta.version_seq,
      content_length: meta === undefined ? node.content_length : meta.content_length,
      participants: known?.participants ?? "[]",
      human_authors: known?.human_authors ?? "[]"
    }
  }

  /**
   * Each fork's structural path, root first, as `shellSlotsQuery`'s rows for it walk: from its
   * tip by parent while the depth falls, ending where the version it shows is missing.
   */
  const paths = (
    forks: ReadonlyArray<{ readonly id: string; readonly chat_id: string; readonly tip_slot_id: string | null }>
  ): Effect.Effect<Map<string, ReadonlyArray<PathSlot>>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const chats = new Set(forks.map((f) => f.chat_id))
      retain(chats)
      yield* treesOf([...chats])
      yield* overrides.load(forks.map((f) => f.id))
      lookups = new Map()
      const pairs = new Map<string, string>()
      const unread = new Set<string>()
      // Per fork, tip first: the tree slot, what it shows if not its own selection, whether deleted.
      const walks = forks.map((fork) => {
        const tree = trees.get(fork.chat_id)!
        const { select, replace, deleteSlot } = lookupsOf(fork.id)
        const nodes: Array<TreeSlot> = []
        const shownIds: Array<string | null> = []
        const deletions: Array<boolean> = []
        let node = tree.get(fork.tip_slot_id ?? "")
        while (node !== undefined) {
          const selected = select(node.id)?.value_id ?? node.selected_version_id
          const shown = replace(selected)?.value_id ?? selected
          nodes.push(node)
          if (shown === node.version_id) shownIds.push(null)
          else {
            shownIds.push(shown)
            if (!metas.has(shown)) pairs.set(shown, node.id)
          }
          deletions.push(node.deleted_at !== null || (deleteSlot(node.id)?.flag ?? 0) === 1)
          if (evidence && !evidenceOf.has(node.id)) unread.add(node.id)
          const parent = tree.get(node.parent_slot_id ?? "")
          node = parent !== undefined && parent.depth < node.depth ? parent : undefined
        }
        return { nodes, shownIds, deletions }
      })
      const pending = [...pairs]
      for (let at = 0; at < pending.length; at += 20_000)
        for (const row of yield* sql<VersionMeta & { id: string }>`SELECT v.id, v.slot_id, v.status,
            v.speaker_entity_id AS speaker, v.origin, v.created_at, v.seq AS version_seq, v.content_length
          FROM json_each(${JSON.stringify(pending.slice(at, at + 20_000))}) j
          CROSS JOIN versions v ON v.id = j.value ->> 0 AND v.slot_id = j.value ->> 1`)
          metas.set(row.id, row)
      const ids = [...unread]
      for (let at = 0; at < ids.length; at += 20_000)
        for (const row of yield* sql<{ id: string; participants: string; human_authors: string }>`
          SELECT s.id, ${sql.literal(slotParticipantsSql("s"))} AS participants,
            ${sql.literal(slotHumanAuthorsSql("s"))} AS human_authors
          FROM json_each(${JSON.stringify(ids.slice(at, at + 20_000))}) j CROSS JOIN slots s ON s.id = j.value`)
          evidenceOf.set(row.id, { participants: row.participants, human_authors: row.human_authors })
      const result = new Map<string, ReadonlyArray<PathSlot>>()
      forks.forEach((fork, n) => {
        const { nodes, shownIds, deletions } = walks[n]!
        const path: Array<PathSlot> = []
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]!
          const shown = shownIds[i]!
          const deleted = deletions[i]!
          if (shown === null) {
            if (node.version_id === null) break
            if (deleted === (node.deleted_at !== null)) {
              let slot = baseSlots.get(node)
              if (slot === undefined) baseSlots.set(node, (slot = slotOf(fork.id, node, undefined, deleted)))
              path.push(slot)
            } else path.push(slotOf(fork.id, node, undefined, deleted))
            continue
          }
          const meta = metas.get(shown)
          if (meta === undefined || meta.slot_id !== node.id) break
          path.push(slotOf(fork.id, node, meta, deleted))
        }
        result.set(fork.id, path.reverse())
      })
      return result
    })

  /** Each fork's state events, in `eventOrder` for each fork; their paths must be read first. */
  const events = (
    forks: ReadonlyArray<{ readonly id: string; readonly chat_id: string }>
  ): Effect.Effect<Array<PathEvent>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const missing = [...new Set(forks.map((f) => f.chat_id))].filter((id) => !chatEvents.has(id))
      if (missing.length > 0) {
        const chats = JSON.stringify(missing)
        for (const id of missing) chatEvents.set(id, { events: [], labels: new Map() })
        const byChat = new Map<string, Array<ChatEvent>>()
        for (const row of yield* sql<ChatEvent>`SELECT e.id, e.fork_id AS source_fork_id, e.chat_id, e.slot_id,
            e.version_id, e.scope, e.key, e.value_json, e.fork_label, e.superseded_by_changeset IS NOT NULL AS superseded
          FROM json_each(${chats}) j CROSS JOIN state_events e ON e.chat_id = j.value
          ORDER BY ${sql.literal(eventOrder("e"))}`) {
          const list = byChat.get(row.chat_id) ?? []
          list.push(row)
          byChat.set(row.chat_id, list)
        }
        for (const [id, list] of byChat) chatEvents.get(id)!.events = list
        for (const row of yield* sql<{ fork_id: string; chat_id: string; point: Uint8Array; label_end: Uint8Array }>`
          SELECT l.fork_id, l.chat_id, l.point, l.label_end FROM json_each(${chats}) j
          CROSS JOIN fork_labels l ON l.chat_id = j.value`)
          chatEvents.get(row.chat_id)!.labels.set(row.fork_id, { point: row.point, end: row.label_end })
      }
      const result: Array<PathEvent> = []
      for (const fork of forks) {
        const { events, labels } = chatEvents.get(fork.chat_id)!
        const tree = trees.get(fork.chat_id)!
        const point = labels.get(fork.id)?.point
        const { select, replace, deleteSlot, suppress } = lookupsOf(fork.id)
        for (const e of events) {
          if (e.source_fork_id !== null) {
            const end = labels.get(e.source_fork_id)?.end
            if (point === undefined || end === undefined || e.fork_label === null) continue
            if (Buffer.compare(e.fork_label, point) > 0 || Buffer.compare(point, end) >= 0) continue
          }
          if (e.superseded) continue
          if ((suppress(e.id)?.flag ?? 0) !== 0) continue
          if (e.slot_id !== null) {
            const node = tree.get(e.slot_id)
            if (node === undefined) {
              if (e.version_id !== null) continue
            } else {
              if (node.deleted_at !== null || (deleteSlot(node.id)?.flag ?? 0) === 1) continue
              if (e.version_id !== null) {
                const selected = select(node.id)?.value_id ?? node.selected_version_id
                const shown = replace(selected)?.value_id ?? selected
                if (e.version_id !== shown && e.version_id !== selected) continue
              }
            }
          }
          result.push({
            fork_id: fork.id,
            source_fork_id: e.source_fork_id,
            chat_id: e.chat_id,
            slot_id: e.slot_id,
            scope: e.scope,
            key: e.key,
            value_json: e.value_json
          })
        }
      }
      return result
    })
  /** Whether chat `chatId`'s tree is held, so walking more of its forks reads no tree. */
  const holds = (chatId: string) => trees.has(chatId)
  return { paths, events, holds }
}

export type PathResolver = ReturnType<typeof makePathResolver>
