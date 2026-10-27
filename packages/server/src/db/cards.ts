import { type FoldableEvent, foldState } from "@rp/shared/state.ts"
import { withoutPurged } from "./stateRefs.ts"
import { cardNames } from "@rp/shared/cardNames.ts"
// Cards as chats see them: display name, model name, version and greetings from the
// selected card revision, and whether it is a persona. Shared by
// the readers and the writer (chatSetupReads.ts, chatSetupWrites.ts).
import { CastCard, type ChatId, type EntityId } from "@rp/shared/chat.ts"
import { makeLibraryQueries } from "./library.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

interface CardRow {
  readonly entity_id: string
  readonly label: string
  readonly doc_json: string
  readonly persona: number
  readonly in_bin: number
}

/** The fields a chat reads from a card document; anything malformed reads as empty. */
export interface CardText {
  readonly card: CastCard
  /** `first_mes` then the alternate greetings, empty ones left out. */
  readonly greetings: ReadonlyArray<string>
  /** Where each of `greetings` is in the card (0: `first_mes`), for a version's `greeting_ref`. */
  readonly greetingIndexes: ReadonlyArray<number>
  readonly description: string
  readonly personality: string
  readonly scenario: string
}

const text = (value: unknown) => (typeof value === "string" ? value : "")

const parse = (row: CardRow): CardText => {
  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.doc_json)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>
  } catch {
    // A document is valid JSON by the schema's CHECK; anything else reads as empty.
  }
  const alternates = Array.isArray(doc.alternate_greetings) ? doc.alternate_greetings.map(text) : []
  const all = [text(doc.first_mes), ...alternates]
  const greetingIndexes = all.flatMap((greeting, index) => (greeting.trim() === "" ? [] : [index]))
  const names = cardNames(doc)
  const book =
    typeof doc.character_book === "object" && doc.character_book !== null
      ? (doc.character_book as Record<string, unknown>)
      : null
  const bookName = text(book?.name).trim()
  return {
    card: new CastCard({
      entityId: row.entity_id as EntityId,
      name: names.displayName,
      label: names.displayName,
      modelName: names.modelName,
      subtitle: names.version,
      persona: row.persona === 1,
      inBin: row.in_bin === 1,
      lorebook: book !== null,
      ...(bookName === "" ? {} : { lorebookName: bookName }),
      ...(book === null ? {} : { lorebookEntries: Array.isArray(book.entries) ? book.entries.length : 0 }),
      avatarMediaId: typeof doc.avatar_media_id === "string" ? doc.avatar_media_id : null
    }),
    greetings: greetingIndexes.map((index) => all[index]!),
    greetingIndexes,
    description: text(doc.description),
    personality: text(doc.personality),
    scenario: text(doc.scenario)
  }
}

/**
 * The user's cards: `ids` (binned ones included, so a chat can still name them), or every
 * live one. Each is read from its upstream ref, or its oldest variant without one; the
 * chat's own `card.binding` isn't applied yet (the context assembler resolves that).
 * Purged cards and other users' are left out.
 */
export const loadCards = (sql: SqlClient.SqlClient, userId: UserId, ids: ReadonlyArray<EntityId> | null) =>
  ids !== null && ids.length === 0
    ? Effect.succeed([] as Array<CardText>)
    : sql<CardRow>`
        SELECT e.id AS entity_id, r.label, rev.doc_json, e.deleted_at IS NOT NULL AS in_bin,
          EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e
        JOIN entity_refs r ON r.id = (
          SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id AND r2.ref_kind <> 'chat_override'
          ORDER BY r2.ref_kind = 'upstream' DESC, r2.created_at, r2.id LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
          AND ${ids === null ? sql`e.deleted_at IS NULL AND e.archived_at IS NULL` : sql.in("e.id", ids)}
        ORDER BY r.label COLLATE NOCASE, e.id`.pipe(Effect.map((rows) => rows.map(parse)))

/**
 * `card` as a chat uses it: the name, avatar and lorebook flag of `revisionId` (the version
 * the chat reads, `cardInChat` in library.ts). Its persona mark stays the library's.
 */
export const castCardAt = (sql: SqlClient.SqlClient, card: CastCard, revisionId: string) =>
  sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${revisionId}`.pipe(
    Effect.map(([row]) => {
      if (!row) return card
      const doc = JSON.parse(row.doc_json) as Record<string, unknown>
      const names = cardNames(doc)
      return new CastCard({
        ...card,
        name: names.displayName,
        label: names.displayName,
        modelName: names.modelName,
        subtitle: names.version,
        avatarMediaId: typeof doc.avatar_media_id === "string" ? doc.avatar_media_id : null,
        lorebook: typeof doc.character_book === "object" && doc.character_book !== null
      })
    })
  )

/** Card bindings on the active path, for names in chat lists and search results. */
const cardBindingsAt = (sql: SqlClient.SqlClient, chatId: string, leaf: string | null) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ scope: string | null; value_json: string }>`
      WITH RECURSIVE path(id) AS (
        SELECT ${leaf} WHERE ${leaf} IS NOT NULL
        UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
      )
      SELECT e.scope, e.value_json FROM state_events e
      LEFT JOIN path p ON p.id = e.slot_id LEFT JOIN slots s ON s.id = p.id
      WHERE e.chat_id = ${chatId} AND e.key = 'card.binding' AND e.superseded_by_changeset IS NULL
        AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
        AND (${leaf} IS NULL OR e.version_id IS NULL OR e.version_id = s.selected_version_id)
      ORDER BY coalesce(s.depth, -1), e.seq`
    const kept = yield* withoutPurged(
      sql,
      rows.map((row) => ({
        scope: row.scope,
        data: { key: "card.binding", value: JSON.parse(row.value_json) }
      })) as ReadonlyArray<FoldableEvent>
    )
    return foldState(kept).cardBindings
  })

/** The same selected revisions for chat-list metadata and chat search. */
export const chatCast = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId,
  leaf: string | null
) {
  const joined = yield* sql<{ entity: string }>`
    SELECT json_extract(value_json, '$.entity') AS entity FROM state_events
    WHERE chat_id = ${chatId} AND key = 'participant.join' AND superseded_by_changeset IS NULL
    GROUP BY entity ORDER BY min(seq)`
  const ids = joined.map((row) => row.entity as EntityId)
  const cards = ids.length === 0 ? [] : yield* loadCards(sql, userId, ids)
  const bindings = yield* cardBindingsAt(sql, chatId, leaf)
  const lib = makeLibraryQueries(sql)
  const resolved = yield* Effect.forEach(cards, ({ card }) =>
    Effect.gen(function* () {
      const used = yield* lib.cardInChat(userId, chatId, card.entityId, bindings[card.entityId])
      return used === null ? card : yield* castCardAt(sql, card, used.revisionId)
    })
  )
  const byId = new Map(resolved.map((card) => [card.entityId, card]))
  return ids.flatMap((id) => byId.get(id) ?? [])
})
