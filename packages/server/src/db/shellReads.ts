import { splitChatMarkers, splitGroups } from "./splitChats.ts"
import type { SplitChatLink } from "@rp/shared/splitChat.ts"
import { NotFound } from "./ops.ts"
import type { ForkId } from "@rp/shared/chat.ts"
// The shell's library: cards, forks and who is in each. Runs in a reader worker. Each fork's
// walk is kept in `fork_summaries` (db/forkSummaries.ts); a read computes only the chats whose
// summaries are stale and returns them for the caller to store, so its cost is the cards and
// forks, plus the messages of what changed since. The app reads it in parts: the cards
// (`ShellCards`) and the fork rows a screen shows (`ShellForks`, each list's first rows and
// its size), so what is sent is what is shown; `ShellLibrary` is everything at once. The
// worker keeps the last computation while the database hasn't changed (`PRAGMA data_version`
// moves with every commit of another connection, and the writer is one), so a screen's
// several reads cost one.
import { CastCard, type ChatId, type EntityId, type SlotId } from "@rp/shared/chat.ts"
import { CHAT_FILTERS, type ChatBrowse, type ChatFilterCounts } from "@rp/shared/chatBrowse.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { CardUsage, ShellCard, ShellFork, type ShellForksView, type ShellSection } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import {
  type ChatSummaries,
  computeForkSummaries,
  FORK_SUMMARY_FORMAT,
  type ForkSummary,
  summaryStamps
} from "./forkSummaries.ts"
import { readFavourites } from "./cardFavourites.ts"
import { type CardSummaryRow, cardSummary, cardSummaryBook } from "./cards.ts"
import type { ReadOps } from "./ops.ts"
import type { ForkRow } from "./rows.ts"
import { query } from "./tx.ts"
import { threadLabels } from "./threadReads.ts"
import { shownSplits } from "./threads.ts"

type Fork = { -readonly [K in keyof Omit<ShellFork, "cast" | "added">]: Omit<ShellFork, "cast" | "added">[K] } & {
  cast: Array<CastCard>
  added: Array<CastCard>
}
type Activity = ShellFork["activity"][number]

/** What every shell read is made of: the cards, each fork row newest first, and what it had to walk. */
interface ShellState {
  readonly links: ReadonlyMap<string, SplitChatLink>
  readonly parents: ReadonlyMap<string, string>
  readonly splitChatIds: ReadonlySet<string>
  readonly cards: ReadonlyArray<ShellCard>
  readonly personas: ReadonlyArray<ShellCard>
  readonly archived: ReadonlyArray<ShellCard>
  readonly forks: ReadonlyArray<Fork>
  readonly chatIndex: ReadonlyMap<string, Fork>
  readonly pinnedChats: ReadonlySet<string>
  readonly pinsCollapsed: boolean
  readonly fresh: ReadonlyArray<ChatSummaries>
}

const trusted = { disableChecks: true } as const

/** A fork's row on the wire: its cast by id, which the read's `people` describe. */
const wire = (f: Fork) =>
  new ShellFork({ ...f, cast: f.cast.map((c) => c.entityId), added: f.added.map((c) => c.entityId) }, trusted)

/** The cards a set of fork rows names, once. */
const peopleOf = (forks: ReadonlyArray<Fork>) => {
  const people = new Map<string, CastCard>()
  for (const f of forks) for (const c of [...f.cast, ...f.added]) people.set(c.entityId, c)
  return [...people.values()]
}

/** By `sort`; Recent and Name are the chat's (`chatRecentAt`, `chatName`) for rows that stand for their chat, else the fork's own. */
const sortBy = (forks: ReadonlyArray<Fork>, sort: ShellForksView["sort"], recent: "fork" | "chat" = "fork") =>
  [...forks].sort((a, b) =>
    sort === "name"
      ? recent === "chat"
        ? a.chatName.localeCompare(b.chatName)
        : a.name.localeCompare(b.name)
      : (sort === "created"
          ? b.createdAt - a.createdAt
          : sort === "added"
            ? (b.addedAt ?? b.createdAt) - (a.addedAt ?? a.createdAt)
            : recent === "chat"
              ? b.chatRecentAt - a.chatRecentAt
              : b.recentAt - a.recentAt) || a.name.localeCompare(b.name)
  )

/**
 * One row per chat, where a list stands for chats rather than forks: its current fork when
 * that's among `forks`, else its first there. In `forks`' order; each row says how many
 * branches its chat has (`branches`), so a chat's forks don't repeat its name down a list.
 */
const perChat = (forks: ReadonlyArray<Fork>): ReadonlyArray<Fork> => {
  const withCurrent = new Set(forks.flatMap((f) => (f.current ? [f.chat.id] : [])))
  const seen = new Set<string>()
  return forks.filter((f) => {
    if (seen.has(f.chat.id) || (withCurrent.has(f.chat.id) && !f.current)) return false
    seen.add(f.chat.id)
    return true
  })
}

/** Forks by card `entity`'s latest turn in them, then newest. */
const byTurn = (forks: ReadonlyArray<Fork>, entity: string) => {
  const at = (f: Fork) => f.activity.find((a) => a.entityId === entity)?.at ?? -1
  return [...forks].sort((a, b) => at(b) - at(a) || b.chatRecentAt - a.chatRecentAt || b.recentAt - a.recentAt)
}

/** How card `entity` is in fork `f`: alone with the user, with others, or gone. */
const categoryOf = (f: Fork, entity: string) =>
  f.activity.find((a) => a.entityId === entity)?.category ?? (f.departed.some((id) => id === entity) ? "was" : "with")

/** Chat metrics come from the current path; chat pins are independent of branch pins. */
const inChatFilter = (f: Fork, filter: ChatBrowse["filter"], pinned: ReadonlySet<string>) =>
  filter === "pinned"
    ? pinned.has(f.chat.id)
    : filter === "groups"
      ? f.cast.length >= 2
      : filter === "solo"
        ? f.cast.length === 1
        : filter === "branches"
          ? f.branches > 1
          : true

const browseChats = (rows: ReadonlyArray<Fork>, browse: ChatBrowse, state: ShellState) => {
  const metric = (f: Fork) => {
    const current = state.chatIndex.get(f.chat.id)!
    switch (browse.sort) {
      case "recent":
        return current.chatRecentAt
      case "started":
        return current.chat.createdAt ?? current.createdAt
      case "messages":
        return current.messages
      case "branches":
        return current.branches
      case "name":
        return current.chatName
    }
  }
  return rows
    .filter((f) => inChatFilter(state.chatIndex.get(f.chat.id)!, browse.filter, state.pinnedChats))
    .sort((a, b) => {
      const x = metric(a),
        y = metric(b)
      const order = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(y) - Number(x)
      return (
        (browse.reversed ? -order : order) || a.chat.id.localeCompare(b.chat.id) || a.forkId.localeCompare(b.forkId)
      )
    })
}

/** Each of `view`'s sections over `forks` (newest first), unlimited. */
const sectionRows = (state: ShellState, view: ShellForksView, id: ShellSection): ReadonlyArray<Fork> => {
  const forks = state.forks
  const needle = view.search.trim().toLowerCase()
  const chats = view.chats === undefined ? null : new Set<string>(view.chats)
  const scoped = forks.filter(
    (f) =>
      (view.entity === null || f.joined.includes(view.entity)) &&
      (view.chat === null || f.chat.id === view.chat) &&
      (chats === null || chats.has(f.chat.id)) &&
      (needle === "" ||
        [f.name, f.chatName, ...f.cast.flatMap((c) => [c.label, c.name])].some((n) => n.toLowerCase().includes(needle)))
  )
  // A chat's branches by their last message, newest first (owner, 2026-11-01).
  const byLast = (list: ReadonlyArray<Fork>) =>
    [...list].sort((a, b) => (b.endAt ?? b.createdAt) - (a.endAt ?? a.createdAt) || b.createdAt - a.createdAt)
  const peer = (f: Fork) => f.pinned || f.named
  // A fork of a shown set of threads is listed as a thread, never as a branch (DESIGN §3.3).
  const thread = (f: Fork) => f.threads !== undefined
  switch (id) {
    case "pinned":
      return sortBy(
        perChat(scoped)
          .filter(
            (f) =>
              state.pinnedChats.has(f.chat.id) &&
              (!view.browse || inChatFilter(state.chatIndex.get(f.chat.id)!, view.browse.filter, state.pinnedChats))
          )
          .map((f) => state.chatIndex.get(f.chat.id)!),
        view.sort,
        "chat"
      )
    case "chats":
      return view.browse ? browseChats(perChat(scoped), view.browse, state) : perChat(scoped)
    case "just":
    case "with":
    case "was":
      if (view.entity === null) return []
      {
        const rows = perChat(
          byTurn(
            scoped.filter((f) => categoryOf(f, view.entity!) === id),
            view.entity
          )
        )
        return view.browse ? browseChats(rows, view.browse, state) : rows
      }
    case "current":
      return scoped.filter((f) => f.current)
    case "threads":
      return byLast(scoped.filter(thread))
    case "pinnedBranches":
      return byLast(scoped.filter((f) => f.pinned && !thread(f)))
    case "peers":
      return byLast(scoped.filter((f) => f.named && !f.pinned && !thread(f)))
    case "other":
      return byLast(scoped.filter((f) => !peer(f) && !thread(f)))
    case "groups": {
      // The home grid's direction toggle turns the order round (oldest first, Z to A).
      const sorted = sortBy(
        perChat(scoped).filter((f) => f.cast.length > 1),
        view.sort,
        "chat"
      )
      return view.reversed === true ? sorted.reverse() : sorted
    }
    case "card":
      return perChat(view.entity === null ? scoped : byTurn(scoped, view.entity))
    case "all":
      return scoped
  }
}

export const makeShellReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  /** The last computation and the database version it read (one connection per reader worker). */
  let memo: { readonly userId: string; readonly version: number; readonly state: ShellState } | null = null
  // Only bounded refreshes may use the foreground lane. Initial, wide, deep and
  // insertion-heavy reads retain the background lane's reserved reply reader.
  const liveReady = (userId: string) =>
    Effect.gen(function* () {
      const userStamp = yield* summaryStamps(sql, userId)
      const rows = yield* sql<{ id: string; chat_id: string; messages: number | null; stale: number }>`
      SELECT f.id, f.chat_id, s.messages,
        s.fork_id IS NULL OR s.format <> ${FORK_SUMMARY_FORMAT} OR s.stamp <> c.shell_stamp
          OR s.user_stamp <> ${userStamp} AS stale
      FROM chats c CROSS JOIN forks f ON f.chat_id = c.id LEFT JOIN fork_summaries s ON s.fork_id = f.id
      WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL LIMIT 5001`
      if (rows.length > 5000) return false
      const stale = rows.filter((row) => row.stale !== 0)
      if (stale.length > 2 || stale.some((row) => (row.messages ?? 0) > 5000)) return false
      if (stale.length === 0) return true
      const ids = JSON.stringify(stale.map((row) => row.id))
      const depths = yield* sql<{ depth: number }>`SELECT s.depth FROM json_each(${ids}) j
      CROSS JOIN forks f ON f.id = j.value JOIN slots s ON s.id = f.tip_slot_id
      UNION ALL SELECT s.depth FROM json_each(${ids}) j CROSS JOIN forks f ON f.id = j.value
        JOIN forks p ON p.id = f.parent_fork_id JOIN slots s ON s.id = p.tip_slot_id`
      if (depths.some((row) => row.depth >= 5000)) return false
      const inserted =
        yield* sql`SELECT 1 FROM json_each(${JSON.stringify([...new Set(stale.map((row) => row.chat_id))])}) j
      CROSS JOIN fork_overrides o ON o.chat_id = j.value AND o.kind = 'insert' LIMIT 1`
      return inserted.length === 0
    })
  const shellState = (userId: string, recompute: boolean | undefined) =>
    Effect.gen(function* () {
      // The stamps first, which also opens the transaction's snapshot: the version read next is its own.
      const userStamp = yield* summaryStamps(sql, userId)
      const [{ data_version: version }] = (yield* sql<{ data_version: number }>`PRAGMA data_version`) as [
        { data_version: number }
      ]
      if (recompute !== true && memo !== null && memo.userId === userId && memo.version === version) return memo.state
      // Each live card's names, avatar and lorebook flags, from its head revision's summary
      // columns (`cardSummary`): no read parses a document, which can be megabytes.
      const rows = yield* sql<
        CardSummaryRow & {
          id: string
          created_at: number
          added_at: number
          ref: string
          revision: string
          persona: number
          archived_at: number | null
        }
      >`
        SELECT e.id, e.archived_at, e.created_at, r.created_at AS added_at, r.id AS ref, r.head_revision_id AS revision,
          cs.fields AS card_fields, cs.book AS card_book, cs.book_entries AS card_book_entries,
          EXISTS(SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id LIMIT 1)
        LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL
        ORDER BY r.label COLLATE NOCASE, e.id`
      // Built from what the read just made: no constructor checks (the RPC encodes it anyway).
      const metadata = rows.map((row) => ({ ...row, ...cardSummary(row) }))
      const byCard = new Map(
        metadata.map((m) => [
          m.id,
          new CastCard(
            {
              entityId: m.id as EntityId,
              name: m.name,
              label: m.name,
              modelName: m.modelName,
              subtitle: m.version,
              persona: m.persona === 1,
              inBin: false,
              talkativeness: m.talkativeness,
              ...cardSummaryBook(m),
              avatarMediaId: m.avatarMediaId,
              ...m.crop
            },
            trusted
          )
        ])
      )
      const chatPins = yield* sql<{ chat_id: string }>`SELECT chat_id FROM chat_pins WHERE user_id = ${userId}`
      const pinnedChats = new Set(chatPins.map((row) => row.chat_id))
      // Each live fork with its chat and its stored summary, when there is one: only what the shell shows.
      const joinedRows = yield* sql<{
        id: string
        chat_id: string
        tip_slot_id: string | null
        last_chatted_at: number | null
        name: string | null
        pinned_at: number | null
        created_at: number
        title: string
        current_fork_id: string | null
        kind: string
        chat_created_at: number
        chat_added_at: number
        shell_stamp: number
        s_format: number | null
        s_stamp: number | null
        s_user_stamp: number | null
        preview: string | null
        messages: number | null
        leaf: string | null
        end_at: number | null
        split_at: number | null
        split_after: number | null
        parent_fork_id: string | null
        base_slot_id: string | null
        lists: string | null
      }>`
          SELECT f.id, f.chat_id, f.tip_slot_id, f.last_chatted_at, f.name, f.pinned_at, f.created_at, f.parent_fork_id, f.base_slot_id,
            c.title, c.kind, c.current_fork_id, c.created_at AS chat_created_at, coalesce(c.added_at, c.created_at) AS chat_added_at,
            c.shell_stamp, s.format AS s_format, s.stamp AS s_stamp, s.user_stamp AS s_user_stamp, s.preview,
            s.messages, s.leaf, s.end_at, s.split_at, s.split_after,
            CASE WHEN s.fork_id IS NOT NULL
              THEN '[' || s.cast_json || ',' || s.joined_json || ',' || s.departed_json || ',' || s.activity_json || ',' || s.added_json || ',' || s.threads_json || ']' END AS lists
          FROM chats c CROSS JOIN forks f ON f.chat_id = c.id LEFT JOIN fork_summaries s ON s.fork_id = f.id
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
      const records = joinedRows as unknown as ReadonlyArray<ForkRow>
      const chatById = new Map(
        joinedRows.map((r) => [
          r.chat_id,
          {
            id: r.chat_id,
            kind: r.kind,
            title: r.title,
            current_fork_id: r.current_fork_id,
            created_at: r.chat_created_at,
            added_at: r.chat_added_at,
            shell_stamp: r.shell_stamp
          }
        ])
      )
      const stored = new Map<string, ForkSummary>()
      // A chat an ST import is still writing changes with every batch, and can be tens of
      // thousands of messages long: walking it on every read made reads cost that chat again.
      // It shows its last stored summary, stale or not, or none, until StImportFinishChat
      // stores its summary; the shell marks it "import unfinished" meanwhile.
      const importing = (row: { title: string }) => importState(row.title).unfinished
      if (recompute !== true) {
        for (const row of joinedRows) {
          if (
            row.lists === null ||
            row.s_format !== FORK_SUMMARY_FORMAT ||
            ((row.s_stamp !== row.shell_stamp || row.s_user_stamp !== userStamp) && !importing(row))
          )
            continue
          const [cast, joined, departed, activity, added, threads] = JSON.parse(row.lists) as [
            Array<string>,
            Array<string>,
            Array<string>,
            ForkSummary["activity"],
            Array<string>,
            ForkSummary["threads"]
          ]
          stored.set(row.id, {
            forkId: row.id,
            chatId: row.chat_id,
            preview: row.preview ?? "",
            messages: row.messages ?? 0,
            leaf: row.leaf,
            endAt: row.end_at,
            split:
              row.split_at === null || row.split_after === null ? null : { at: row.split_at, after: row.split_after },
            cast,
            added,
            joined,
            departed,
            activity,
            threads
          })
        }
      }
      for (const row of joinedRows)
        if (recompute !== true && !stored.has(row.id) && importing(row))
          stored.set(row.id, {
            forkId: row.id,
            chatId: row.chat_id,
            preview: "",
            messages: 0,
            leaf: null,
            endAt: null,
            split: null,
            cast: [],
            added: [],
            joined: [],
            departed: [],
            activity: [],
            threads: []
          })
      // Each fork's summary is valid or not on its own (db/summaryValidity.ts): only the
      // stale ones are walked, and their walks need their full rows.
      const stale = records.flatMap((r) => (stored.has(r.id) ? [] : [r.id]))
      const staleRecords =
        stale.length === 0
          ? []
          : yield* sql<ForkRow>`SELECT f.* FROM json_each(${JSON.stringify(stale)}) j
                CROSS JOIN forks f ON f.id = j.value WHERE f.deleted_at IS NULL`
      const computed = yield* computeForkSummaries(sql, staleRecords)
      const fresh = new Map<string, Array<ForkSummary>>()
      for (const summary of computed) {
        stored.set(summary.forkId, summary)
        const list = fresh.get(summary.chatId) ?? []
        list.push(summary)
        fresh.set(summary.chatId, list)
      }
      const markers = yield* splitChatMarkers(sql, userId)
      const ancestry = yield* sql<{
        id: string
        chat_id: string
        parent_fork_id: string | null
        deleted_at: number | null
      }>`
        SELECT f.id, f.chat_id, f.parent_fork_id, f.deleted_at FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
      const groups = splitGroups(ancestry, markers)
      const ancestors = new Map(ancestry.map((f) => [f.id, f]))
      const byFork = new Map(joinedRows.map((r) => [r.id, r]))
      const groupCurrent = new Map<string, (typeof joinedRows)[number]>()
      for (const record of joinedRows) {
        const id = groups.get(record.id)!
        const previous = groupCurrent.get(id)
        const recency = (r: typeof record) => Math.max(r.created_at, r.last_chatted_at ?? 0)
        if (
          !previous ||
          recency(record) > recency(previous) ||
          (recency(record) === recency(previous) && record.id > previous.id)
        )
          groupCurrent.set(id, record)
      }
      // Preserve an imported chat's explicitly selected branch when it is still in its group.
      for (const record of joinedRows)
        if (record.id === record.current_fork_id && groups.get(record.id) === record.chat_id)
          groupCurrent.set(record.chat_id, record)
      const titles = new Map<string, string>()
      for (const [id, current] of groupCurrent) {
        const root = byFork.get(id)
        const cast = stored.get(current.id)!.cast.flatMap((card) => byCard.get(card) ?? [])
        const original = chatName(importState(current.title).title, cast).name
        titles.set(
          id,
          markers.has(id)
            ? (root?.name ?? `${original} — ${new Date(root!.created_at).toLocaleString("en-GB", { timeZone: "UTC" })}`)
            : original
        )
        if (markers.has(id) && root?.pinned_at !== null) pinnedChats.add(id)
      }
      // A chat's Recent is the latest of its forks' (below), and how many forks it has.
      const chatRecent = new Map<string, number>()
      const branchCount = new Map<string, number>()
      // The thread sets shown in each chat: those with two threads that still have a live fork.
      const placesByChat = new Map<string, Array<ForkSummary["threads"]>>()
      for (const record of joinedRows)
        placesByChat.set(record.chat_id, [...(placesByChat.get(record.chat_id) ?? []), stored.get(record.id)!.threads])
      const shownByChat = new Map([...placesByChat].map(([chat, places]) => [chat, shownSplits(places)]))
      const forks: Array<Fork> = joinedRows.map((record) => {
        const physical = chatById.get(record.chat_id)!
        const groupId = groups.get(record.id)!
        const row = {
          ...physical,
          id: groupId,
          current_fork_id: groupCurrent.get(groupId)!.id,
          created_at: markers.has(groupId) ? byFork.get(groupId)!.created_at : physical.created_at
        }
        const s = stored.get(record.id)!
        const cast = s.cast.flatMap((id) => byCard.get(id) ?? [])
        // Its last shown message; without one, its chat's start (an imported chat's ST date,
        // never the import's time). The user's activity in it counts too (`last_chatted_at`: a
        // send, a swipe, an edit, and making it by Branch from here), so the chat the user just
        // branched stays on top rather than dropping to the branch point's date. An import never
        // chats in a fork: an ST branch file merged into its chat keeps its ST dates.
        const recentAt = Math.max(s.endAt ?? row.created_at, record.last_chatted_at ?? 0)
        chatRecent.set(row.id, Math.max(chatRecent.get(row.id) ?? 0, recentAt))
        const shown = shownByChat.get(record.chat_id)!
        const threads = s.threads.filter((place) => shown.has(place.splitId))
        // Starting threads adds no branches: a new thread's forks aren't counted.
        if (!threads.some((place) => place.ordinal > 0)) branchCount.set(row.id, (branchCount.get(row.id) ?? 0) + 1)
        return {
          forkId: record.id,
          sourceChatId: record.chat_id as ChatId,
          preview: s.preview,
          messages: s.messages,
          chat: { id: row.id as ChatId, kind: row.kind, title: row.title, createdAt: row.created_at },
          leaf: s.leaf as SlotId | null,
          name: record.name ?? chatName(importState(row.title).title, cast).name,
          chatName: titles.get(groupId)!,
          named: record.name !== null,
          current: record.id === row.current_fork_id,
          pinned: record.pinned_at !== null,
          chatPinned: pinnedChats.has(groupId),
          original: record.id === groupId,
          split: s.split,
          createdAt: record.created_at,
          addedAt: row.added_at,
          endAt: s.endAt,
          recentAt,
          chatRecentAt: 0,
          branches: 0,
          cast,
          added: s.added.flatMap((id) => byCard.get(id) ?? []),
          joined: s.joined as Array<EntityId>,
          departed: s.departed as Array<EntityId>,
          activity: s.activity as Array<Activity>,
          ...(threads.length > 0 ? { threads } : {})
        }
      })
      for (const f of forks) {
        f.chatRecentAt = chatRecent.get(f.chat.id)!
        f.branches = branchCount.get(f.chat.id) ?? 0
      }
      // Newest chat first, each chat's forks together, its current one first.
      forks.sort(
        (a, b) =>
          b.chatRecentAt - a.chatRecentAt ||
          a.chat.id.localeCompare(b.chat.id) ||
          Number(b.current) - Number(a.current) ||
          b.recentAt - a.recentAt
      )
      // Each card's forks and turns, in one pass over the forks, in their order.
      // A card's Recent, the one key home, the left panel's grid and Start a chat sort by: the
      // latest activity in any chat it joined (each fork's `recentAt`), imported dates included,
      // as ST sorts by date_last_chat; null while it has none. Never the card's own import or
      // edit time, so a freshly imported library doesn't sort by import order. (Its usage's
      // `lastMessageAt` stays the last turn the card itself spoke.)
      const usage = new Map<
        string,
        { used: Array<Fork>; spoke: Array<{ f: Fork; a: Activity }>; recent: number | null }
      >()
      const usageOf = (id: string) => {
        let entry = usage.get(id)
        if (entry === undefined) usage.set(id, (entry = { used: [], spoke: [], recent: null }))
        return entry
      }
      for (const f of forks) {
        const joined = new Set<string>(f.joined)
        for (const id of joined) {
          const entry = usageOf(id)
          entry.used.push(f)
          if (entry.recent === null || f.recentAt > entry.recent) entry.recent = f.recentAt
        }
        for (const a of f.activity) if (joined.has(a.entityId)) usageOf(a.entityId).spoke.push({ f, a })
      }
      const favourites = new Set((yield* readFavourites(sql, userId)).on)
      const shellCards = metadata
        .filter((m) => byCard.has(m.id))
        .map((m) => {
          const c = byCard.get(m.id)!
          const { used, spoke, recent } = usage.get(c.entityId) ?? { used: [], spoke: [], recent: null }
          spoke.sort(
            (a, b) =>
              b.a.at - a.a.at ||
              Number(a.a.category === "was") - Number(b.a.category === "was") ||
              Number(b.f.current) - Number(a.f.current) ||
              b.f.createdAt - a.f.createdAt
          )
          const latest =
            spoke[0]?.f ??
            [...used].sort((a, b) => Number(b.leaf !== null) - Number(a.leaf !== null) || b.recentAt - a.recentAt)[0]
          // Where its tile opens: the line it last spoke, in the fork it spoke it in.
          const turn = (f: Fork) => f.activity.find((a) => a.entityId === c.entityId)
          const open = [...used].sort(
            (a, b) =>
              (turn(b)?.at ?? -1) - (turn(a)?.at ?? -1) ||
              Number(b.leaf !== null) - Number(a.leaf !== null) ||
              Number(turn(a)?.category === "was") - Number(turn(b)?.category === "was") ||
              Number(b.current) - Number(a.current) ||
              b.createdAt - a.createdAt
          )[0]
          return new ShellCard(
            {
              card: new CardUsage(
                {
                  entityId: c.entityId,
                  refId: m.ref as RefId,
                  headRevisionId: m.revision as RevisionId,
                  label: c.label,
                  subtitle: m.version,
                  name: c.name,
                  avatarMediaId: c.avatarMediaId,
                  ...(c.avatarCrop ? { avatarCrop: c.avatarCrop } : {}),
                  chats: m.persona ? new Set(used.map((f) => f.chat.id)).size : used.length,
                  lastMessageAt: spoke[0]?.a.at ?? (m.persona ? recent : null),
                  latestChatId: (latest?.sourceChatId as ChatId) ?? null
                },
                trusted
              ),
              createdAt: m.created_at,
              addedAt: m.added_at,
              favourite: favourites.has(m.id),
              archivedAt: m.archived_at,
              persona: m.persona === 1,
              open:
                open === undefined
                  ? null
                  : {
                      chatId: open.sourceChatId!,
                      forkId: open.forkId,
                      leaf: open.leaf,
                      slot: (turn(open)?.slot as SlotId | undefined) ?? null
                    },
              recentAt: m.persona ? (spoke[0]?.a.at ?? recent) : recent
            },
            trusted
          )
        })
      const [prefs] = yield* sql<{
        pins_collapsed: number
      }>`SELECT json_extract(value_json, '$') AS pins_collapsed FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = 'shell.pinsCollapsed'`
      const links = new Map<string, SplitChatLink>()
      const parents = new Map<string, string>()
      for (const [id, current] of groupCurrent) {
        const root = byFork.get(id)
        links.set(id, {
          id: id as ChatId,
          chatId: current.chat_id as ChatId,
          forkId: current.id as ForkId,
          rootForkId: id as ForkId,
          title: titles.get(id)!,
          slotId: (markers.has(id) ? (root?.base_slot_id ?? null) : null) as SlotId | null,
          split: markers.has(id) ? (stored.get(id)?.split ?? null) : null
        })
        if (markers.has(id)) {
          let parent = root?.parent_fork_id ?? null
          while (parent !== null) {
            const ancestor = ancestors.get(parent)
            if (!ancestor) break
            const parentGroup = groups.get(ancestor.id)
            if (ancestor.deleted_at === null && parentGroup !== undefined && groupCurrent.has(parentGroup)) {
              parents.set(id, parentGroup)
              break
            }
            parent = ancestor.parent_fork_id
          }
        }
      }
      const state: ShellState = {
        links,
        parents,
        splitChatIds: new Set(ancestry.filter((f) => markers.has(f.id)).map((f) => f.chat_id)),
        cards: shellCards.filter((c) => c.archivedAt == null && !c.persona),
        personas: shellCards.filter((c) => c.archivedAt == null && c.persona),
        archived: shellCards.filter((c) => c.archivedAt != null),
        forks,
        chatIndex: new Map(perChat(forks).map((f) => [f.chat.id, f])),
        pinnedChats,
        pinsCollapsed: prefs?.pins_collapsed === 1,
        fresh: [...fresh].map(([chatId, list]) => ({
          chatId,
          stamp: chatById.get(chatId)!.shell_stamp,
          userStamp,
          forks: JSON.stringify(list)
        }))
      }
      // With what it walked: a caller that didn't store it gets it again (storing moves the version).
      if (recompute !== true) memo = { userId, version, state }
      return state
    })
  const handlers = {
    ShellLibrary: ({ userId, recompute }) =>
      Effect.map(shellState(userId, recompute), (state) => ({
        cards: state.cards,
        forks: state.forks.map(wire),
        people: peopleOf(state.forks),
        pinsCollapsed: state.pinsCollapsed,
        fresh: state.fresh
      })).pipe(query("ShellLibrary")),
    ShellCards: ({ userId }) =>
      Effect.map(shellState(userId, false), (state) => ({
        cards: state.cards,
        personas: state.personas,
        archived: state.archived,
        pinsCollapsed: state.pinsCollapsed,
        fresh: state.fresh
      })).pipe(query("ShellCards")),
    GetSplitChats: ({ userId, chatId, forkId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ current_fork_id: string | null }>`SELECT current_fork_id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const state = yield* shellState(userId, false)
        const shown = state.forks.find(
          (f) => f.sourceChatId === chatId && f.forkId === (forkId ?? chat.current_fork_id)
        )
        if (!shown) return yield* new NotFound({ entity: "branch", id: forkId ?? chatId })
        const group = state.links.get(shown.chat.id)!
        const parentId = state.parents.get(group.id)
        return {
          group,
          parent: parentId ? (state.links.get(parentId) ?? null) : null,
          children: [...state.parents].flatMap(([child, parent]) =>
            parent === group.id ? [state.links.get(child)!] : []
          ),
          forkIds: state.forks.filter((f) => f.chat.id === group.id).map((f) => f.forkId as ForkId),
          hasSplits: state.splitChatIds.has(chatId),
          canSplit: shown.forkId !== group.rootForkId
        }
      }).pipe(query("GetSplitChats")),
    ShellForks: ({ userId, view }) =>
      Effect.gen(function* () {
        const state = yield* shellState(userId, false)
        const sections = view.sections.map(({ id, limit }) => {
          const rows = sectionRows(state, view, id)
          return { id, rows: rows.slice(0, limit), total: rows.length }
        })
        // The Threads group's rows say which thread each is (§13.6 of spec/THREADS.md).
        const threadRows = sections.flatMap((section) => (section.id === "threads" ? section.rows : []))
        const labels = yield* threadLabels(
          sql,
          threadRows.map((f) => ({ forkId: f.forkId, chatId: f.sourceChatId ?? f.chat.id, place: f.threads![0]! }))
        )
        const labelled = (id: ShellSection, f: Fork) => {
          const thread = id === "threads" ? labels.get(f.forkId) : undefined
          return thread ? new ShellFork({ ...wire(f), thread }, trusted) : wire(f)
        }
        // Scope once without the search. Counts represent chats, even if many branches match.
        const chatIds = view.chats === undefined ? null : new Set<string>(view.chats)
        const scoped = perChat(
          state.forks.filter(
            (f) =>
              (view.entity === null || f.joined.includes(view.entity)) &&
              (view.chat === null || f.chat.id === view.chat) &&
              (chatIds === null || chatIds.has(f.chat.id))
          )
        )
        const filterCounts = { all: 0, pinned: 0, groups: 0, solo: 0, branches: 0 } satisfies ChatFilterCounts
        for (const row of scoped)
          for (const filter of CHAT_FILTERS)
            if (inChatFilter(state.chatIndex.get(row.chat.id)!, filter, state.pinnedChats)) filterCounts[filter]++
        return {
          filterCounts,
          sections: sections.map((section) => ({ ...section, rows: section.rows.map((f) => labelled(section.id, f)) })),
          people: peopleOf(sections.flatMap((section) => section.rows)),
          fresh: state.fresh
        }
      }).pipe(query("ShellForks"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return {
    ...handlers,
    ShellCardsLive: (payload: Parameters<typeof handlers.ShellCards>[0]) =>
      Effect.gen(function* () {
        return (yield* liveReady(payload.userId)) ? yield* handlers.ShellCards(payload) : null
      }).pipe(query("ShellCardsLive")),
    ShellForksLive: (payload: Parameters<typeof handlers.ShellForks>[0]) =>
      Effect.gen(function* () {
        return (yield* liveReady(payload.userId)) ? yield* handlers.ShellForks(payload) : null
      }).pipe(query("ShellForksLive"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
