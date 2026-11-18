import { eventAppliesSql, eventOrder } from "./forkState.ts"
import { cardNames } from "@rp/shared/cardNames.ts"
// Read handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the reader workers; every one touches only the acting user's rows.
import { makeShellReadHandlers } from "./shellReads.ts"
import type { Chat } from "@rp/shared/chat.ts"
import { type CastCard, type ChatId, ChatSummary, type EntityId } from "@rp/shared/chat.ts"
import { chatName } from "@rp/shared/chatName.ts"
import { avatarCropField } from "@rp/shared/media.ts"
import { CardDefinition, CardForChat, CardUsage, ChatCard, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { FoldableEvent, foldState } from "@rp/shared/state.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  type CardSummaryRow,
  cardSummary,
  chatCast,
  chatStateAt,
  castCardAt,
  loadCards,
  loadCastCards
} from "./cards.ts"
import { type CardBinding, makeLibraryQueries } from "./library.ts"
import { NotFound, type ReadOps, StorageError } from "./ops.ts"
import { chatQueue } from "./queueRows.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { query } from "./tx.ts"
import { withoutPurged } from "./stateRefs.ts"
import { forkAt, selectedInSql, shownIn, shownInSql, slotDeletedInSql } from "./forkState.ts"
import { lastShown, lastText } from "./forks.ts"
import { previewText } from "./previewText.ts"
import { displayLength, displayThrough, pathPieces, rearranges } from "./displayPath.ts"

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

/** A chat's last message for its row: its start, with a greeting's macros replaced as the chat shows them. */
const shownLast = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  fork: string,
  leaf: string | null,
  cast: ReadonlyArray<CastCard>
) {
  const last = yield* lastText(sql, chatId, fork, leaf)
  if (last === null) return null
  const { template, ...shown } = last
  if (template !== 1) return shown as ChatSummary["last"]
  const state = yield* chatStateAt(sql, chatId, leaf)
  const names = new Map(cast.map((card) => [card.entityId as string, card.modelName ?? card.name]))
  const macro = {
    speaker: last.speaker ?? state.participants.find((id) => !state.playedByMe.includes(id)) ?? null,
    user: state.playedByMe[0] ?? null
  }
  return { ...shown, text: previewText(last.text, macro, (id) => names.get(id)) } as ChatSummary["last"]
})

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
            WHERE e.chat_id = c.id AND e.key IN ('participant.join', 'participant.leave', 'played_by_me.set', 'card.binding', 'card.swap')
              AND ${sql.literal(eventAppliesSql("c.current_fork_id", "e"))}
              AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND NOT ${sql.literal(slotDeletedInSql("c.current_fork_id", "s"))}))
              AND (c.active_leaf_slot_id IS NULL OR e.version_id IS NULL
                OR e.version_id = ${sql.literal(selectedInSql("c.current_fork_id", "s"))}
                OR e.version_id = ${sql.literal(shownInSql("c.current_fork_id", "s"))})
            ORDER BY ${sql.literal(eventOrder("e"))})) AS events
        FROM chats c WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL
        ORDER BY c.last_message_at IS NOT NULL DESC, coalesce(c.last_message_at, c.created_at) DESC, c.id DESC`
      if (chats.length === 0) return []
      const cards = yield* sql<CardSummaryRow & { entity_id: string; label: string; subtitle: string }>`
        SELECT e.id AS entity_id, r.label, r.subtitle, cs.fields AS card_fields, cs.book AS card_book, cs.book_entries AS card_book_entries
        FROM entities e
        JOIN entity_refs r ON r.id = (
          SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id
          LIMIT 1)
        LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL`
      const characters = new Map<string, Member>()
      for (const card of cards) {
        const summary = cardSummary(card)
        characters.set(card.entity_id, {
          entityId: card.entity_id as EntityId,
          name: summary.name === "" ? card.label : summary.name,
          label: card.label,
          subtitle: card.subtitle,
          avatarMediaId: summary.avatarMediaId,
          ...summary.crop
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
      const kept = (yield* withoutPurged(sql, decoded.flat(), (event) => event.chatId)) as Array<
        FoldableEvent & { chatId: string }
      >
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
        const baseMembers = state.participants.flatMap((id) => (played.has(id) ? [] : (characters.get(id) ?? [])))
        const needsResolution = baseMembers.some((member) => state.cardBindings[member.entityId] !== undefined)
        const members = needsResolution
          ? yield* Effect.forEach(baseMembers, (member) =>
              Effect.gen(function* () {
                const binding = state.cardBindings[member.entityId]
                if (binding === undefined) return member
                const used = yield* lib.cardInChat(userId, row.id, member.entityId, binding)
                if (used === null) return member
                const doc = yield* lib.loadDoc(used.revisionId)
                const names = cardNames(doc)
                return {
                  ...member,
                  name: names.displayName,
                  label: names.displayName,
                  subtitle: names.version,
                  avatarMediaId: typeof doc.avatar_media_id === "string" ? doc.avatar_media_id : null,
                  ...avatarCropField(doc.avatar_media_id, doc.avatar_crop)
                }
              })
            )
          : baseMembers
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
    ...(yield* makeShellReadHandlers),
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

    ListCards: ({ userId }) => loadCastCards(sql, userId, null).pipe(query("ListCards")),

    // One query for the whole grid (DESIGN §2.1): each live card that isn't a persona, read
    // from the ref loadCards picks, with chats containing an authored version that records it
    // in its cast or as its speaker (a card that left still took part), the last message among them, and the latest of them: the
    // one with the last message, a chat without messages only when none has any. Per
    // card, an index seek on `version_participants`; the
    // `+` keeps the column's affinity off the indexed expression, so the seek is used.
    // CROSS JOIN keeps the indexed participant seek first: reordering chats first probes
    // every live chat for every card (5 million probes in the scale fixture).
    CardUsage: ({ userId }) =>
      sql<
        CardSummaryRow & {
          entity_id: string
          ref_id: string
          head_revision_id: string
          label: string
          subtitle: string
          used: string
        }
      >`
        WITH cards AS (
          SELECT e.id AS entity_id, r.id AS ref_id, r.head_revision_id, r.label, r.subtitle
          FROM entities e
          JOIN entity_refs r ON r.id = (
            SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id
            LIMIT 1)
          WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
            AND e.deleted_at IS NULL AND e.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona')
        )
        SELECT cards.*, cs.fields AS card_fields, cs.book AS card_book, cs.book_entries AS card_book_entries,
          (SELECT json_object(
              'chats', count(DISTINCT c.id),
              'last', max(c.last_message_at),
              'latest', substr(max(
                (c.last_message_at IS NOT NULL) || printf('%016d', coalesce(c.last_message_at, c.created_at)) || c.id), 18))
            FROM card_chat_membership s CROSS JOIN chats c ON c.id = s.chat_id
            WHERE s.entity_id = +cards.entity_id
              AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL) AS used
        FROM cards LEFT JOIN card_summaries cs ON cs.revision_id = cards.head_revision_id
        ORDER BY cards.label COLLATE NOCASE, cards.entity_id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            const used = JSON.parse(row.used) as { chats: number; last: number | null; latest: string | null }
            const summary = cardSummary(row)
            return new CardUsage({
              entityId: row.entity_id as EntityId,
              refId: row.ref_id as RefId,
              headRevisionId: row.head_revision_id as RevisionId,
              label: row.label,
              subtitle: row.subtitle,
              name: summary.name === "" ? row.label : summary.name,
              modelName: summary.modelName,
              avatarMediaId: summary.avatarMediaId,
              ...summary.crop,
              chats: used.chats,
              lastMessageAt: used.last,
              latestChatId: (used.latest || null) as ChatId | null
            })
          })
        ),
        query("CardUsage")
      ),

    // The current fork's cast and card bindings, and its tip's bounded excerpt (macros replaced for a greeting).
    ChatSummaries: ({ userId, chatIds }) =>
      Effect.gen(function* () {
        const summaries: Array<ChatSummary> = []
        for (const chatId of chatIds.slice(0, 200)) {
          const [chat] = yield* sql<{ leaf: string | null; fork: string }>`
            SELECT active_leaf_slot_id AS leaf, current_fork_id AS fork FROM chats
            WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!chat) continue
          const cast = yield* chatCast(sql, userId, chatId, chat.leaf)
          const inserted = yield* rearranges(sql, chatId, chat.fork)
          const end = inserted ? yield* lastShown(sql, chatId, { id: chat.fork, tip_slot_id: chat.leaf }) : chat.leaf
          const positions = inserted ? displayLength(yield* pathPieces(sql, chatId, chat.fork, chat.leaf)) : null
          const [leaf] =
            end === null
              ? []
              : yield* sql<{ depth: number }>`SELECT depth FROM slots WHERE id = ${end} AND chat_id = ${chatId}`
          summaries.push(
            new ChatSummary({
              chatId,
              cast,
              messages: positions ?? (leaf ? leaf.depth + 1 : 0),
              last: yield* shownLast(sql, chatId, chat.fork, chat.leaf, cast)
            })
          )
        }
        return summaries
      }).pipe(query("ChatSummaries")),

    CastCards: ({ userId, entityIds, chat }) =>
      Effect.gen(function* () {
        let cards = yield* loadCastCards(sql, userId, entityIds)
        if (chat === undefined) return cards
        if (chat.history !== undefined) {
          const [owned] = yield* sql<{ id: string }>`SELECT id FROM chats WHERE id = ${chat.chatId}
            AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!owned) return []
          const fork = chat.history.forkId ?? (yield* forkAt(sql, chat.chatId, chat.history.slotId))
          const [view] = yield* sql<{ tip_slot_id: string | null }>`SELECT tip_slot_id FROM forks
            WHERE id = ${fork} AND chat_id = ${chat.chatId} AND deleted_at IS NULL`
          if (!view) return []
          const path = chat.history.through
            ? ((yield* displayThrough(sql, chat.chatId, fork, chat.history.slotId))?.pieces ?? [])
            : yield* pathPieces(sql, chat.chatId, fork, view.tip_slot_id)
          const pieces = path.map((p) => [
            p.chainId,
            p.kind !== "run" ? p.depth : p.lo,
            p.kind !== "run" ? p.depth : p.hi
          ])
          const used = yield* sql<{ entity_id: string }>`SELECT j.value AS entity_id
            FROM json_each(${JSON.stringify(entityIds)}) j WHERE EXISTS (
              SELECT 1 FROM version_participants p CROSS JOIN versions v ON v.id = p.version_id
                CROSS JOIN slots s ON s.id = v.slot_id
              WHERE p.entity_id = j.value AND s.chat_id = ${chat.chatId} AND v.purged_at IS NULL
                AND ${chat.history.through ? sql`v.id = ${shownIn(sql, fork, "s")}` : sql`1`}
                AND s.purged_at IS NULL AND EXISTS (SELECT 1 FROM json_each(${JSON.stringify(pieces)}) g
                  WHERE s.chain_id = g.value ->> 0 AND s.depth BETWEEN g.value ->> 1 AND g.value ->> 2))`
          const keep = new Set([...chat.history.active, ...used.map((row) => row.entity_id)])
          cards = cards.filter((card) => keep.has(card.entityId))
        }
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
          const binding = bindingOf(bindings, entityId)
          // What the context assembler reads here; a card it can't resolve shows its library entry.
          const used = yield* lib.cardInChat(userId, chatId, entityId, binding)
          cards.push(
            new ChatCard({
              entityId,
              refId: library.id as RefId,
              usedByChats: yield* lib.usedByChats(userId, library),
              // A binding to the library entry itself reads the library entry: not another version.
              binding: binding?.revision ? "revision" : "default",
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
        const { card, greetings, groupGreetings, description, personality, scenario, regex, refId } = found
        return new CardForChat({
          card,
          greetings,
          groupGreetings,
          description,
          personality,
          scenario,
          ...(regex ? { regex } : {}),
          ...(refId === undefined ? {} : { refId: refId as RefId }),
          ...(found.htmlScripts ? { htmlScripts: true } : {}),
          ...(found.htmlNetwork ? { htmlNetwork: true } : {})
        })
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
