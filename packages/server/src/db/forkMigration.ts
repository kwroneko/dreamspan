// Migration 0053 (spec/FORK-INDEPENDENCE-DELTA.md §5 steps 2 to 4): one fork per leaf of
// the graph as paths reach it, the current fork from the chat's active leaf, and branch
// names on forks. Nothing a user sees changes: every fork's path is the path to its leaf
// as it was read before, and the current fork's tip is the active leaf.
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { reachableSlot } from "./graphReachability.ts"
import { forkTables, forkTriggers } from "./schema/forks.ts"

interface LeafRow {
  readonly chat_id: string
  readonly leaf: string
  readonly chain_id: string
  readonly depth: number
  readonly head_depth: number
  readonly base: string | null
  readonly base_chain: string | null
  readonly base_depth: number | null
  readonly head_created: number
  readonly leaf_created: number
  readonly head_name: string | null
  readonly head_name_user: number
  /** For a deleted branch's leaves: the branch's deletion, its item if still in the bin, its purge. */
  readonly deleted_at: number | null
  readonly bin_item_id: string | null
  readonly purged_at: number | null
}

interface Fork {
  id: string
  readonly chatId: string
  parent: string | null
  readonly base: string | null
  readonly tip: string | null
  readonly leaf: LeafRow | null
  readonly createdAt: number
  readonly lastChattedAt: number | null
}

export const forksMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const run = (statement: string) => sql.unsafe(statement)
  for (const statement of forkTables) yield* run(statement)

  // The slots paths reach (DESIGN §3.2): from each root down, through messages deleted on
  // their own while replies stay, never into a deleted branch.
  yield* run(`CREATE TEMP TABLE fm_reach (id TEXT PRIMARY KEY) WITHOUT ROWID`)
  yield* run(`WITH RECURSIVE reach(id) AS (
      SELECT s.id FROM slots s WHERE s.parent_slot_id IS NULL AND ${reachableSlot("s")}
      UNION ALL
      SELECT c.id FROM reach r JOIN slots c ON c.parent_slot_id = r.id WHERE ${reachableSlot("c")}
    )
    INSERT INTO fm_reach SELECT id FROM reach`)
  // A deleted branch's region: its root and what's below it, short of another deleted branch.
  yield* run(`CREATE TEMP TABLE fm_region (id TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID`)
  yield* run(`WITH RECURSIVE region(id, root) AS (
      SELECT id, id FROM slots WHERE branch_deleted = 1
      UNION ALL
      SELECT c.id, r.root FROM region r JOIN slots c ON c.parent_slot_id = r.id WHERE c.branch_deleted = 0
    )
    INSERT INTO fm_region SELECT id, root FROM region`)

  const leafColumns = `s.chat_id, s.id AS leaf, s.chain_id, s.depth, h.depth AS head_depth, h.parent_slot_id AS base,
    b.chain_id AS base_chain, b.depth AS base_depth, h.created_at AS head_created, s.created_at AS leaf_created,
    h.branch_name AS head_name, h.branch_name_user AS head_name_user`
  const leafJoins = `JOIN slots h ON h.id = s.chain_id LEFT JOIN slots b ON b.id = h.parent_slot_id`
  const live = yield* sql.unsafe<LeafRow>(`
    SELECT ${leafColumns}, NULL AS deleted_at, NULL AS bin_item_id, NULL AS purged_at
    FROM fm_reach r JOIN slots s ON s.id = r.id ${leafJoins}
    WHERE NOT EXISTS (SELECT 1 FROM slots c JOIN fm_reach rc ON rc.id = c.id WHERE c.parent_slot_id = s.id)
    ORDER BY s.chat_id, s.id`)
  const deleted = yield* sql.unsafe<LeafRow>(`
    SELECT ${leafColumns}, root.deleted_at AS deleted_at,
      (SELECT i.id FROM bin_items i WHERE i.id = root.bin_item_id) AS bin_item_id, root.purged_at AS purged_at
    FROM fm_region r JOIN slots s ON s.id = r.id JOIN slots root ON root.id = r.root ${leafJoins}
    WHERE NOT EXISTS (SELECT 1 FROM slots c JOIN fm_region rc ON rc.id = c.id AND rc.root = r.root
      WHERE c.parent_slot_id = s.id)
    ORDER BY s.chat_id, s.id`)
  const chats = yield* sql<{
    id: string
    active_leaf_slot_id: string | null
    created_at: number
    first_root: string | null
    leaf_chain: string | null
    leaf_depth: number | null
    leaf_created: number | null
  }>`SELECT c.id, c.active_leaf_slot_id, c.created_at,
      (SELECT r.id FROM slots r WHERE r.chat_id = c.id AND r.parent_slot_id IS NULL ORDER BY r.id LIMIT 1) AS first_root,
      a.chain_id AS leaf_chain, a.depth AS leaf_depth, a.created_at AS leaf_created
    FROM chats c LEFT JOIN slots a ON a.id = c.active_leaf_slot_id ORDER BY c.id`

  const forks: Array<Fork> = []
  const byChat = new Map<string, Array<Fork>>()
  const add = (fork: Fork) => {
    forks.push(fork)
    const list = byChat.get(fork.chatId) ?? []
    list.push(fork)
    byChat.set(fork.chatId, list)
    return fork
  }
  for (const leaf of [...live, ...deleted]) {
    add({
      id: uuidv7(),
      chatId: leaf.chat_id,
      parent: null,
      base: leaf.base,
      tip: leaf.purged_at === null ? leaf.leaf : null,
      leaf,
      createdAt: leaf.head_created,
      lastChattedAt: leaf.leaf_created
    })
  }
  const chatById = new Map(chats.map((chat) => [chat.id, chat]))
  // A chat's first fork, the line through its first root, has the chat's id, as new chats' do.
  for (const chat of chats) {
    const main = (byChat.get(chat.id) ?? []).find(
      (f) => f.leaf!.chain_id === chat.first_root && f.leaf!.deleted_at === null
    )
    if (main) main.id = chat.id
  }
  /** The fork continuing below `depth` on `chain`: the line through that point, live ones first. */
  const lineThrough = (chatId: string, chain: string, depth: number) => {
    let best: Fork | null = null
    const rank = (f: Fork) => [f.leaf!.deleted_at === null ? 1 : 0, f.leaf!.depth]
    for (const fork of byChat.get(chatId) ?? []) {
      const leaf = fork.leaf
      if (leaf === null || leaf.chain_id !== chain || leaf.depth <= depth) continue
      const [live, deep] = rank(fork)
      const [bestLive, bestDeep] = best === null ? [-1, -1] : rank(best)
      if (live! > bestLive! || (live === bestLive && deep! > bestDeep!)) best = fork
    }
    return best
  }
  /** The line below `slot` when its chain ends out of reach: the fork of the oldest leaf under it. */
  const oldestBelow = (chatId: string, slot: string) =>
    Effect.gen(function* () {
      const tips = new Map((byChat.get(chatId) ?? []).flatMap((f) => (f.leaf ? [[f.leaf.leaf, f] as const] : [])))
      const rows = yield* sql<{ id: string }>`
        WITH RECURSIVE below(id) AS (
          SELECT id FROM slots WHERE parent_slot_id = ${slot}
          UNION ALL
          SELECT c.id FROM below b JOIN slots c ON c.parent_slot_id = b.id
        )
        SELECT id FROM below ORDER BY id`
      for (const row of rows) {
        const fork = tips.get(row.id)
        if (fork) return fork
      }
      return null
    })
  // A fork's parent is the line it diverged from: the one continuing through its base, or
  // for another root, through the first root.
  for (const fork of forks) {
    const leaf = fork.leaf!
    const firstRoot = chatById.get(fork.chatId)!.first_root
    const parent =
      leaf.base === null
        ? leaf.chain_id === firstRoot
          ? null
          : lineThrough(fork.chatId, firstRoot!, -1)
        : (lineThrough(fork.chatId, leaf.base_chain!, leaf.base_depth!) ?? (yield* oldestBelow(fork.chatId, leaf.base)))
    fork.parent = parent === null || parent === fork ? null : parent.id
  }

  // The current fork has the active leaf as its tip. One set above live messages (a
  // checkpoint) gets a fork of its own, with no slots of its own, so the chat opens there.
  const current = new Map<string, Fork>()
  for (const chat of chats) {
    const own = byChat.get(chat.id) ?? []
    const leaf = chat.active_leaf_slot_id
    const at = leaf === null ? undefined : own.find((f) => f.tip === leaf && f.leaf!.deleted_at === null)
    if (at) {
      current.set(chat.id, at)
      continue
    }
    const parent =
      leaf === null
        ? (own.find((f) => f.id === chat.id) ?? null)
        : (lineThrough(chat.id, chat.leaf_chain!, chat.leaf_depth!) ?? (yield* oldestBelow(chat.id, leaf)))
    current.set(
      chat.id,
      add({
        id: own.some((f) => f.id === chat.id) ? uuidv7() : chat.id,
        chatId: chat.id,
        parent: parent?.id ?? null,
        base: leaf,
        tip: leaf,
        leaf: null,
        createdAt: chat.leaf_created ?? chat.created_at,
        lastChattedAt: null
      })
    )
  }

  // Parents point at a shallower base along the line, so no cycle can form; a corrupted
  // graph that found one anyway loses the link that closes it.
  const ids = new Map(forks.map((f) => [f.id, f]))
  for (const fork of forks) {
    const seen = new Set<string>([fork.id])
    for (let up = fork.parent === null ? undefined : ids.get(fork.parent); up;) {
      if (seen.has(up.id)) {
        fork.parent = null
        break
      }
      seen.add(up.id)
      up = up.parent === null ? undefined : ids.get(up.parent)
    }
  }

  for (const fork of forks) {
    const leaf = fork.leaf
    const named = leaf !== null && leaf.head_name !== null && leaf.purged_at === null
    yield* sql`INSERT INTO forks ${sql.insert({
      id: fork.id,
      chat_id: fork.chatId,
      parent_fork_id: fork.parent,
      branched_at: 0,
      base_slot_id: fork.base,
      tip_slot_id: fork.tip,
      name: named ? leaf.head_name : null,
      name_user: named ? leaf.head_name_user : 0,
      created_at: fork.createdAt,
      last_chatted_at: fork.lastChattedAt,
      deleted_at: leaf?.deleted_at ?? null,
      bin_item_id: leaf?.bin_item_id ?? null,
      purged_at: leaf?.purged_at ?? null
    })}`
    if (leaf === null) continue
    // Its own segment: the slots it appended, as far as the migration can tell.
    yield* sql`UPDATE slots SET fork_id = ${fork.id}
      WHERE chain_id = ${leaf.chain_id} AND depth BETWEEN ${leaf.head_depth} AND ${leaf.depth} AND fork_id IS NULL`
    // The name moves to the fork; a name on a slot that continues its parent's chain stays.
    // The slot keeps whether the user named it, so an ST re-import still leaves it alone.
    if (named) yield* sql`UPDATE slots SET branch_name = NULL WHERE id = ${leaf.chain_id}`
  }
  for (const [chatId, fork] of current) yield* sql`UPDATE chats SET current_fork_id = ${fork.id} WHERE id = ${chatId}`

  // Composer drafts were keyed by their tip; now by fork. One typed before the first
  // message goes to the current fork, unless that fork has one of its own already, whose
  // text it then joins in the recovered texts.
  yield* run(`UPDATE drafts SET field = (SELECT f.id FROM forks f WHERE f.chat_id = drafts.target_id
      AND f.tip_slot_id = drafts.field ORDER BY f.deleted_at IS NOT NULL, f.id LIMIT 1)
    WHERE target_kind = 'composer' AND field <> ''
      AND EXISTS (SELECT 1 FROM forks f WHERE f.chat_id = drafts.target_id AND f.tip_slot_id = drafts.field)`)
  yield* run(`INSERT INTO recovered_texts (id, user_id, source_kind, source_id, source_field, source_label, reason,
      content, byte_size, created_at)
    SELECT d.id, d.user_id, 'composer', d.target_id, '', 'Composer in ' || coalesce(nullif(c.title, ''), 'an untitled chat'),
      'discard', d.content, length(CAST(d.content AS BLOB)), d.updated_at
    FROM drafts d JOIN chats c ON c.id = d.target_id
    WHERE d.target_kind = 'composer' AND d.field = '' AND trim(d.content) <> ''
      AND EXISTS (SELECT 1 FROM drafts o WHERE o.user_id = d.user_id AND o.target_kind = 'composer'
        AND o.target_id = d.target_id AND o.field = c.current_fork_id)`)
  yield* run(`DELETE FROM drafts WHERE target_kind = 'composer' AND field = ''
    AND EXISTS (SELECT 1 FROM drafts o JOIN chats c ON c.id = drafts.target_id WHERE o.user_id = drafts.user_id
      AND o.target_kind = 'composer' AND o.target_id = drafts.target_id AND o.field = c.current_fork_id)`)
  yield* run(`UPDATE drafts SET field = (SELECT current_fork_id FROM chats WHERE id = drafts.target_id)
    WHERE target_kind = 'composer' AND field = '' AND EXISTS (SELECT 1 FROM chats WHERE id = drafts.target_id)`)
  // One at a message no fork ends at (before forks, "Branch from here" opened a composer
  // there) has no fork to show it in: its text goes to the recovered texts.
  const orphan = `d.target_kind = 'composer' AND NOT EXISTS (SELECT 1 FROM forks f WHERE f.id = d.field)`
  yield* run(`INSERT INTO recovered_texts (id, user_id, source_kind, source_id, source_field, source_label, reason,
      content, byte_size, created_at)
    SELECT d.id, d.user_id, 'composer', d.target_id, '', 'Composer in ' || coalesce(nullif(c.title, ''), 'an untitled chat'),
      'discard', d.content, length(CAST(d.content AS BLOB)), d.updated_at
    FROM drafts d JOIN chats c ON c.id = d.target_id WHERE ${orphan} AND trim(d.content) <> ''`)
  yield* run(
    `DELETE FROM drafts WHERE id IN (SELECT d.id FROM drafts d JOIN chats c ON c.id = d.target_id WHERE ${orphan})`
  )

  // A queued message posts in the fork whose tip it waits on.
  yield* run(`UPDATE queued_messages SET fork_id = (SELECT f.id FROM forks f WHERE f.chat_id = queued_messages.chat_id
    AND f.tip_slot_id = queued_messages.reply_slot_id AND f.deleted_at IS NULL ORDER BY f.id LIMIT 1)`)

  yield* run(`DROP TABLE temp.fm_reach`)
  yield* run(`DROP TABLE temp.fm_region`)
  for (const statement of forkTriggers) yield* run(statement)
})
