// The shell's library: cards, forks and who is in each. Runs in a reader worker. Each fork's
// walk is kept in `fork_summaries` (db/forkSummaries.ts); a read computes only the chats whose
// summaries are stale and returns them for the caller to store, so its cost is the cards and
// forks, plus the messages of what changed since.
import { CastCard, type ChatId, type EntityId, type SlotId } from "@rp/shared/chat.ts"
import { modelName } from "@rp/shared/cardNames.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { CardUsage, ShellCard, ShellFork } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { computeForkSummaries, FORK_SUMMARY_FORMAT, type ForkSummary, summaryStamps } from "./forkSummaries.ts"
import type { ReadOps } from "./ops.ts"
import type { ForkRow } from "./rows.ts"
import { query } from "./tx.ts"

type Fork = { -readonly [K in keyof Omit<ShellFork, "cast">]: Omit<ShellFork, "cast">[K] } & { cast: Array<CastCard> }
type Activity = ShellFork["activity"][number]

export const makeShellReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ShellLibrary: ({ userId, recompute }) =>
      Effect.gen(function* () {
        // Each live card's names, avatar and lorebook flags, read by SQLite from its head
        // revision: the shell never needs the rest of the document, which can be megabytes.
        // A card's own recency is its addition or a later edit of the user's (an import's
        // revisions aren't: an imported card dates from ST's create_date, §13).
        const rows = yield* sql<{
          id: string
          created_at: number
          edited: number
          ref: string
          revision: string
          fields: string
          book: number
          book_entries: number | null
          persona: number
        }>`
        SELECT e.id, e.created_at, max(e.created_at, coalesce((SELECT max(x.created_at) FROM entity_revisions x
            WHERE x.entity_id = e.id AND x.origin <> 'import'), 0)) AS edited, r.id AS ref, rev.id AS revision,
          -- One parse of the document for the strings (a missing or non-string value reads as empty
          -- below), and the lorebook's type and size without returning its entries.
          json_extract(rev.doc_json, '$.name', '$.nickname', '$.character_version', '$.avatar_media_id',
            '$.character_book.name') AS fields,
          json_type(rev.doc_json, '$.character_book') = 'object' AS book,
          CASE WHEN json_type(rev.doc_json, '$.character_book.entries') = 'array'
            THEN json_array_length(rev.doc_json, '$.character_book.entries') ELSE 0 END AS book_entries,
          EXISTS(SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL
        ORDER BY r.label COLLATE NOCASE, e.id`
        // Built from what the read just made: no constructor checks (the RPC encodes it anyway).
        const trusted = { disableChecks: true } as const
        const text = (value: unknown) => (typeof value === "string" ? value : "")
        const metadata = rows.map((row) => {
          const [name, nickname, subtitle, avatar, bookName] = JSON.parse(row.fields) as Array<unknown>
          return {
            ...row,
            name: text(name),
            nickname: text(nickname),
            subtitle: text(subtitle),
            avatar: typeof avatar === "string" ? avatar : null,
            bookName: text(bookName).trim()
          }
        })
        const byCard = new Map(
          metadata.map((m) => [
            m.id,
            new CastCard(
              {
                entityId: m.id as EntityId,
                name: m.name,
                label: m.name,
                modelName: modelName({ name: m.name, nickname: m.nickname }),
                subtitle: m.subtitle,
                persona: m.persona === 1,
                inBin: false,
                lorebook: m.book === 1,
                ...(m.book === 1 && m.bookName !== "" ? { lorebookName: m.bookName } : {}),
                ...(m.book === 1 ? { lorebookEntries: m.book_entries ?? 0 } : {}),
                avatarMediaId: m.avatar
              },
              trusted
            )
          ])
        )
        // The stamps first: what follows is read in the same transaction.
        const userStamp = yield* summaryStamps(sql, userId)
        // Each live fork with its chat and its stored summary, when there is one: only what the shell shows.
        const joinedRows = yield* sql<{
          id: string
          chat_id: string
          tip_slot_id: string | null
          name: string | null
          pinned_at: number | null
          created_at: number
          title: string
          current_fork_id: string | null
          shell_stamp: number
          s_format: number | null
          s_stamp: number | null
          s_user_stamp: number | null
          preview: string | null
          messages: number | null
          leaf: string | null
          end_at: number | null
          lists: string | null
        }>`
          SELECT f.id, f.chat_id, f.tip_slot_id, f.name, f.pinned_at, f.created_at, c.title, c.current_fork_id,
            c.shell_stamp, s.format AS s_format, s.stamp AS s_stamp, s.user_stamp AS s_user_stamp, s.preview,
            s.messages, s.leaf, s.end_at,
            CASE WHEN s.fork_id IS NOT NULL
              THEN '[' || s.cast_json || ',' || s.joined_json || ',' || s.departed_json || ',' || s.activity_json || ']' END AS lists
          FROM chats c CROSS JOIN forks f ON f.chat_id = c.id LEFT JOIN fork_summaries s ON s.fork_id = f.id
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
        const records = joinedRows as unknown as ReadonlyArray<ForkRow>
        const chatById = new Map(
          joinedRows.map((r) => [
            r.chat_id,
            { id: r.chat_id, title: r.title, current_fork_id: r.current_fork_id, shell_stamp: r.shell_stamp }
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
              cast: [],
              joined: [],
              departed: [],
              activity: []
            })
        const stale = new Set(records.flatMap((r) => (stored.has(r.id) ? [] : [r.chat_id])))
        // A stale chat's walk needs its forks' full rows.
        const staleRecords =
          stale.size === 0
            ? []
            : yield* sql<ForkRow>`SELECT f.* FROM json_each(${JSON.stringify([...stale])}) j
                CROSS JOIN forks f ON f.chat_id = j.value WHERE f.deleted_at IS NULL`
        const computed = yield* computeForkSummaries(sql, staleRecords)
        const fresh = new Map<string, Array<ForkSummary>>()
        for (const summary of computed) {
          stored.set(summary.forkId, summary)
          const list = fresh.get(summary.chatId) ?? []
          list.push(summary)
          fresh.set(summary.chatId, list)
        }
        const forks: Array<Fork> = records.map((record) => {
          const row = chatById.get(record.chat_id)!
          const s = stored.get(record.id)!
          const cast = s.cast.flatMap((id) => byCard.get(id) ?? [])
          return {
            forkId: record.id,
            preview: s.preview,
            messages: s.messages,
            chat: { id: row.id as ChatId, title: row.title },
            leaf: s.leaf as SlotId | null,
            name: record.name ?? chatName(importState(row.title).title, cast).name,
            named: record.name !== null,
            current: record.id === row.current_fork_id,
            pinned: record.pinned_at !== null,
            createdAt: record.created_at,
            recentAt: s.endAt ?? record.created_at,
            cast,
            joined: s.joined as Array<EntityId>,
            departed: s.departed as Array<EntityId>,
            activity: s.activity as Array<Activity>
          }
        })
        const people = new Map<string, CastCard>()
        for (const f of forks) for (const c of f.cast) people.set(c.entityId, c)
        // Each card's forks and turns, in one pass over the forks, in their order.
        const usage = new Map<string, { used: Array<Fork>; spoke: Array<{ f: Fork; a: Activity }> }>()
        const usageOf = (id: string) => {
          let entry = usage.get(id)
          if (entry === undefined) usage.set(id, (entry = { used: [], spoke: [] }))
          return entry
        }
        for (const f of forks) {
          const joined = new Set<string>(f.joined)
          for (const id of joined) usageOf(id).used.push(f)
          for (const a of f.activity) if (joined.has(a.entityId)) usageOf(a.entityId).spoke.push({ f, a })
        }
        const shellCards = metadata
          .filter((m) => !m.persona && byCard.has(m.id))
          .map((m) => {
            const c = byCard.get(m.id)!
            const { used, spoke } = usage.get(c.entityId) ?? { used: [], spoke: [] }
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
            return new ShellCard(
              {
                card: new CardUsage(
                  {
                    entityId: c.entityId,
                    refId: m.ref as RefId,
                    headRevisionId: m.revision as RevisionId,
                    label: c.label,
                    subtitle: m.subtitle,
                    name: c.name,
                    avatarMediaId: c.avatarMediaId,
                    chats: used.length,
                    lastMessageAt: spoke[0]?.a.at ?? null,
                    latestChatId: (latest?.chat.id as ChatId) ?? null
                  },
                  trusted
                ),
                createdAt: m.created_at,
                recentAt: Math.max(m.edited, spoke[0]?.a.at ?? 0)
              },
              trusted
            )
          })
        const [prefs] = yield* sql<{
          pins_collapsed: number
        }>`SELECT pins_collapsed FROM shell_preferences WHERE user_id = ${userId}`
        return {
          cards: shellCards,
          forks: forks
            .sort((a, b) => b.recentAt - a.recentAt || a.chat.id.localeCompare(b.chat.id))
            .map((f) => new ShellFork({ ...f, cast: f.cast.map((c) => c.entityId) }, trusted)),
          people: [...people.values()],
          pinsCollapsed: prefs?.pins_collapsed === 1,
          fresh: [...fresh].map(([chatId, list]) => ({
            chatId,
            stamp: chatById.get(chatId)!.shell_stamp,
            userStamp,
            forks: JSON.stringify(list)
          }))
        }
      }).pipe(query("ShellLibrary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
