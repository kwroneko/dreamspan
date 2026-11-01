// Runs only in the writer's migration transaction (owner, 2026-11-01: notes have no author's
// note). Before, a chat named one of its notes its author's note (`author_note.set`, else an
// imported note of kind `author_note`), and notes and lorebook entries placed at its top or
// bottom joined its text wherever it went. Each of those now gets the concrete place it
// resolves to today, so a chat's context keeps its messages where they were, and the marks go:
//
// - A chat's own note there: its chat's author's note's place (the chat's current fork).
// - A note bound to a revision in a chat (`note.binding`), a card's included: that chat's.
// - A card's note (a persona's description, a character's own author's note): the place most
//   of the chats with the card in their cast have, else most of the user's chats, else ST's
//   default author's note place (in the chat at depth 4 as the system).
// - Lorebook entries before or after the author's note, a card's own book's included: at the
//   depth and role most of the user's chats (a card's: its chats) have, as above.
//
// A chat without an author's note had ST's default one. A new revision becomes each head
// (every earlier revision keeps its document; old ones are read as `LEGACY_PLACEMENT`), and a
// converted binding is bound again where it was. `author_note.set` events are deleted.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { concretePlacement, LEGACY_PLACEMENT, type Placement } from "@rp/shared/docs/note.ts"
import { LEGACY_LORE_DEPTH } from "@rp/shared/docs/lorebook.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { Doc } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { docHash, searchText } from "./documents.ts"
import { nextSeq } from "./forkState.ts"
import { stateEventsThrough } from "./stateRead.ts"

interface Head {
  readonly id: string
  readonly entity_id: string
  readonly head_revision_id: string
  readonly schema_version: number
  readonly doc_json: string
}

type Lore = { readonly depth: number; readonly role: string }

const isRelative = (placement: unknown) =>
  typeof placement === "object" &&
  placement !== null &&
  (placement as { section?: unknown }).section !== undefined &&
  ["author_note_top", "author_note_bottom"].includes((placement as { section: string }).section)

const relativeEntry = (entry: unknown) =>
  typeof entry === "object" &&
  entry !== null &&
  ["an_top", "an_bottom"].includes((entry as { position?: string }).position ?? "")

/** Where a note at the author's note's top or bottom went: the note's place, or nowhere. */
const notePlace = (author: Placement): Placement => {
  const placement = concretePlacement(author)
  if (placement.mode === "section" && placement.section === "card") return { mode: "none" }
  return placement
}

/** Where a lorebook entry there went: the note's depth and role; beside the main prompt, ST's default place. */
const lorePlace = (author: Placement): Lore => {
  const placement = concretePlacement(author)
  return placement.mode === "depth"
    ? { depth: placement.depth, role: placement.role }
    : placement.mode === "tail"
      ? { depth: 0, role: placement.role }
      : LEGACY_LORE_DEPTH
}

/** The most common of `values` by their JSON, the first seen on a tie; null for none. */
const mostCommon = <A>(values: ReadonlyArray<A>): A | null => {
  const counts = new Map<string, { value: A; n: number }>()
  for (const value of values) {
    const key = JSON.stringify(value)
    const seen = counts.get(key)
    counts.set(key, { value, n: (seen?.n ?? 0) + 1 })
  }
  let best: { value: A; n: number } | null = null
  for (const entry of counts.values()) if (best === null || entry.n > best.n) best = entry
  return best?.value ?? null
}

export const authorNoteMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const at = Date.now()

  /** A revision on `parent` with `doc`; its id. */
  const insertRevision = (entityId: string, parent: string, schemaVersion: number, doc: Doc, message: string) =>
    Effect.gen(function* () {
      const id = uuidv7()
      yield* sql`INSERT INTO entity_revisions ${sql.insert({
        id,
        entity_id: entityId,
        parents: JSON.stringify([parent]),
        doc_json: JSON.stringify(doc),
        doc_hash: docHash(doc),
        search_text: searchText(doc),
        schema_version: schemaVersion,
        origin: "user",
        message,
        created_at: at
      })}`
      return id
    })

  const revise = (ref: Head, doc: Doc, message: string) =>
    Effect.gen(function* () {
      const id = yield* insertRevision(ref.entity_id, ref.head_revision_id, ref.schema_version, doc, message)
      yield* sql`UPDATE entity_refs SET head_revision_id = ${id}, row_version = row_version + 1, updated_at = ${at}
        WHERE id = ${ref.id}`
    })

  const placedNote = (doc: Doc, place: Placement) => ({ ...doc, placement: place })
  const placedBook = (book: Record<string, unknown>, place: Lore) => ({
    ...book,
    entries: (book.entries as Array<Record<string, unknown>>).map((entry) =>
      relativeEntry(entry) ? { ...entry, position: "at_depth", depth: place.depth, role: place.role } : entry
    )
  })
  const noteMessage = (place: Placement) =>
    place.mode === "depth"
      ? `Placed at depth ${place.depth} as ${place.role}, where the chat's author's note was`
      : place.mode === "tail"
        ? `Placed at the tail as ${place.role}, where the chat's author's note was`
        : place.mode === "section"
          ? "Placed where the chat's author's note was"
          : "Not placed: the chat's author's note wasn't"
  const loreMessage = (place: Lore) =>
    `Entries before or after the author's note placed at depth ${place.depth} as ${place.role}, where it was`

  // Each chat's author's note's place, on its current fork, as the assembler resolved it.
  const chats = yield* sql<{ id: string; owner_user_id: string; fork: string | null; tip: string | null }>`
    SELECT c.id, c.owner_user_id, f.id AS fork, f.tip_slot_id AS tip
    FROM chats c LEFT JOIN forks f ON f.id = c.current_fork_id ORDER BY c.id`
  const authorPlace = new Map<string, Placement>()
  for (const chat of chats) {
    const rows = yield* stateEventsThrough(sql, chat.id as ChatId, chat.tip as SlotId | null, chat.fork)
    let chosen: string | false | null = null
    const bindings = new Map<string, string>()
    for (const row of rows) {
      const value = JSON.parse(row.value_json) as { note?: string | null; revision?: string }
      if (row.key === "author_note.set") chosen = value.note ?? false
      if (row.key === "note.binding" && value.note && value.revision) bindings.set(value.note, value.revision)
    }
    const [note] =
      chosen === false
        ? []
        : yield* sql<{ id: string; head: string }>`
          SELECT e.id, r.head_revision_id AS head FROM entities e
          JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
          JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE e.kind = 'note' AND e.deleted_at IS NULL AND json_extract(h.doc_json, '$.owner.chat') = ${chat.id}
            AND (${chosen} IS NULL AND json_extract(h.doc_json, '$.kind') = 'author_note' OR e.id = ${chosen})
          ORDER BY e.id LIMIT 1`
    const revision = note ? (bindings.get(note.id) ?? note.head) : null
    const [doc] =
      revision === null
        ? []
        : yield* sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${revision}`
    // No author's note: ST's default one, in the chat at depth 4 as the system.
    authorPlace.set(chat.id, doc ? (JSON.parse(doc.doc_json) as { placement: Placement }).placement : LEGACY_PLACEMENT)
  }
  const userPlace = new Map<string, Placement | null>()
  for (const user of new Set(chats.map((c) => c.owner_user_id)))
    userPlace.set(user, mostCommon(chats.filter((c) => c.owner_user_id === user).map((c) => authorPlace.get(c.id)!)))
  /**
   * The chats with a card in their cast, the ones the user plays it in included, but those
   * that switched `note` off (a group chat has a character's own author's note off, say).
   */
  const cardChats = (card: string, note: string | null) =>
    sql<{ chat_id: string }>`SELECT DISTINCT chat_id FROM state_events ev
      WHERE ((key = 'participant.join' AND json_extract(value_json, '$.entity') = ${card})
        OR (key = 'played_by_me.set' AND EXISTS (SELECT 1 FROM json_each(value_json, '$.entities') WHERE value = ${card})))
        AND NOT EXISTS (SELECT 1 FROM state_events off WHERE off.chat_id = ev.chat_id AND off.key = 'note.deactivate'
          AND json_extract(off.value_json, '$.note') = ${note})
      ORDER BY chat_id`.pipe(Effect.map((rows) => rows.map((row) => row.chat_id)))
  const cardPlace = (card: string, user: string, note: string | null) =>
    Effect.map(
      cardChats(card, note),
      (ids) => mostCommon(ids.flatMap((id) => authorPlace.get(id) ?? [])) ?? userPlace.get(user) ?? LEGACY_PLACEMENT
    )

  // Notes: every live ref whose head is placed at the author's note.
  const notes = yield* sql<Head & { owner_user_id: string; chat: string | null; card: string | null }>`
    SELECT r.id, r.entity_id, r.head_revision_id, h.schema_version, h.doc_json, e.owner_user_id,
      json_extract(h.doc_json, '$.owner.chat') AS chat, json_extract(h.doc_json, '$.owner.card') AS card
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.kind = 'note' AND e.purged_at IS NULL
      AND json_extract(h.doc_json, '$.placement.section') IN ('author_note_top', 'author_note_bottom')
    ORDER BY r.id`
  for (const note of notes) {
    const author =
      note.chat !== null
        ? (authorPlace.get(note.chat) ?? LEGACY_PLACEMENT)
        : note.card !== null
          ? yield* cardPlace(note.card, note.owner_user_id, note.entity_id)
          : (userPlace.get(note.owner_user_id) ?? LEGACY_PLACEMENT)
    const place = notePlace(author)
    yield* revise(note, placedNote(JSON.parse(note.doc_json) as Doc, place), noteMessage(place))
  }

  // Bindings to such a revision: the latest one of its note at its message in its fork is bound
  // again, right after it, to a revision placed by that chat's author's note.
  const bound = yield* sql<{
    id: string
    chat_id: string
    slot_id: string | null
    version_id: string | null
    seq: number
    scope: string | null
    fork_id: string | null
    origin: string
    note: string
    revision: string
    schema_version: number
    doc_json: string
  }>`
    SELECT ev.id, ev.chat_id, ev.slot_id, ev.version_id, ev.seq, ev.scope, ev.fork_id, ev.origin,
      json_extract(ev.value_json, '$.note') AS note, h.id AS revision, h.schema_version, h.doc_json
    FROM state_events ev JOIN entity_revisions h ON h.id = json_extract(ev.value_json, '$.revision')
    WHERE ev.key = 'note.binding'
      AND json_extract(h.doc_json, '$.placement.section') IN ('author_note_top', 'author_note_bottom')
      AND NOT EXISTS (SELECT 1 FROM state_events later WHERE later.key = 'note.binding'
        AND later.chat_id = ev.chat_id AND later.slot_id IS ev.slot_id AND later.fork_id IS ev.fork_id
        AND later.version_id IS ev.version_id AND later.seq > ev.seq
        AND json_extract(later.value_json, '$.note') = json_extract(ev.value_json, '$.note'))
    ORDER BY ev.chat_id, ev.seq`
  for (const event of bound) {
    const place = notePlace(authorPlace.get(event.chat_id) ?? LEGACY_PLACEMENT)
    const revision = yield* insertRevision(
      event.note,
      event.revision,
      event.schema_version,
      placedNote(JSON.parse(event.doc_json) as Doc, place),
      noteMessage(place)
    )
    const [next] = yield* sql<{ n: number }>`
      SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE chat_id = ${event.chat_id} AND slot_id IS ${event.slot_id}`
    yield* sql`INSERT INTO state_events ${sql.insert({
      id: uuidv7(),
      chat_id: event.chat_id,
      slot_id: event.slot_id,
      version_id: event.version_id,
      seq: next!.n,
      key: "note.binding",
      scope: event.scope,
      value_json: JSON.stringify({ note: event.note, revision }),
      fork_id: event.fork_id,
      fork_seq: event.fork_id === null ? null : yield* nextSeq(sql, event.chat_id),
      origin: event.origin,
      origin_ref: null,
      created_at: at
    })}`
  }

  // Lorebook entries, in books and in cards' own books.
  const books = yield* sql<Head & { owner_user_id: string; kind: string }>`
    SELECT r.id, r.entity_id, r.head_revision_id, h.schema_version, h.doc_json, e.owner_user_id, e.kind
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.kind IN ('lorebook', 'card') AND e.purged_at IS NULL
      AND EXISTS (SELECT 1 FROM json_each(h.doc_json, CASE e.kind WHEN 'card' THEN '$.character_book.entries' ELSE '$.entries' END)
        WHERE json_extract(value, '$.position') IN ('an_top', 'an_bottom'))
    ORDER BY r.id`
  for (const book of books) {
    const doc = JSON.parse(book.doc_json) as Doc
    const author =
      book.kind === "card"
        ? yield* cardPlace(book.entity_id, book.owner_user_id, null)
        : (userPlace.get(book.owner_user_id) ?? LEGACY_PLACEMENT)
    const place = lorePlace(author)
    const next =
      book.kind === "card"
        ? { ...doc, character_book: placedBook(doc.character_book as Record<string, unknown>, place) }
        : placedBook(doc, place)
    yield* revise(book, next, loreMessage(place))
  }

  // No note is the author's note any more.
  yield* sql`DELETE FROM state_events WHERE key = 'author_note.set'`
})
