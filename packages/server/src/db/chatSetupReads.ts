// Read handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the reader workers; every one touches only the acting user's rows.
import { ChatSummary, type EntityId } from "@rp/shared/chat.ts"
import { CardDefinition, CardForChat, ChatCard } from "@rp/shared/chatSetupApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { castCardAt, loadCards } from "./cards.ts"
import { type CardBinding, makeLibraryQueries } from "./library.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { chatQueue } from "./queueRows.ts"
import { query } from "./tx.ts"

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

export const makeChatSetupReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lib = makeLibraryQueries(sql)
  return {
    ListCards: ({ userId }) =>
      loadCards(sql, userId, null).pipe(
        Effect.map((cards) => cards.map(({ card }) => card)),
        query("ListCards")
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
              binding: binding?.revision ? "revision" : binding?.ref ? "ref" : "default",
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
