// Graph metadata and bounded excerpts at visible endpoints. Runs in a reader worker.
import { type CastCard, type ChatId, type EntityId, type SlotId } from "@rp/shared/chat.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { CardUsage, ShellCard, ShellFork, ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { branchOwned, foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { shellSlotsQuery, shellEventsQuery } from "./shellQueries.ts"
import { loadCards } from "./cards.ts"
import type { ReadOps } from "./ops.ts"
import type { ChatRow, ForkRow } from "./rows.ts"
import { withoutPurged } from "./stateRefs.ts"
import { query } from "./tx.ts"

type Slot = {
  fork_id: string
  id: string
  chat_id: string
  parent_slot_id: string | null
  created_at: number
  deleted_at: number | null
  speaker: string | null
  at: number
  depth: number
  preview: string
}
type Event = FoldableEvent & { fork_id: string; chat_id: string; slot_id: string | null }
// Built plainly during the walk; each becomes a ShellFork once, with its excerpt.
type Fork = { -readonly [K in keyof Omit<ShellFork, "cast">]: Omit<ShellFork, "cast">[K] } & { cast: Array<CastCard> }

export const makeShellReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ShellLibrary: ({ userId }) =>
      Effect.gen(function* () {
        const cards = (yield* loadCards(sql, userId, null)).map(({ card }) => card).filter((c) => !c.inBin)
        const byCard = new Map(cards.map((c) => [c.entityId as string, c]))
        const metadata = yield* sql<{
          id: string
          created_at: number
          recent: number
          ref: string
          revision: string
          subtitle: string
          persona: number
        }>`
        SELECT e.id, e.created_at, max(e.created_at, rev.created_at) AS recent, r.id AS ref,
          rev.id AS revision, CASE WHEN json_type(rev.doc_json, '$.character_version') = 'text' THEN json_extract(rev.doc_json, '$.character_version') ELSE '' END AS subtitle, EXISTS(SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id AND ref_kind = 'upstream' LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL`
        const chats = yield* sql<ChatRow>`SELECT * FROM chats WHERE owner_user_id = ${userId} AND deleted_at IS NULL`
        const records = yield* sql<ForkRow>`SELECT f.* FROM chats c CROSS JOIN forks f ON f.chat_id = c.id
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`
        const slots = yield* sql.unsafe<Slot>(shellSlotsQuery, [userId])
        const raw = yield* sql.unsafe<{
          fork_id: string
          chat_id: string
          slot_id: string | null
          scope: string
          key: string
          value_json: string
        }>(shellEventsQuery, [userId])
        const events = (yield* withoutPurged(
          sql,
          raw.map((e) => ({ ...e, data: { key: e.key, value: JSON.parse(e.value_json) } })) as Array<Event>,
          (event) => event.fork_id
        )) as ReadonlyArray<Event>
        const eventsByFork = new Map<string, Array<Event>>()
        for (const event of events) {
          const list = eventsByFork.get(event.fork_id) ?? []
          list.push(event)
          eventsByFork.set(event.fork_id, list)
        }
        const slotsByFork = new Map<string, Map<string, Slot>>()
        for (const slot of slots) {
          const map = slotsByFork.get(slot.fork_id) ?? new Map<string, Slot>()
          map.set(slot.id, slot)
          slotsByFork.set(slot.fork_id, map)
        }
        const chatById = new Map(chats.map((c) => [c.id, c]))
        const forks: Array<Fork> = []
        for (const record of records) {
          const row = chatById.get(record.chat_id)!
          const map = slotsByFork.get(record.id)
          // Iterative, including an interior checkpoint and every same-tip peer.
          const path: Array<Slot> = []
          let slot = map?.get(record.tip_slot_id ?? "")
          while (slot) {
            path.push(slot)
            const parent = map?.get(slot.parent_slot_id ?? "")
            slot = parent && parent.depth < slot.depth ? parent : undefined
          }
          path.reverse()
          const onPath = new Set(path.map((s) => s.id))
          const applicable = (eventsByFork.get(record.id) ?? []).filter(
            (e) => e.slot_id === null || onPath.has(e.slot_id)
          )
          const branch = applicable.filter((e) => branchOwned.has(e.data.key))
          const positional = new Map<string, Array<Event>>()
          for (const e of applicable) {
            if (branchOwned.has(e.data.key)) continue
            const key = e.slot_id ?? ""
            const list = positional.get(key) ?? []
            list.push(e)
            positional.set(key, list)
          }
          let state = foldState(positional.get("") ?? [])
          const joined = new Set([
            ...state.participants,
            ...foldState(branch, state).participants,
            ...applicable.flatMap(({ data }) =>
              data.key === "participant.join" || data.key === "card.swap" ? [data.value.entity] : []
            )
          ])
          const activity = new Map<
            string,
            { entityId: EntityId; at: number; slot: SlotId; category: "just" | "with" | "was" }
          >()
          let endpoint: Slot | undefined
          let messages = 0
          for (const s of path) {
            if (s.deleted_at !== null) continue
            messages++
            endpoint = s
            state = foldState(positional.get(s.id) ?? [], state)
            const here = foldState(branch, state)
            for (const id of here.participants) joined.add(id)
            if (s.speaker !== null && !here.playedByMe.includes(s.speaker))
              activity.set(s.speaker, {
                entityId: s.speaker as EntityId,
                at: s.at,
                slot: s.id as SlotId,
                category: "just"
              })
          }
          state = foldState(branch, state)
          const cast = state.participants
            .filter((id) => !state.playedByMe.includes(id))
            .flatMap((id) => byCard.get(id) ?? [])
          const present = state.participants.filter(
            (id) => !state.playedByMe.includes(id) && !state.absent.includes(id)
          )
          forks.push({
            forkId: record.id,
            preview: endpoint?.preview ?? "",
            messages,
            chat: { id: row.id as ChatId, title: row.title },
            leaf: (endpoint?.id as SlotId) ?? null,
            name: record.name ?? chatName(importState(row.title).title, cast).name,
            named: record.name !== null,
            current: record.id === row.current_fork_id,
            pinned: record.pinned_at !== null,
            createdAt: record.created_at,
            recentAt: endpoint?.at ?? record.created_at,
            cast,
            joined: [...joined] as Array<EntityId>,
            departed: [...joined].filter((id) => !state.participants.includes(id)) as Array<EntityId>,
            activity: [...activity.values()].map((a) => ({
              ...a,
              category: !state.participants.includes(a.entityId)
                ? "was"
                : present.some((id) => id !== a.entityId)
                  ? "with"
                  : "just"
            }))
          })
        }
        const people = new Map<string, CastCard>()
        for (const f of forks) for (const c of f.cast) people.set(c.entityId, c)
        const shellCards = metadata
          .filter((m) => !m.persona && byCard.has(m.id))
          .map((m) => {
            const c = byCard.get(m.id)!
            const used = forks.filter((f) => f.joined.includes(c.entityId))
            const spoke = used
              .flatMap((f) => f.activity.filter((a) => a.entityId === c.entityId).map((a) => ({ f, a })))
              .sort(
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
              recentAt: Math.max(m.recent, spoke[0]?.a.at ?? 0)
            })
          })
        const [prefs] = yield* sql<{
          pins_collapsed: number
        }>`SELECT pins_collapsed FROM shell_preferences WHERE user_id = ${userId}`
        return new ShellLibrary({
          cards: shellCards,
          forks: forks
            .sort((a, b) => b.recentAt - a.recentAt || a.chat.id.localeCompare(b.chat.id))
            .map(
              (f) =>
                new ShellFork({
                  ...f,
                  cast: f.cast.map((c) => c.entityId)
                })
            ),
          people: [...people.values()],
          pinsCollapsed: prefs?.pins_collapsed === 1
        })
      }).pipe(query("ShellLibrary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
