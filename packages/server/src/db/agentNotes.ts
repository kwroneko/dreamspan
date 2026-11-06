// Notes an agent reply wrote belong to that reply (DESIGN §7.3 [D], owner 2026-11-06): one exists
// in a chat only where the reply that wrote it is shown. Its first revision is the reply's (origin
// `generation`), and the reply's own `note.activate` is on the path exactly where the reply is
// shown. Every listing of a chat's notes at a
// position (the Notes list, the note tools, the one-note-per-target check) goes through these.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

/** Of these notes, the ones an agent reply wrote. */
export const agentWrittenNotes = (sql: SqlClient.SqlClient, entities: ReadonlyArray<string>) =>
  entities.length === 0
    ? Effect.succeed(new Set<string>())
    : sql<{ readonly entity_id: string }>`
        SELECT r.entity_id FROM entity_revisions r
        WHERE ${sql.in("r.entity_id", entities)} AND r.origin = 'generation'
          AND r.seq = (SELECT min(f.seq) FROM entity_revisions f WHERE f.entity_id = r.entity_id)`.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.entity_id)))
      )

/**
 * The notes turned on somewhere on a path. For a note an agent reply wrote that is its reply's own
 * `note.activate` (nothing else can turn it on where it isn't listed), so a later reply's revision
 * of it (`note.binding`) doesn't bring it back where its reply was swiped away.
 */
export const notesNamed = (events: ReadonlyArray<{ readonly key: string; readonly value_json: string }>) => {
  const named = new Set<string>()
  for (const event of events)
    if (event.key === "note.activate") named.add(String((JSON.parse(event.value_json) as { note?: unknown }).note))
  return named
}
