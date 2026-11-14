import { makeShellEpoch } from "./shellEpoch.ts"
import { shownInSql } from "./forkState.ts"
import type { SplitChatLink } from "@rp/shared/splitChat.ts"
import {
  type ShellState,
  type Fork,
  type Activity,
  trusted,
  wire,
  perChat,
  libraryView,
  cardsView,
  forksView,
  sectionsOf
} from "./shellViews.ts"
import { splitChatMarkers, splitGroups } from "./splitChats.ts"
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
import { chatName } from "@rp/shared/chatName.ts"
import { CardUsage, ShellCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import {
  computeForkSummaries,
  computeForkOutlines,
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
  const shellState = (userId: string, recompute: boolean | undefined, chatId?: string) =>
    Effect.gen(function* () {
      // The stamps first, which also opens the transaction's snapshot: the version read next is its own.
      const userStamp = yield* summaryStamps(sql, userId)
      const [{ data_version: version }] = (yield* sql<{ data_version: number }>`PRAGMA data_version`) as [
        { data_version: number }
      ]
      if (
        chatId === undefined &&
        recompute !== true &&
        memo !== null &&
        memo.userId === userId &&
        memo.version === version
      )
        return memo.state
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
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
            AND (${chatId ?? null} IS NULL OR c.id = ${chatId ?? null})`
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
      const computed = yield* chatId === undefined
        ? computeForkSummaries(sql, staleRecords)
        : computeForkOutlines(sql, staleRecords)
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
        WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL
          AND (${chatId ?? null} IS NULL OR c.id = ${chatId ?? null})`
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
        people: byCard,
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
      if (chatId === undefined && recompute !== true) memo = { userId, version, state }
      return state
    })
  // Only bounded metadata in the foreground; complex groups/titles use the
  // background operation, which leaves a reader for independent startup reads.
  const splitMetadata = (userId: string, chatId: ChatId, forkId: ForkId | null) =>
    Effect.gen(function* () {
      const [chat] = yield* sql<{
        current_fork_id: string | null
        title: string
        created_at: number
      }>`SELECT current_fork_id, title, created_at FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
      if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
      const [ownedFork] = yield* sql`SELECT 1 FROM forks WHERE chat_id = ${chatId}
          AND id = ${forkId ?? chat.current_fork_id} AND deleted_at IS NULL`
      if (!ownedFork) return yield* new NotFound({ entity: "branch", id: forkId ?? chatId })
      // No graph walk is needed for an explicitly titled, unsplit chat whose
      // overrides only select/replace versions. Fork-state probes resolve its ends.
      // Fail closed to the scoped outline whenever endpoint or title semantics need it.
      const title = importState(chat.title)
      if (!title.unfinished && title.title.trim() !== "" && chatName(title.title, []).started === null) {
        const [complex] = yield* sql`SELECT 1 FROM forks WHERE chat_id = ${chatId} AND split_chat = 1
            UNION ALL SELECT 1 FROM fork_overrides WHERE chat_id = ${chatId}
              AND kind NOT IN ('select', 'replace') LIMIT 1`
        if (!complex) {
          const rows = yield* sql<{
            id: string
            tip_slot_id: string | null
            created_at: number
            last_chatted_at: number | null
            end_at: number | null
            version_id: string | null
            deleted_at: number | null
            purged_at: number | null
            version_deleted_at: number | null
            version_purged_at: number | null
          }>`SELECT f.id, f.tip_slot_id, f.created_at, f.last_chatted_at, v.id AS version_id,
                s.deleted_at, s.purged_at,
                v.deleted_at AS version_deleted_at, v.purged_at AS version_purged_at,
                CASE WHEN v.origin IN ('edited', 'changeset') THEN s.created_at ELSE v.created_at END AS end_at
              FROM forks f LEFT JOIN slots s ON s.id = f.tip_slot_id
              LEFT JOIN versions v ON v.slot_id = s.id AND v.id = ${sql.literal(shownInSql("f.id", "s"))}
              WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL`
          const asked = rows.find((row) => row.id === (forkId ?? chat.current_fork_id))
          if (!asked) return yield* new NotFound({ entity: "branch", id: forkId ?? chatId })
          if (
            rows.every(
              (row) =>
                row.tip_slot_id === null ||
                (row.version_id !== null &&
                  row.deleted_at === null &&
                  row.purged_at === null &&
                  row.version_deleted_at === null &&
                  row.version_purged_at === null)
            )
          ) {
            const recency = (row: typeof asked) => Math.max(row.created_at, row.last_chatted_at ?? 0)
            const current =
              rows.find((row) => row.id === chat.current_fork_id) ??
              rows.reduce((a, b) => (recency(b) > recency(a) || (recency(b) === recency(a) && b.id > a.id) ? b : a))
            const recent = (row: typeof asked) => Math.max(row.end_at ?? chat.created_at, row.last_chatted_at ?? 0)
            const ordered = [...rows].sort(
              (a, b) => Number(b.id === current.id) - Number(a.id === current.id) || recent(b) - recent(a)
            )
            return {
              group: {
                id: chatId,
                chatId,
                forkId: current.id as ForkId,
                rootForkId: chatId as unknown as ForkId,
                title: chatName(title.title, []).name,
                slotId: null,
                split: null
              },
              parent: null,
              children: [],
              forkIds: ordered.map((row) => row.id as ForkId),
              hasSplits: false,
              canSplit: asked.id !== chatId
            }
          }
        }
      }
      return null
    })
  const shellEpoch = makeShellEpoch(sql)
  const handlers = {
    ShellEpoch: ({ userId }) => shellEpoch(userId).pipe(query("ShellEpoch")),
    ShellMaterialize: ({ userId }) =>
      Effect.gen(function* () {
        const state = yield* shellState(userId, false)
        const labels = yield* threadLabels(
          sql,
          state.forks.flatMap((f) =>
            f.threads === undefined
              ? []
              : [
                  {
                    forkId: f.forkId,
                    chatId: f.sourceChatId ?? f.chat.id,
                    place: f.threads[0]!
                  }
                ]
          )
        )
        return {
          ...cardsView(state),
          forks: state.forks.map(wire),
          people: [...state.people.values()],
          pinnedChats: [...state.pinnedChats],
          labels: [...labels].map(([forkId, thread]) => ({ forkId, thread }))
        }
      }).pipe(query("ShellMaterialize")),
    ShellLibrary: ({ userId, recompute }) =>
      Effect.map(shellState(userId, recompute), libraryView).pipe(query("ShellLibrary")),
    ShellCards: ({ userId }) => Effect.map(shellState(userId, false), cardsView).pipe(query("ShellCards")),
    GetSplitChatsFast: ({ userId, chatId, forkId }) =>
      splitMetadata(userId, chatId, forkId).pipe(query("GetSplitChatsFast")),
    GetSplitChats: ({ userId, chatId, forkId }) =>
      Effect.gen(function* () {
        const fast = yield* splitMetadata(userId, chatId, forkId)
        if (fast !== null) return fast
        const [chat] = yield* sql<{ current_fork_id: string | null }>`SELECT current_fork_id FROM chats
          WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const state = yield* shellState(userId, false, chatId)
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
        const rows = sectionsOf(state, view).flatMap((section) => section.rows.filter((f) => f.threads !== undefined))
        const labels = yield* threadLabels(
          sql,
          rows.map((f) => ({
            forkId: f.forkId,
            chatId: f.sourceChatId ?? f.chat.id,
            place: f.threads![0]!
          }))
        )
        return forksView(state, view, labels)
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
