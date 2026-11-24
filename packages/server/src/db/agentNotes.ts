// Notes an agent reply wrote belong to that reply (DESIGN §7.3 [D], owner 2026-11-06): one exists
// in a chat only where the reply that wrote it is shown. Its first revision is the reply's (origin
// `generation`), with the same tool-call provenance as the `note.activate` that created it.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

type NoteEventRow = {
  readonly key: string
  readonly value_json: string
  readonly version_id: string | null
  readonly origin: string
  readonly origin_ref: string | null
}

const noteId = (event: NoteEventRow) => (JSON.parse(event.value_json) as { note: string }).note

/** Of these notes, the ones an agent reply wrote and the tool call that created each. */
export const agentWrittenNotes = (sql: SqlClient.SqlClient, entities: ReadonlyArray<string>) =>
  entities.length === 0
    ? Effect.succeed(new Map<string, string | null>())
    : sql<{ readonly entity_id: string; readonly origin_ref: string | null }>`
        SELECT r.entity_id, r.origin_ref FROM entity_revisions r
        WHERE ${sql.in("r.entity_id", entities)} AND r.origin = 'generation'
          AND r.seq = (SELECT min(f.seq) FROM entity_revisions f WHERE f.entity_id = r.entity_id)`.pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.entity_id, row.origin_ref])))
      )

/** Agent notes whose creation event is on the path, including retained calls carried by Resume. */
export const notesCreated = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<NoteEventRow>,
  creators: ReadonlyMap<string, string | null>
) {
  const named = new Set<string>()
  if (creators.size === 0) return named
  for (const event of events) {
    if (event.key !== "note.activate" || event.origin !== "rollout" || !event.version_id || !event.origin_ref) continue
    const note = noteId(event)
    const creator = creators.get(note)
    if (!creator || named.has(note)) continue
    if (creator === event.origin_ref) {
      named.add(note)
      continue
    }
    // Resume rewrites the rollout portion for its own retained tool calls. The call id
    // and the parent rollout chain identify the same creation even after several Resumes.
    const separator = event.origin_ref.indexOf(":")
    const originalSeparator = creator.indexOf(":")
    if (
      separator < 0 ||
      originalSeparator < 0 ||
      creator.slice(originalSeparator) !== event.origin_ref.slice(separator)
    )
      continue
    const [resumed] = yield* sql<{ id: string }>`
      WITH RECURSIVE lineage(id) AS (
        SELECT ${event.origin_ref.slice(0, separator)}
        UNION
        SELECT r.parent_rollout_id FROM rollouts r JOIN lineage l ON r.id = l.id WHERE r.parent_rollout_id IS NOT NULL
      ) SELECT id FROM lineage WHERE id = ${creator.slice(0, originalSeparator)} LIMIT 1`
    if (resumed) named.add(note)
  }
  return named
})

/** A switch for an agent note whose creator is absent cannot put that note in context. */
export const withoutOrphanNoteActivations = Effect.fnUntraced(function* <A extends NoteEventRow>(
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<A>
) {
  const activations = new Map(events.filter((event) => event.key === "note.activate").map((row) => [row, noteId(row)]))
  const creators = yield* agentWrittenNotes(sql, [...new Set(activations.values())])
  if (creators.size === 0) return events
  const created = yield* notesCreated(sql, events, creators)
  return events.filter((row) => {
    const note = activations.get(row)
    return note === undefined || !creators.has(note) || created.has(note)
  })
})
