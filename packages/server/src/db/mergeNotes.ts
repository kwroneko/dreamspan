// The notes a merge of another chat can bring (spec/CHAT-MERGE.md §6; merge2, item 011a): the
// source chat's own notes on at its merged end, and its characters' card notes on there but off
// here. Nothing comes unless ticked. A ticked chat note is copied into this chat as a new note
// (its text as the source shows it, a shared note's text included), on from the join; a ticked
// card note is switched on from the join, its moved-passage partner with it (graphWrites.ts).
// The preview and the write read the same list (`mergeNotes`), inside the writer's transaction
// for the write.
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { readReplaceTarget, targetCard } from "@dreamspan/shared/docs/note.ts"
import { NOTE_SCHEMA_VERSION } from "@dreamspan/shared/docs/note.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { validateDoc } from "@dreamspan/shared/editing.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { Doc, RevisionId } from "@dreamspan/shared/library.ts"
import type { MergeNote } from "@dreamspan/shared/mergeApi.ts"
import { type FoldableEvent, foldState, noteSwitches } from "@dreamspan/shared/state.ts"
import { Effect, Predicate } from "effect"
import type { SqlClient } from "effect/sql"
import { agentWrittenNotes, notesCreated } from "./agentNotes.ts"
import { docHash, searchText } from "./documents.ts"
import { replacementConflict } from "./noteReplacementWrites.ts"
import { sharedNote } from "./sharedNotes.ts"
import { stateEventRowsThrough } from "./stateRead.ts"

/** One entry of the list, with what the write does for it. */
export interface NoteToBring {
  readonly entry: MergeNote
  /** A chat note's copy as it would be stored here; null for a card's note (switched on only). */
  readonly copy: Doc | null
  /** The source revisions of card notes, frozen with the preview and bound at the join. */
  readonly bindings: ReadonlyArray<{
    readonly note: EntityId
    readonly revision: RevisionId
    readonly doc: Doc
    readonly content: string
  }>
}

const EXCERPT = 160

const ownerOf = (doc: Doc) => (Predicate.isObject(doc.owner) ? (doc.owner as { card?: unknown; chat?: unknown }) : {})
const conditionOf = (doc: Doc) =>
  Predicate.isObject(doc.condition) ? (doc.condition as { when?: unknown; cards?: unknown; card?: unknown }) : {}
const excerptOf = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1).trimEnd()}…` : flat
}
const toEvents = (rows: ReadonlyArray<{ scope: string | null; key: string; value_json: string }>) =>
  rows.map((row) => ({ scope: row.scope, data: { key: row.key, value: JSON.parse(row.value_json) } }) as FoldableEvent)

/**
 * The notes merging `source` (through its merged end) below `at` on `dest` can bring, chat notes
 * first, then each card's, in title order. `sourceCast`: the source's cast at its merged end.
 */
export const mergeNotes = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  source: { readonly chatId: string; readonly forkId: string; readonly end: string | null },
  dest: { readonly chatId: string; readonly forkId: string; readonly at: string },
  sourceCast: ReadonlyArray<string>
) {
  const sourceRows = yield* stateEventRowsThrough(
    sql,
    source.chatId as ChatId,
    source.end as SlotId | null,
    source.forkId
  )
  const destRows = yield* stateEventRowsThrough(sql, dest.chatId as ChatId, dest.at as SlotId, dest.forkId)
  const heads = (yield* sql<{ entity: string; revision: RevisionId; doc_json: string }>`
    SELECT e.id AS entity, h.id AS revision, h.doc_json FROM entities e JOIN entity_refs r ON r.entity_id = e.id
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
      AND (json_extract(h.doc_json, '$.owner.chat') = ${source.chatId}
        OR json_extract(h.doc_json, '$.owner.card') IN ${sql.in(sourceCast.length ? [...sourceCast] : [""])})
    ORDER BY e.id`).map((row) => ({ entity: row.entity, revision: row.revision, doc: JSON.parse(row.doc_json) as Doc }))
  if (heads.length === 0) return [] as Array<NoteToBring>
  const sourceEvents = toEvents(sourceRows)
  const destEvents = toEvents(destRows)
  const resolve = Effect.fnUntraced(function* (events: ReadonlyArray<FoldableEvent>) {
    const bound = foldState(events).noteRevisions
    const ids = [...new Set(Object.values(bound))]
    const revisions = new Map(
      (ids.length
        ? yield* sql<{ entity_id: string; id: RevisionId; doc_json: string }>`SELECT entity_id, id, doc_json
          FROM entity_revisions WHERE id IN ${sql.in(ids)}`
        : []
      ).map((r) => [r.id as string, r])
    )
    return heads.map((head) => {
      const pinned = revisions.get(bound[head.entity] ?? "")
      return pinned?.entity_id === head.entity
        ? { entity: head.entity, revision: pinned.id, doc: JSON.parse(pinned.doc_json) as Doc }
        : head
    })
  })
  const there = yield* resolve(sourceEvents)
  const here = yield* resolve(destEvents)
  const onThere = noteSwitches(sourceEvents, there)
  const onHere = noteSwitches(destEvents, here)
  const hereDocs = new Map(here.map((n) => [n.entity, n.doc]))
  // A note an agent's reply wrote exists only where that reply is shown (agentNotes.ts).
  const byAgent = yield* agentWrittenNotes(
    sql,
    heads.filter((n) => typeof ownerOf(n.doc).chat === "string").map((n) => n.entity)
  )
  const named = yield* notesCreated(sql, sourceRows, byAgent)
  const cardIds = new Set<string>()
  for (const { doc } of there) {
    if (typeof ownerOf(doc).card === "string") cardIds.add(ownerOf(doc).card as string)
    const condition = conditionOf(doc)
    if (Array.isArray(condition.cards)) for (const id of condition.cards) cardIds.add(String(id))
    if (typeof condition.card === "string") cardIds.add(condition.card)
  }
  const names = new Map(
    (cardIds.size
      ? yield* sql<{ entity_id: string; label: string }>`SELECT entity_id, label FROM entity_refs
          WHERE entity_id IN ${sql.in([...cardIds])}`
      : []
    ).map((row) => [row.entity_id, row.label])
  )
  const nameOf = (id: string) => names.get(id) ?? "a character"
  const readers = (doc: Doc): Pick<MergeNote, "when" | "names"> => {
    const condition = conditionOf(doc)
    const cards = Array.isArray(condition.cards)
      ? condition.cards.map(String)
      : typeof condition.card === "string"
        ? [condition.card]
        : []
    const placement = doc.placement as { mode?: string; section?: string } | undefined
    if (condition.when === "own_turn" || (placement?.mode === "section" && placement.section === "own_turn"))
      return { when: "own_turn", names: [] }
    if (condition.when === "turn" || condition.when === "not_muted")
      return { when: condition.when, names: cards.map(nameOf) }
    return { when: "always", names: [] }
  }

  const chatNotes: Array<NoteToBring> = []
  for (const { entity, doc } of there) {
    if (ownerOf(doc).chat !== source.chatId || onThere.get(entity) !== true) continue
    if (byAgent.has(entity) && !named.has(entity)) continue
    const linked = typeof doc.link === "string" ? yield* sharedNote(sql, userId, doc.link) : null
    const content = linked?.content ?? (typeof doc.content === "string" ? doc.content : "")
    // The copy is this chat's own: no link, no source messages, no import identity.
    const { link: _link, covers: _covers, source_slot_id: _slot, module_id: _module, ...rest } = doc
    const copy: Doc = { ...rest, owner: { chat: dest.chatId }, content }
    const title = typeof doc.title === "string" && doc.title.trim() ? doc.title : "Untitled note"
    chatNotes.push({
      entry: {
        id: entity,
        notes: [entity as EntityId],
        kind: "chat",
        title,
        card: null,
        ...readers(doc),
        excerpt: excerptOf(content),
        conflict: yield* replacementConflict(sql, userId, null, copy, {
          chatId: dest.chatId as ChatId,
          forkId: dest.forkId as ForkId,
          slotId: null
        })
      },
      copy,
      bindings: []
    })
  }

  // Card notes: on in the source (its switch, else the card's default) and off here.
  const on = (switches: ReadonlyMap<string, boolean>, entity: string, doc: Doc) =>
    switches.get(entity) ?? doc.on_by_default === true
  const groups = new Map<string, Array<{ entity: string; revision: RevisionId; doc: Doc }>>()
  for (const note of there) {
    const card = ownerOf(note.doc).card
    if (typeof card !== "string" || !sourceCast.includes(card)) continue
    const key = typeof note.doc.move_group === "string" ? JSON.stringify([card, note.doc.move_group]) : note.entity
    groups.set(key, [...(groups.get(key) ?? []), note])
  }
  const cardNotes: Array<NoteToBring> = []
  for (const members of groups.values()) {
    if (
      !members.some((m) => on(onThere, m.entity, m.doc)) ||
      members.some((m) => on(onHere, m.entity, hereDocs.get(m.entity) ?? m.doc))
    )
      continue
    // A moved passage is shown by its own-turn part; what's left of the field goes with it.
    const moved = members.length > 1 || typeof members[0]!.doc.move_group === "string"
    const shown = members.find((m) => m.doc.replaces === undefined) ?? members[0]!
    const card = ownerOf(shown.doc).card as string
    const bindings = yield* Effect.forEach(members, (m) =>
      Effect.gen(function* () {
        const linked = typeof m.doc.link === "string" ? yield* sharedNote(sql, userId, m.doc.link) : null
        return {
          note: m.entity as EntityId,
          revision: m.revision,
          doc: m.doc,
          content: linked?.content ?? (typeof m.doc.content === "string" ? m.doc.content : "")
        }
      })
    )
    const content = bindings.find((m) => m.note === shown.entity)!.content
    // A newly joined card may collide with a target this chat already reserved. Resolve
    // its implicit owner before checking, because it isn't in the destination cast yet.
    let conflict: string | null = null
    for (const member of members) {
      const target = readReplaceTarget(member.doc.replaces)
      if (target === null) continue
      const normalized =
        target.kind === "card_field" ? { ...target, card: targetCard(target, card)! as EntityId } : target
      conflict ??= yield* replacementConflict(
        sql,
        userId,
        member.entity,
        {
          ...member.doc,
          owner: { chat: dest.chatId },
          replaces: normalized
        },
        { chatId: dest.chatId as ChatId, forkId: dest.forkId as ForkId, slotId: null }
      )
    }
    cardNotes.push({
      entry: {
        id: shown.entity,
        notes: members.map((m) => m.entity as EntityId),
        kind: "card",
        title: typeof shown.doc.title === "string" && shown.doc.title.trim() ? shown.doc.title : "Untitled note",
        card: nameOf(card),
        ...(moved ? { when: "moved" as const, names: [] } : readers(shown.doc)),
        excerpt: excerptOf(content),
        conflict
      },
      copy: null,
      bindings
    })
  }
  const byTitle = (a: NoteToBring, b: NoteToBring) =>
    (a.entry.card ?? "").localeCompare(b.entry.card ?? "") || a.entry.title.localeCompare(b.entry.title)
  return [...chatNotes.sort(byTitle), ...cardNotes.sort(byTitle)]
})

/**
 * Stores `copy`, a chat note of this chat, as a new note: one entity, its first revision and its
 * ref, as the library creates notes (libraryWrites.ts `createUpstream`). In the caller's
 * transaction; returns the new note's entity.
 */
export const insertCopiedNote = (sql: SqlClient.SqlClient, userId: UserId, copy: Doc, now: number) =>
  Effect.gen(function* () {
    const check = validateDoc("note", copy)
    if (!check.ok)
      return yield* Effect.die(new Error(`refusing to store an invalid note: ${check.problems.join("; ")}`))
    const entityId = uuidv7()
    const revisionId = uuidv7()
    const label = String(copy.title ?? "").slice(0, 200) || "Note"
    yield* sql`INSERT INTO entities ${sql.insert({ id: entityId, owner_user_id: userId, kind: "note", created_at: now })}`
    yield* sql`INSERT INTO entity_revisions ${sql.insert({
      id: revisionId,
      entity_id: entityId,
      parents: "[]",
      doc_json: JSON.stringify(copy),
      doc_hash: docHash(copy),
      schema_version: NOTE_SCHEMA_VERSION,
      origin: "user",
      origin_ref: null,
      message: "Copied by a merge",
      search_text: searchText(copy),
      created_at: now
    })}`
    yield* sql`INSERT INTO entity_refs ${sql.insert({
      id: uuidv7(),
      entity_id: entityId,
      head_revision_id: revisionId,
      merge_base_revision_id: null,
      label,
      subtitle: "",
      source_path: null,
      source_hash: null,
      created_at: now,
      updated_at: now
    })}`
    return entityId as EntityId
  })
