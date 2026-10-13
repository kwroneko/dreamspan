// Cards as chats see them (DESIGN §2.1, §2.2): the in-chat name and greetings from the
// document a card is shown from, its library label, and whether it's a persona. Shared by
// the readers and the writer (chatSetupReads.ts, chatSetupWrites.ts).
import { CastCard, type EntityId } from "@rp/shared/chat.ts"
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
  const name = text(doc.name).trim()
  return {
    card: new CastCard({
      entityId: row.entity_id as EntityId,
      name: name === "" ? row.label : name,
      label: row.label,
      persona: row.persona === 1,
      inBin: row.in_bin === 1,
      lorebook: typeof doc.character_book === "object" && doc.character_book !== null,
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
