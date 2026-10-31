// The shell's library: cards, forks and who is in each. Runs in a reader worker. Each fork's
// walk is kept in `fork_summaries` (db/forkSummaries.ts); a read computes only the chats whose
// summaries are stale and returns them for the caller to store, so its cost is the cards and
// forks, plus the messages of what changed since.
import type { CastCard, ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { CardUsage, ShellCard, ShellFork } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { loadCards } from "./cards.ts"
import {
  computeForkSummaries,
  FORK_SUMMARY_FORMAT,
  type ForkSummary,
  fromRow,
  summaryStamps,
  type SummaryRow
} from "./forkSummaries.ts"
import type { ReadOps } from "./ops.ts"
import type { ChatRow, ForkRow } from "./rows.ts"
import { query } from "./tx.ts"

type Fork = { -readonly [K in keyof Omit<ShellFork, "cast">]: Omit<ShellFork, "cast">[K] } & { cast: Array<CastCard> }
type Activity = ShellFork["activity"][number]

export const makeShellReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ShellLibrary: ({ userId, recompute }) =>
      Effect.gen(function* () {
        const cards = (yield* loadCards(sql, userId, null)).map(({ card }) => card).filter((c) => !c.inBin)
        const byCard = new Map(cards.map((c) => [c.entityId as string, c]))
        // A card's own recency is its addition or a later edit of the user's (an import's
        // revisions aren't: an imported card dates from ST's create_date, §13).
        const metadata = yield* sql<{
          id: string
          created_at: number
          edited: number
          ref: string
          revision: string
          subtitle: string
          persona: number
        }>`
        SELECT e.id, e.created_at, max(e.created_at, coalesce((SELECT max(x.created_at) FROM entity_revisions x
            WHERE x.entity_id = e.id AND x.origin <> 'import'), 0)) AS edited, r.id AS ref,
          rev.id AS revision, CASE WHEN json_type(rev.doc_json, '$.character_version') = 'text' THEN json_extract(rev.doc_json, '$.character_version') ELSE '' END AS subtitle, EXISTS(SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL`
        // The stamps first: what follows is read in the same transaction.
        const userStamp = yield* summaryStamps(sql, userId)
        const chats = yield* sql<ChatRow & { shell_stamp: number }>`SELECT * FROM chats
          WHERE owner_user_id = ${userId} AND deleted_at IS NULL`
        const records = yield* sql<ForkRow>`SELECT f.* FROM chats c CROSS JOIN forks f ON f.chat_id = c.id
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
        const chatById = new Map(chats.map((c) => [c.id, c]))
        const stored = new Map<string, ForkSummary>()
        if (recompute !== true) {
          const rows = yield* sql<SummaryRow & { format: number; stamp: number; user_stamp: number; current: number }>`
            SELECT s.*, c.shell_stamp AS current FROM chats c CROSS JOIN forks f ON f.chat_id = c.id
            CROSS JOIN fork_summaries s ON s.fork_id = f.id
            WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
          for (const row of rows)
            if (row.format === FORK_SUMMARY_FORMAT && row.stamp === row.current && row.user_stamp === userStamp)
              stored.set(row.fork_id, fromRow(row))
        }
        const stale = new Set(records.flatMap((r) => (stored.has(r.id) ? [] : [r.chat_id])))
        const computed = yield* computeForkSummaries(
          sql,
          records.filter((r) => stale.has(r.chat_id))
        )
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
            return new ShellCard({
              card: new CardUsage({
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
              }),
              createdAt: m.created_at,
              recentAt: Math.max(m.edited, spoke[0]?.a.at ?? 0)
            })
          })
        const [prefs] = yield* sql<{
          pins_collapsed: number
        }>`SELECT pins_collapsed FROM shell_preferences WHERE user_id = ${userId}`
        return {
          cards: shellCards,
          forks: forks
            .sort((a, b) => b.recentAt - a.recentAt || a.chat.id.localeCompare(b.chat.id))
            .map((f) => new ShellFork({ ...f, cast: f.cast.map((c) => c.entityId) })),
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
