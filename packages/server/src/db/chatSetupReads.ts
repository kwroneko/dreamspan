// Read handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the reader workers; every one touches only the acting user's rows.
import type { Chat } from "@rp/shared/chat.ts"
import { type ChatId, ChatSummary, type EntityId } from "@rp/shared/chat.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { CardDefinition, CardForChat, CardUsage, ChatCard, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { FoldableEvent, foldState } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { castCardAt, loadCards } from "./cards.ts"
import { type CardBinding, makeLibraryQueries } from "./library.ts"
import { NotFound, type ReadOps, StorageError } from "./ops.ts"
import { chatQueue } from "./queueRows.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { query } from "./tx.ts"
import { withoutPurged } from "./stateRefs.ts"

/** A card's binding from the payload's, without the nulls; undefined for none. */
const bindingOf = (
  bindings: Readonly<Record<string, { readonly ref: string | null; readonly revision: string | null }>>,
  entityId: string
): CardBinding | undefined => {
  const binding = bindings[entityId]
  if (binding === undefined || (binding.ref === null && binding.revision === null)) return undefined
  return { ref: binding.ref ?? undefined, revision: binding.revision ?? undefined }
}

const text = (value: unknown) => (typeof value === "string" ? value : "")

/** The read-only definition the Cast tab shows; anything malformed reads as empty. */
const definitionOf = (doc: Record<string, unknown>) =>
  new CardDefinition({
    description: text(doc.description),
    personality: text(doc.personality),
    scenario: text(doc.scenario),
    firstMessage: text(doc.first_mes),
    exampleDialogue: text(doc.mes_example),
    creatorNotes: text(doc.creator_notes),
    alternateGreetings: Array.isArray(doc.alternate_greetings) ? doc.alternate_greetings.length : 0
  })

type Member = ChatGroup["members"][number]

export const makeChatSetupReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)

  /** One owner-scoped read: only cast events on each active path, then card metadata.
   * Slot deletion, selected versions and supersession follow StateEventsAt. Walking
   * slots never reads message text; folding shares GetCast's replacement/join/leave rules.
   */
  const groupsOf = (userId: UserId) =>
    Effect.gen(function* () {
      const chats = yield* sql<ChatRow & { events: string }>`
        SELECT c.*,
          (WITH RECURSIVE path(id) AS (
            SELECT id FROM slots WHERE id = c.active_leaf_slot_id AND chat_id = c.id
            UNION ALL
            SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL
          )
          SELECT json_group_array(json(event)) FROM (
            SELECT json_object('scope', e.scope, 'data', json_object('key', e.key, 'value', json(e.value_json))) AS event
            FROM state_events e
            LEFT JOIN path p ON p.id = e.slot_id
            LEFT JOIN slots s ON s.id = p.id
            WHERE e.chat_id = c.id AND e.key IN ('participant.join', 'participant.leave', 'played_by_me.set')
              AND e.superseded_by_changeset IS NULL
              AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
              AND (c.active_leaf_slot_id IS NULL OR e.version_id IS NULL OR e.version_id = s.selected_version_id)
            ORDER BY coalesce(s.depth, -1), e.seq)) AS events
        FROM chats c WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL
        ORDER BY c.last_message_at IS NOT NULL DESC, coalesce(c.last_message_at, c.created_at) DESC, c.id DESC`
      if (chats.length === 0) return []
      const cards = yield* sql<{
        entity_id: string
        label: string
        name: unknown
        avatar: unknown
      }>`
        SELECT e.id AS entity_id, r.label, json_extract(rev.doc_json, '$.name') AS name,
          json_extract(rev.doc_json, '$.avatar_media_id') AS avatar
        FROM entities e
        JOIN entity_refs r ON r.id = (
          SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id AND r2.ref_kind <> 'chat_override'
          ORDER BY r2.ref_kind = 'upstream' DESC, r2.created_at, r2.id LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL`
      const characters = new Map<string, Member>()
      for (const card of cards) {
        const name = typeof card.name === "string" ? card.name.trim() : ""
        characters.set(card.entity_id, {
          entityId: card.entity_id as EntityId,
          name: name === "" ? card.label : name,
          label: card.label,
          avatarMediaId: typeof card.avatar === "string" ? card.avatar : null
        })
      }
      const decoded = yield* Effect.forEach(chats, (row) =>
        Schema.decodeUnknownEffect(Schema.Array(FoldableEvent))(JSON.parse(row.events)).pipe(
          Effect.map((events) => events.map((event) => ({ ...event, chatId: row.id }))),
          Effect.mapError(
            (error) => new StorageError({ reason: "corrupt", operation: "ChatGroups", message: error.message })
          )
        )
      )
      // Filter purged references once for all chats, including participant scopes, just
      // as StateEventsAt does. The per-event chat id survives a PlayedByMe replacement.
      const kept = (yield* withoutPurged(sql, decoded.flat())) as Array<FoldableEvent & { chatId: string }>
      const eventsByChat = new Map<string, Array<FoldableEvent>>()
      for (const event of kept) {
        const events = eventsByChat.get(event.chatId) ?? []
        events.push(event)
        eventsByChat.set(event.chatId, events)
      }
      // Chats come latest first, so a group's first chat is its latest.
      const groups = new Map<string, { name: string; members: Array<Member>; chats: Array<Chat> }>()
      for (const row of chats) {
        const state = foldState(eventsByChat.get(row.id) ?? [])
        const played = new Set(state.playedByMe)
        const members = state.participants.flatMap((id) => (played.has(id) ? [] : (characters.get(id) ?? [])))
        if (members.length < 2) continue
        const name = chatName(importState(row.title).title, members).name
        const key = `${name}\n${members
          .map((member) => member.entityId)
          .sort()
          .join(",")}`
        const group = groups.get(key) ?? { name, members, chats: [] }
        group.chats.push(toChat(row))
        groups.set(key, group)
      }
      return [...groups.values()].map(({ name, members, chats }) => ({
        group: new ChatGroup({
          name,
          members,
          chats: chats.length,
          lastMessageAt: chats[0]!.lastMessageAt,
          latestChatId: chats[0]!.id
        }),
        chats
      }))
    })

  return {
    ChatGroups: ({ userId }) =>
      groupsOf(userId).pipe(
        Effect.map((groups) => groups.map(({ group }) => group)),
        query("ChatGroups")
      ),

    GroupChats: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const found = (yield* groupsOf(userId)).find(({ chats }) => chats.some((chat) => chat.id === chatId))
        if (found === undefined) return yield* new NotFound({ entity: "chat", id: chatId })
        return found
      }).pipe(query("GroupChats")),

    ListCards: ({ userId }) =>
      loadCards(sql, userId, null).pipe(
        Effect.map((cards) => cards.map(({ card }) => card)),
        query("ListCards")
      ),

    // One query for the whole grid (DESIGN §2.1): each live card that isn't a persona, read
    // from the ref loadCards picks, with the chats it joined on any branch (a card that left a
    // chat still took part in it), the last message among them, and the latest of them: the
    // one with the last message, a chat without messages only when none has any. Per
    // card, an index seek on the cards each chat joined (`state_events_participants`); the
    // `+` keeps the column's affinity off the indexed expression, so the seek is used.
    CardUsage: ({ userId }) =>
      sql<{
        entity_id: string
        ref_id: string
        head_revision_id: string
        label: string
        subtitle: string
        name: unknown
        avatar: unknown
        used: string
      }>`
        WITH cards AS (
          SELECT e.id AS entity_id, r.id AS ref_id, r.head_revision_id, r.label, r.subtitle
          FROM entities e
          JOIN entity_refs r ON r.id = (
            SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id AND r2.ref_kind <> 'chat_override'
            ORDER BY r2.ref_kind = 'upstream' DESC, r2.created_at, r2.id LIMIT 1)
          WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
            AND e.deleted_at IS NULL AND e.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona')
        )
        SELECT cards.*, json_extract(rev.doc_json, '$.name') AS name,
          json_extract(rev.doc_json, '$.avatar_media_id') AS avatar,
          (SELECT json_object(
              'chats', count(DISTINCT c.id),
              'last', max(c.last_message_at),
              'latest', substr(max(
                (c.last_message_at IS NOT NULL) || printf('%016d', coalesce(c.last_message_at, c.created_at)) || c.id), 18))
            FROM state_events s JOIN chats c ON c.id = s.chat_id
            WHERE json_extract(s.value_json, '$.entity') = +cards.entity_id
              AND s.key = 'participant.join' AND s.superseded_by_changeset IS NULL
              AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL) AS used
        FROM cards JOIN entity_revisions rev ON rev.id = cards.head_revision_id
        ORDER BY cards.label COLLATE NOCASE, cards.entity_id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            const used = JSON.parse(row.used) as { chats: number; last: number | null; latest: string | null }
            const name = typeof row.name === "string" ? row.name.trim() : ""
            return new CardUsage({
              entityId: row.entity_id as EntityId,
              refId: row.ref_id as RefId,
              headRevisionId: row.head_revision_id as RevisionId,
              label: row.label,
              subtitle: row.subtitle,
              name: name === "" ? row.label : name,
              avatarMediaId: typeof row.avatar === "string" ? row.avatar : null,
              chats: used.chats,
              lastMessageAt: used.last,
              latestChatId: (used.latest || null) as ChatId | null
            })
          })
        ),
        query("CardUsage")
      ),

    // One indexed read per chat: the cast is everyone a participant.join names on any branch
    // (the list doesn't walk paths), and the last message is the active leaf's.
    ChatSummaries: ({ userId, chatIds }) =>
      Effect.gen(function* () {
        const summaries: Array<ChatSummary> = []
        for (const chatId of chatIds.slice(0, 200)) {
          const [chat] = yield* sql<{ leaf: string | null }>`
            SELECT active_leaf_slot_id AS leaf FROM chats
            WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!chat) continue
          const joined = yield* sql<{ entity: string }>`
            SELECT json_extract(value_json, '$.entity') AS entity FROM state_events
            WHERE chat_id = ${chatId} AND key = 'participant.join' AND superseded_by_changeset IS NULL
            GROUP BY entity ORDER BY min(seq)`
          const ids = joined.map((row) => row.entity as EntityId)
          const cards = ids.length === 0 ? [] : yield* loadCards(sql, userId, ids)
          const byId = new Map(cards.map(({ card }) => [card.entityId as string, card]))
          const [leaf] =
            chat.leaf === null
              ? []
              : yield* sql<{ depth: number; speaker: string | null; writer: string; text: string }>`
                  SELECT s.depth, v.speaker_entity_id AS speaker, v.writer, substr(v.content, 1, 240) AS text
                  FROM slots s JOIN versions v ON v.id = s.selected_version_id
                  WHERE s.id = ${chat.leaf} AND s.chat_id = ${chatId}`
          summaries.push(
            new ChatSummary({
              chatId,
              cast: ids.flatMap((id) => byId.get(id) ?? []),
              messages: leaf ? leaf.depth + 1 : 0,
              last: leaf ? { speaker: leaf.speaker as EntityId | null, writer: leaf.writer, text: leaf.text } : null
            })
          )
        }
        return summaries
      }).pipe(query("ChatSummaries")),

    CastCards: ({ userId, entityIds, chat }) =>
      Effect.gen(function* () {
        const cards = (yield* loadCards(sql, userId, entityIds)).map(({ card }) => card)
        if (chat === undefined) return cards
        // The name the chat uses is the one the model reads: its own version's, say.
        return yield* Effect.forEach(cards, (card) =>
          Effect.flatMap(
            lib.cardInChat(userId, chat.chatId, card.entityId, bindingOf(chat.bindings, card.entityId)),
            (used) => (used === null ? Effect.succeed(card) : castCardAt(sql, card, used.revisionId))
          )
        )
      }).pipe(query("CastCards")),

    // A handful of cards per chat: a few indexed reads each, and the usage count's scan of
    // the user's chats, as the editor makes it.
    ChatCards: ({ userId, chatId, entityIds, bindings }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        const cards: Array<ChatCard> = []
        for (const entityId of [...new Set(entityIds)].slice(0, 200)) {
          // Another user's card, or one in the bin, reads as a missing one.
          const library = yield* lib.cardLibraryRef(userId, entityId)
          if (library === null) return yield* new NotFound({ entity: "card", id: entityId })
          const override = yield* lib.chatOverride(userId, chatId, entityId)
          const binding = bindingOf(bindings, entityId)
          // What the context assembler reads here; a card it can't resolve shows its library entry.
          const used = yield* lib.cardInChat(userId, chatId, entityId, binding)
          const usesOverride = override !== null && used?.refId === override.id && !binding?.revision
          cards.push(
            new ChatCard({
              entityId,
              refId: library.id as RefId,
              usedByChats: yield* lib.usedByChats(userId, library),
              overrideRefId: (override?.id ?? null) as RefId | null,
              // A binding to the library entry itself reads the library entry: not another version.
              binding: binding?.revision ? "revision" : binding?.ref && binding.ref !== library.id ? "ref" : "default",
              usesOverride,
              definition: definitionOf(yield* lib.loadDoc(used?.revisionId ?? library.head_revision_id))
            })
          )
        }
        return cards
      }).pipe(query("ChatCards")),

    GetCardForChat: ({ userId, entityId }) =>
      Effect.gen(function* () {
        const [found] = yield* loadCards(sql, userId, [entityId])
        if (found === undefined || found.card.inBin) return yield* new NotFound({ entity: "card", id: entityId })
        const { card, greetings, description, personality, scenario } = found
        return new CardForChat({ card, greetings, description, personality, scenario })
      }).pipe(query("GetCardForChat")),

    ListQueued: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        return yield* chatQueue(sql, chatId)
      }).pipe(query("ListQueued"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
