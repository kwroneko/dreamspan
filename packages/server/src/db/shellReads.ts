// Graph metadata and bounded excerpts at visible endpoints. Runs in a reader worker.
import { type CastCard, type ChatId, type EntityId, type SlotId } from "@rp/shared/chat.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { CardUsage, ShellCard, ShellFork, ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { foldState, type FoldableEvent } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { shownInSql } from "./forkState.ts"
import { shellSlotsQuery, shellEventsQuery, tipForkSql } from "./shellQueries.ts"
import { loadCards } from "./cards.ts"
import type { ReadOps } from "./ops.ts"
import type { ChatRow } from "./rows.ts"
import { withoutPurged } from "./stateRefs.ts"
import { query } from "./tx.ts"

type Slot = {
  id: string
  chat_id: string
  parent_slot_id: string | null
  created_at: number
  branch_name: string | null
  selected_version_id: string
  deleted_at: number | null
  branch_deleted: number
  speaker: string | null
  writer: string
  at: number
  depth: number
}
type Event = FoldableEvent & { chat_id: string; slot_id: string | null; version_id: string | null }
// Built plainly during the walk; each becomes a ShellFork once, with its excerpt.
type Fork = Omit<ShellFork, "cast"> & { cast: Array<CastCard> }

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
        FROM entities e JOIN entity_refs r ON r.id = (SELECT id FROM entity_refs WHERE entity_id = e.id AND ref_kind <> 'chat_override' ORDER BY ref_kind = 'upstream' DESC, created_at, id LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL AND e.purged_at IS NULL AND e.archived_at IS NULL`
        // The chat's current fork ends at its active leaf (schema/forks.ts), which is where the shell's current is.
        const chats = (yield* sql<
          ChatRow & { current_leaf_slot_id: string | null }
        >`SELECT * FROM chats WHERE owner_user_id = ${userId} AND deleted_at IS NULL`).map((row) => ({
          ...row,
          current_leaf_slot_id: row.active_leaf_slot_id
        }))
        const slots = yield* sql.unsafe<Slot>(shellSlotsQuery, [userId])
        const raw = yield* sql.unsafe<{
          chat_id: string
          slot_id: string | null
          version_id: string | null
          scope: string
          key: string
          value_json: string
        }>(shellEventsQuery, [userId])
        const events = (yield* withoutPurged(
          sql,
          raw.map((e) => ({ ...e, data: { key: e.key, value: JSON.parse(e.value_json) } })) as Array<Event>
        )) as Array<Event>
        const eventsAt = new Map<string, Array<Event>>()
        for (const e of events) {
          const key = e.slot_id ?? e.chat_id
          const list = eventsAt.get(key) ?? []
          list.push(e)
          eventsAt.set(key, list)
        }
        const pins = yield* sql<{
          chat_id: string
          fork_id: string
        }>`SELECT chat_id, fork_id FROM chat_pins WHERE user_id = ${userId}`
        const pinned = new Set(pins.map((p) => `${p.chat_id}/${p.fork_id}`))
        // A fork's own name and pin (SetForkName, SetForkPinned) belong to the fork ending at this leaf.
        const named = yield* sql<{
          chat_id: string
          tip_slot_id: string
          name: string | null
          pinned: number
        }>`SELECT f.chat_id, f.tip_slot_id, f.name, f.pinned_at IS NOT NULL AS pinned FROM forks f JOIN chats c ON c.id = f.chat_id
          WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL AND f.tip_slot_id IS NOT NULL
            AND (f.name IS NOT NULL OR f.pinned_at IS NOT NULL)`
        const forkNames = new Map(
          named.flatMap((f) => (f.name === null ? [] : [[`${f.chat_id}/${f.tip_slot_id}`, f.name]]))
        )
        const forkPins = new Set(named.filter((f) => f.pinned === 1).map((f) => `${f.chat_id}/${f.tip_slot_id}`))
        const slotById = new Map(slots.map((s) => [s.id, s]))
        const children = new Map<string, Array<Slot>>()
        for (const s of slots) {
          const key = s.parent_slot_id ?? s.chat_id
          const list = children.get(key) ?? []
          list.push(s)
          children.set(key, list)
        }
        const forks: Array<Fork> = []
        // Iterative walk: avoids recursion limits on long imported conversations.
        for (const row of chats) {
          const firstFork = forks.length
          const base = foldState(eventsAt.get(row.id) ?? [])
          type Walk = {
            slot: Slot
            state: typeof base
            joined: Set<string>
            activity: Map<string, { entityId: EntityId; at: number; slot: SlotId; category: "just" | "with" | "was" }>
            fork: string
            name: string | null
            created: number
            current: boolean
            liveLeaf: string | null
            recent: number
          }
          const stack: Array<Walk> = (children.get(row.id) ?? []).map((slot) => ({
            slot,
            state: base,
            joined: new Set(base.participants),
            activity: new Map(),
            fork: "",
            name: null,
            created: row.created_at,
            liveLeaf: null,
            recent: row.created_at,
            current: false
          }))
          const chat = { id: row.id as ChatId, title: row.title }
          const emptyFork = (): Fork => {
            const cast = base.participants
              .filter((id) => !base.playedByMe.includes(id))
              .flatMap((id) => byCard.get(id) ?? [])
            return {
              forkId: "",
              preview: "",
              messages: 0,
              chat,
              leaf: null,
              name: chatName(importState(row.title).title, cast).name,
              current: true,
              named: false,
              pinned: pinned.has(`${row.id}/`),
              createdAt: row.created_at,
              recentAt: row.last_message_at ?? row.created_at,
              cast,
              joined: base.participants as Array<EntityId>,
              departed: [],
              activity: []
            }
          }
          if (stack.length === 0) forks.push(emptyFork())
          while (stack.length) {
            const item = stack.pop()!
            const s = item.slot
            const liveLeaf = s.deleted_at === null ? s.id : item.liveLeaf
            const recent = s.deleted_at === null ? s.at : item.recent
            if (s.branch_deleted) continue
            const applicable = (eventsAt.get(s.id) ?? []).filter(
              (e) => s.deleted_at === null && (e.version_id === null || e.version_id === s.selected_version_id)
            )
            // foldState takes an initial state, so branch state follows exactly the same rules as GetCast.
            let state = item.state
            for (const e of applicable) state = foldState([e], state)
            const joined = new Set([...item.joined, ...state.participants])
            const siblings = children.get(s.parent_slot_id ?? s.chat_id) ?? []
            const fork = siblings.findIndex((x) => x.id === s.id) > 0 ? s.id : item.fork
            const name = s.branch_name ?? (fork !== item.fork ? null : item.name)
            const activity =
              (children.get(s.parent_slot_id ?? s.chat_id)?.length ?? 0) > 1 ? new Map(item.activity) : item.activity
            const present = state.participants.filter(
              (id) => !state.playedByMe.includes(id) && !state.absent.includes(id)
            )
            if (s.deleted_at === null && s.speaker !== null && !state.playedByMe.includes(s.speaker))
              activity.set(s.speaker, {
                entityId: s.speaker as EntityId,
                at: s.at,
                slot: s.id as SlotId,
                category: present.filter((id) => id !== s.speaker).length === 0 ? "just" : "with"
              })
            const current = item.current || s.id === row.current_leaf_slot_id
            const next = (children.get(s.id) ?? []).filter((x) => !x.branch_deleted)
            if (next.length) {
              // Only branch points copy these small maps; the next iteration owns the state.
              for (const slot of next)
                stack.push({
                  slot,
                  state,
                  joined,
                  activity,
                  fork,
                  name,
                  created: fork !== item.fork ? s.created_at : item.created,
                  current,
                  liveLeaf,
                  recent
                })
            } else {
              const cast = state.participants
                .filter((id) => !state.playedByMe.includes(id))
                .flatMap((id) => byCard.get(id) ?? [])
              const given = liveLeaf === null ? undefined : forkNames.get(`${row.id}/${liveLeaf}`)
              forks.push({
                forkId: fork,
                preview: "",
                messages: liveLeaf ? (slotById.get(liveLeaf)?.depth ?? -1) + 1 : 0,
                chat,
                leaf: liveLeaf as SlotId | null,
                name: given ?? name ?? chatName(importState(row.title).title, cast).name,
                named: given !== undefined || name !== null,
                current:
                  s.id === row.current_leaf_slot_id ||
                  (row.current_leaf_slot_id === null && s.id === row.active_leaf_slot_id),
                pinned: pinned.has(`${row.id}/${fork}`) || (liveLeaf !== null && forkPins.has(`${row.id}/${liveLeaf}`)),
                createdAt: fork !== item.fork ? s.created_at : item.created,
                recentAt: recent,
                cast,
                joined: [...joined] as Array<EntityId>,
                departed: [...joined].filter((id) => !state.participants.includes(id)) as Array<EntityId>,
                activity: [...activity.values()].map((a) => ({
                  ...a,
                  category: !state.participants.includes(a.entityId)
                    ? ("was" as const)
                    : present.some((id) => id !== a.entityId)
                      ? ("with" as const)
                      : ("just" as const)
                }))
              })
            }
          }
          if (forks.length === firstFork) forks.push(emptyFork())
          const visible = forks.slice(firstFork)
          if (visible.length > 0 && !visible.some((f) => f.current)) {
            const fallback =
              visible.find((f) => f.leaf === row.active_leaf_slot_id) ??
              [...visible].sort((a, b) => b.recentAt - a.recentAt)[0]!
            forks[forks.indexOf(fallback)] = { ...fallback, current: true }
          }
        }
        // Only the visible endpoints need text, and only a bounded excerpt.
        const previewByLeaf = new Map<string, string>()
        const leaves = [...new Set(forks.flatMap((f) => f.leaf ?? []))]
        for (let at = 0; at < leaves.length; at += 200) {
          const rows = yield* sql<{
            id: string
            preview: string
          }>`SELECT s.id, substr(v.content,1,160) AS preview FROM slots s JOIN versions v ON v.id = ${sql.literal(shownInSql(tipForkSql, "s"))} WHERE s.id IN ${sql.in(leaves.slice(at, at + 200))} AND s.deleted_at IS NULL`
          for (const row of rows) previewByLeaf.set(row.id, row.preview)
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
                  preview: f.leaf ? (previewByLeaf.get(f.leaf) ?? "") : "",
                  cast: f.cast.map((c) => c.entityId)
                })
            ),
          people: [...people.values()],
          pinsCollapsed: prefs?.pins_collapsed === 1
        })
      }).pipe(query("ShellLibrary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
