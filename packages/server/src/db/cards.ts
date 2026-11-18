import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { displayEndOf } from "./displayPath.ts"
import { forkAt } from "./forkState.ts"
import { type FoldableEvent, foldState } from "@rp/shared/state.ts"
import { withoutPurged } from "./stateRefs.ts"
import { cardNames, modelName } from "@rp/shared/cardNames.ts"
import { avatarCropField } from "@rp/shared/media.ts"
import { talkativenessOf } from "@rp/shared/naturalOrder.ts"
// Cards as chats see them: display name, model name, version and greetings from the
// selected card revision, and whether it is a persona. Shared by
// the readers and the writer (chatSetupReads.ts, chatSetupWrites.ts).
import { CastCard, type ChatId, type EntityId, type SlotId } from "@rp/shared/chat.ts"
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
  readonly ref_id?: string
}

/** The fields a chat reads from a card document; anything malformed reads as empty. */
export interface CardText {
  readonly card: CastCard
  /** `first_mes` then the alternate greetings, empty ones left out. */
  readonly greetings: ReadonlyArray<string>
  readonly groupGreetings: ReadonlyArray<string>
  /** Where each nonempty ordinary + group greeting is in the card (0: `first_mes`), for a version's `greeting_ref`. */
  readonly greetingIndexes: ReadonlyArray<number>
  readonly description: string
  readonly personality: string
  readonly scenario: string
  /** Its regex scripts, when the user allowed them. */
  readonly regex?: ReadonlyArray<RegexScript>
  /** The ref it was read from, for its approvals; absent for a document outside the library. */
  readonly refId?: string
  /** Its panels' permissions (spec/HTML-MESSAGES.md §3.4): scripts, and the internet with them. */
  readonly htmlScripts: boolean
  readonly htmlNetwork: boolean
}

const text = (value: unknown) => (typeof value === "string" ? value : "")

/** The card's `extensions.talkativeness`, defaulted and clamped (ST's natural order). */
const talkativenessFrom = (doc: Record<string, unknown>) =>
  talkativenessOf(
    typeof doc.extensions === "object" && doc.extensions !== null
      ? (doc.extensions as Record<string, unknown>).talkativeness
      : undefined
  )

const parse = (row: CardRow): CardText => {
  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.doc_json)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>
  } catch {
    // A document is valid JSON by the schema's CHECK; anything else reads as empty.
  }
  const alternates = Array.isArray(doc.alternate_greetings) ? doc.alternate_greetings.map(text) : []
  const groups = Array.isArray(doc.group_only_greetings) ? doc.group_only_greetings.map(text) : []
  const ordinary = [text(doc.first_mes), ...alternates]
  const all = [...ordinary, ...groups]
  const greetingIndexes = all.flatMap((greeting, index) => (greeting.trim() === "" ? [] : [index]))
  const names = cardNames(doc)
  const book =
    typeof doc.character_book === "object" && doc.character_book !== null
      ? (doc.character_book as Record<string, unknown>)
      : null
  const bookName = text(book?.name).trim()
  const world = text((doc.extensions as { world?: unknown } | null | undefined)?.world)
  return {
    card: new CastCard({
      entityId: row.entity_id as EntityId,
      name: names.displayName,
      label: names.displayName,
      modelName: names.modelName,
      subtitle: names.version,
      persona: row.persona === 1,
      inBin: row.in_bin === 1,
      talkativeness: talkativenessFrom(doc),
      lorebook: book !== null,
      ...(bookName === "" ? {} : { lorebookName: bookName }),
      ...(book === null ? {} : { lorebookEntries: Array.isArray(book.entries) ? book.entries.length : 0 }),
      ...(world === "" ? {} : { lorebookWorld: world }),
      avatarMediaId: typeof doc.avatar_media_id === "string" ? doc.avatar_media_id : null,
      ...avatarCropField(doc.avatar_media_id, doc.avatar_crop)
    }),
    greetings: greetingIndexes.filter((index) => index < ordinary.length).map((index) => all[index]!),
    groupGreetings: greetingIndexes.filter((index) => index >= ordinary.length).map((index) => all[index]!),
    greetingIndexes,
    description: text(doc.description),
    personality: text(doc.personality),
    scenario: text(doc.scenario),
    // Only scripts the user allowed are offered to run (the schema checked their shape).
    ...(doc.regex_approved === true && Array.isArray(doc.regex) && doc.regex.length > 0
      ? { regex: doc.regex as ReadonlyArray<RegexScript> }
      : {}),
    ...(row.ref_id === undefined ? {} : { refId: row.ref_id }),
    htmlScripts: doc.html_scripts_approved === true,
    htmlNetwork: doc.html_scripts_approved === true && doc.html_network_approved === true
  }
}

/**
 * A document not in the library, as a chat would read it: a card on a card source before
 * it's added (spec/CARD-SOURCES.md §4.2), under its placeholder id. Its regex scripts are
 * never offered (§4.6), nor are its panels' scripts: only a user can allow them, once the card is theirs.
 */
export const cardTextOfDoc = (entityId: EntityId, docJson: string): CardText => {
  const { regex: _, ...text } = parse({ entity_id: entityId, label: "", doc_json: docJson, persona: 0, in_bin: 0 })
  return { ...text, htmlScripts: false, htmlNetwork: false }
}

/** A card revision's summary (baseline `card_summaries`), as a query selects it: null without one. */
export interface CardSummaryRow {
  readonly card_fields: string | null
  readonly card_book: number | null
  readonly card_book_entries: number | null
}

/**
 * What the card lists read of a revision, from its summary columns rather than its document
 * (decisions1: the document can be megabytes with a lorebook, and every list read parsed it).
 * Anything malformed reads as empty, as `parse` has it.
 */
export const cardSummary = (row: CardSummaryRow) => {
  let fields: Array<unknown> = []
  try {
    const parsed: unknown = row.card_fields === null ? [] : JSON.parse(row.card_fields)
    if (Array.isArray(parsed)) fields = parsed
  } catch {
    // The column is SQLite's own JSON; anything else reads as empty.
  }
  const [name, nickname, version, avatar, bookName, crop, talkativeness] = fields
  const book = row.card_book === 1
  return {
    name: text(name),
    nickname: text(nickname),
    modelName: modelName({ name: text(name), nickname: text(nickname) }),
    version: text(version),
    avatarMediaId: typeof avatar === "string" ? avatar : null,
    crop: avatarCropField(avatar, crop),
    talkativeness: talkativenessOf(talkativeness),
    book,
    bookName: text(bookName).trim(),
    bookEntries: row.card_book_entries ?? 0
  }
}

/** The summary's lorebook fields of a `CastCard`. */
export const cardSummaryBook = (summary: ReturnType<typeof cardSummary>) => ({
  lorebook: summary.book,
  ...(summary.book && summary.bookName !== "" ? { lorebookName: summary.bookName } : {}),
  ...(summary.book ? { lorebookEntries: summary.bookEntries } : {})
})

/**
 * The user's cards as lists show them (`CastCard` alone): `ids`, binned ones included, or every
 * live one, as `loadCards` picks them, read from the summary columns only.
 */
export const loadCastCards = (sql: SqlClient.SqlClient, userId: UserId, ids: ReadonlyArray<EntityId> | null) =>
  ids !== null && ids.length === 0
    ? Effect.succeed([] as Array<CastCard>)
    : sql<CardSummaryRow & { entity_id: string; persona: number; in_bin: number }>`
        SELECT e.id AS entity_id, cs.fields AS card_fields, cs.book AS card_book, cs.book_entries AS card_book_entries,
          e.deleted_at IS NOT NULL AS in_bin,
          EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e
        JOIN entity_refs r ON r.id = (
          SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id
          LIMIT 1)
        LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
          AND ${ids === null ? sql`e.deleted_at IS NULL AND e.archived_at IS NULL` : sql.in("e.id", ids)}
        ORDER BY r.label COLLATE NOCASE, e.id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            const summary = cardSummary(row)
            return new CastCard({
              entityId: row.entity_id as EntityId,
              name: summary.name,
              label: summary.name,
              modelName: summary.modelName,
              subtitle: summary.version,
              persona: row.persona === 1,
              inBin: row.in_bin === 1,
              talkativeness: summary.talkativeness,
              ...cardSummaryBook(summary),
              avatarMediaId: summary.avatarMediaId,
              ...summary.crop
            })
          })
        )
      )

/**
 * The user's cards: `ids` (binned ones included, so a chat can still name them), or every
 * live one. Each is read from its single upstream ref; the
 * chat's own `card.binding` isn't applied yet (the context assembler resolves that).
 * Purged cards and other users' are left out.
 */
export const loadCards = (sql: SqlClient.SqlClient, userId: UserId, ids: ReadonlyArray<EntityId> | null) =>
  ids !== null && ids.length === 0
    ? Effect.succeed([] as Array<CardText>)
    : sql<CardRow>`
        SELECT e.id AS entity_id, r.id AS ref_id, r.label, rev.doc_json, e.deleted_at IS NOT NULL AS in_bin,
          EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona') AS persona
        FROM entities e
        JOIN entity_refs r ON r.id = (
          SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id
          LIMIT 1)
        JOIN entity_revisions rev ON rev.id = r.head_revision_id
        WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
          AND ${ids === null ? sql`e.deleted_at IS NULL AND e.archived_at IS NULL` : sql.in("e.id", ids)}
        ORDER BY r.label COLLATE NOCASE, e.id`.pipe(Effect.map((rows) => rows.map(parse)))

/**
 * `card` as a chat uses it: the name, avatar and lorebook flag of `revisionId` (the version
 * the chat reads, `cardInChat` in library.ts). Its persona mark stays the library's.
 */
export const castCardAt = (sql: SqlClient.SqlClient, card: CastCard, revisionId: string) =>
  sql<CardSummaryRow & { card_world: unknown }>`SELECT cs.fields AS card_fields, cs.book AS card_book,
      cs.book_entries AS card_book_entries, json_extract(r.doc_json, '$.extensions.world') AS card_world
    FROM card_summaries cs JOIN entity_revisions r ON r.id = cs.revision_id
    WHERE cs.revision_id = ${revisionId}`.pipe(
    Effect.map(([row]) => {
      if (!row) return card
      const summary = cardSummary(row)
      const next = {
        ...card,
        name: summary.name,
        label: summary.name,
        modelName: summary.modelName,
        subtitle: summary.version,
        avatarMediaId: summary.avatarMediaId,
        ...summary.crop,
        talkativeness: summary.talkativeness,
        ...cardSummaryBook(summary)
      }
      // All lorebook metadata follows the revision the chat reads, including absent fields.
      if (!summary.book || summary.bookName === "") delete next.lorebookName
      if (!summary.book) delete next.lorebookEntries
      if (typeof row.card_world === "string" && row.card_world !== "") next.lorebookWorld = row.card_world
      else delete next.lorebookWorld
      return new CastCard(next)
    })
  )

/** A chat's state folded at `leaf`, as its cast is read there. */
export const chatStateAt = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  chatId: ChatId,
  leaf: string | null,
  forkId?: string
) {
  const fork = forkId ?? (yield* forkAt(sql, chatId, leaf))
  // At the fork's tip, its cast as it stands: through its display end, which an inserted
  // message after the tip is (spec/MESSAGE-INSERT.md §2.3).
  const [tip] =
    fork === null
      ? []
      : yield* sql<{ id: string; tip_slot_id: string | null }>`
    SELECT id, tip_slot_id FROM forks WHERE id = ${fork} AND chat_id = ${chatId}`
  const at = tip !== undefined && tip.tip_slot_id === leaf ? yield* displayEndOf(sql, chatId, tip) : leaf
  const events = yield* stateEventsThrough(sql, chatId, at as SlotId | null, fork)
  return foldState(
    yield* withoutPurged(
      sql,
      events.map((e) => ({
        scope: e.scope,
        data: { key: e.key, value: JSON.parse(e.value_json) }
      })) as Array<FoldableEvent>
    )
  )
})

/** The names list previews give `{{user}}` and `{{char}}` (`previewText`): each card's model name, else its name. */
export const previewNamesOf = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  macros: ReadonlyArray<{ readonly speaker: string | null; readonly user: string | null } | null>
) {
  const ids = [...new Set(macros.flatMap((m) => (m === null ? [] : [m.speaker, m.user])))].filter(
    (id): id is string => id !== null
  )
  const cards = ids.length === 0 ? [] : yield* loadCastCards(sql, userId as UserId, ids as Array<EntityId>)
  const byId = new Map(cards.map((card) => [card.entityId as string, card.modelName ?? card.name]))
  return (id: string) => byId.get(id)
})

/** The same selected revisions for chat-list metadata and chat search. */
export const chatCast = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: ChatId,
  leaf: string | null
) {
  const state = yield* chatStateAt(sql, chatId, leaf)
  const ids = state.participants as ReadonlyArray<EntityId>
  const cards = yield* loadCards(sql, userId, ids)
  const bindings = state.cardBindings
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
