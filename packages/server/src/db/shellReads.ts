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

type Fork = { -readonly [K in keyof Omit<ShellFork, "cast">]: Omit<ShellFork, "cast">[K] } & { cast: Array<CastCard> }
type Activity = ShellFork["activity"][number]

/** What every shell read is made of: the cards, each fork row newest first, and what it had to walk. */
interface ShellState {
  readonly cards: ReadonlyArray<ShellCard>
  readonly forks: ReadonlyArray<Fork>
  readonly pinsCollapsed: boolean
  readonly fresh: ReadonlyArray<ChatSummaries>
}

const trusted = { disableChecks: true } as const

/** A fork's row on the wire: its cast by id, which the read's `people` describe. */
const wire = (f: Fork) => new ShellFork({ ...f, cast: f.cast.map((c) => c.entityId) }, trusted)

/** The cards a set of fork rows names, once. */
const peopleOf = (forks: ReadonlyArray<Fork>) => {
  const people = new Map<string, CastCard>()
  for (const f of forks) for (const c of f.cast) people.set(c.entityId, c)
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

/** Each of `view`'s sections over `forks` (newest first), unlimited. */
const sectionRows = (forks: ReadonlyArray<Fork>, view: ShellForksView, id: ShellSection): ReadonlyArray<Fork> => {
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
  switch (id) {
    case "pinned":
      return sortBy(
        scoped.filter((f) => f.pinned),
        view.sort
      )
    case "chats":
      return perChat(scoped)
    case "just":
    case "with":
    case "was":
      return view.entity === null
        ? []
        : perChat(
            byTurn(
              scoped.filter((f) => categoryOf(f, view.entity!) === id),
              view.entity
            )
          )
    case "current":
      return scoped.filter((f) => f.current)
    case "peers":
      return byLast(scoped.filter(peer))
    case "other":
      return byLast(scoped.filter((f) => !peer(f)))
    case "groups": {
      // The home grid's direction toggle turns the order round (oldest first, Z to A).
      const sorted = sortBy(perChat(scoped.filter((f) => f.cast.length > 1)), view.sort, "chat")
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
        }
      >`
        SELECT e.id, e.created_at, r.created_at AS added_at, r.id AS ref, r.head_revision_id AS revision,
          cs.fields AS card_fields, cs.book AS card_book, cs.book_entries AS card_book_entries,
          EXISTS(SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1)
        LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL
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
        lists: string | null
      }>`
          SELECT f.id, f.chat_id, f.tip_slot_id, f.last_chatted_at, f.name, f.pinned_at, f.created_at, f.parent_fork_id,
            c.title, c.current_fork_id, c.created_at AS chat_created_at, coalesce(c.added_at, c.created_at) AS chat_added_at,
            c.shell_stamp, s.format AS s_format, s.stamp AS s_stamp, s.user_stamp AS s_user_stamp, s.preview,
            s.messages, s.leaf, s.end_at, s.split_at, s.split_after,
            CASE WHEN s.fork_id IS NOT NULL
              THEN '[' || s.cast_json || ',' || s.joined_json || ',' || s.departed_json || ',' || s.activity_json || ']' END AS lists
          FROM chats c CROSS JOIN forks f ON f.chat_id = c.id LEFT JOIN fork_summaries s ON s.fork_id = f.id
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
      const records = joinedRows as unknown as ReadonlyArray<ForkRow>
      const chatById = new Map(
        joinedRows.map((r) => [
          r.chat_id,
          {
            id: r.chat_id,
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
          const [cast, joined, departed, activity] = JSON.parse(row.lists) as [
            Array<string>,
            Array<string>,
            Array<string>,
            ForkSummary["activity"]
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
            joined,
            departed,
            activity
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
            joined: [],
            departed: [],
            activity: []
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
      // A chat's Recent is the latest of its forks' (below), and how many forks it has.
      const chatRecent = new Map<string, number>()
      const branchCount = new Map<string, number>()
      const forks: Array<Fork> = joinedRows.map((record) => {
        const row = chatById.get(record.chat_id)!
        const s = stored.get(record.id)!
        const cast = s.cast.flatMap((id) => byCard.get(id) ?? [])
        // Its last shown message; without one, its chat's start (an imported chat's ST date,
        // never the import's time). The user's activity in it counts too (`last_chatted_at`: a
        // send, a swipe, an edit, and making it by Branch from here), so the chat the user just
        // branched stays on top rather than dropping to the branch point's date. An import never
        // chats in a fork: an ST branch file merged into its chat keeps its ST dates.
        const recentAt = Math.max(s.endAt ?? row.created_at, record.last_chatted_at ?? 0)
        chatRecent.set(row.id, Math.max(chatRecent.get(row.id) ?? 0, recentAt))
        branchCount.set(row.id, (branchCount.get(row.id) ?? 0) + 1)
        return {
          forkId: record.id,
          preview: s.preview,
          messages: s.messages,
          chat: { id: row.id as ChatId, title: row.title, createdAt: row.created_at },
          leaf: s.leaf as SlotId | null,
          name: record.name ?? chatName(importState(row.title).title, cast).name,
          chatName: chatName(importState(row.title).title, cast).name,
          named: record.name !== null,
          current: record.id === row.current_fork_id,
          pinned: record.pinned_at !== null,
          original: record.parent_fork_id === null,
          split: s.split,
          createdAt: record.created_at,
          addedAt: row.added_at,
          endAt: s.endAt,
          recentAt,
          chatRecentAt: 0,
          branches: 0,
          cast,
          joined: s.joined as Array<EntityId>,
          departed: s.departed as Array<EntityId>,
          activity: s.activity as Array<Activity>
        }
      })
      for (const f of forks) {
        f.chatRecentAt = chatRecent.get(f.chat.id)!
        f.branches = branchCount.get(f.chat.id)!
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
        .filter((m) => !m.persona && byCard.has(m.id))
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
                  chats: used.length,
                  lastMessageAt: spoke[0]?.a.at ?? null,
                  latestChatId: (latest?.chat.id as ChatId) ?? null
                },
                trusted
              ),
              createdAt: m.created_at,
              addedAt: m.added_at,
              favourite: favourites.has(m.id),
              open:
                open === undefined
                  ? null
                  : {
                      chatId: open.chat.id,
                      forkId: open.forkId,
                      leaf: open.leaf,
                      slot: (turn(open)?.slot as SlotId | undefined) ?? null
                    },
              recentAt: recent
            },
            trusted
          )
        })
      const [prefs] = yield* sql<{
        pins_collapsed: number
      }>`SELECT pins_collapsed FROM shell_preferences WHERE user_id = ${userId}`
      const state: ShellState = {
        cards: shellCards,
        forks,
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
  return {
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
        pinsCollapsed: state.pinsCollapsed,
        fresh: state.fresh
      })).pipe(query("ShellCards")),
    ShellForks: ({ userId, view }) =>
      Effect.map(shellState(userId, false), (state) => {
        const sections = view.sections.map(({ id, limit }) => {
          const rows = sectionRows(state.forks, view, id)
          return { id, rows: rows.slice(0, limit), total: rows.length }
        })
        return {
          sections: sections.map((section) => ({ ...section, rows: section.rows.map(wire) })),
          people: peopleOf(sections.flatMap((section) => section.rows)),
          fresh: state.fresh
        }
      }).pipe(query("ShellForks"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
