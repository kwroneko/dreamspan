import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { contextExcluded } from "./lcmVisibility.ts"

type Row = Record<string, string | number | null>

/** Copy one recorded position under a new parent without moving or erasing the old path.
 * Called only inside StImportMessages' writer transaction. Work stays bounded by its batch.
 */
export const forkImportSlot = (sql: SqlClient.SqlClient, source: string, parent: string | null) =>
  Effect.gen(function* () {
    const [slot] =
      yield* sql<Row>`SELECT s.*, ${sql.literal(contextExcluded())} AS shown_excluded FROM slots s WHERE s.id = ${source}`
    const versions = yield* sql<Row>`SELECT * FROM versions WHERE slot_id = ${source} ORDER BY ordinal`
    const id = uuidv7()
    const ids = new Map(versions.map((v) => [v.id, uuidv7()]))
    for (const version of versions) {
      const { seq: _seq, ...fields } = version
      const versionId = ids.get(version.id)!
      yield* sql`INSERT INTO versions ${sql.insert({
        ...fields,
        status: version.status === "generating" ? "interrupted" : version.status,
        id: versionId,
        slot_id: id,
        source_version_id: ids.get(version.source_version_id) ?? version.source_version_id
      })}`
      yield* sql`INSERT INTO version_history (version_id, content, replaced_at)
        SELECT ${versionId}, content, replaced_at FROM version_history WHERE version_id = ${version.id} ORDER BY id`
      yield* sql`INSERT INTO version_attachments (version_id, ordinal, media_id, kind, alt_text)
        SELECT ${versionId}, ordinal, media_id, kind, alt_text FROM version_attachments WHERE version_id = ${version.id}`
    }
    const { shown_excluded, ...position } = slot!
    yield* sql`INSERT INTO slots ${sql.insert({
      ...position,
      context_excluded: shown_excluded,
      id,
      parent_slot_id: parent,
      selected_version_id: ids.get(slot!.selected_version_id)!
    })}`
    const events = yield* sql<Row>`SELECT * FROM state_events WHERE slot_id = ${source}`
    for (const event of events) {
      yield* sql`INSERT INTO state_events ${sql.insert({
        ...event,
        id: uuidv7(),
        slot_id: id,
        version_id: ids.get(event.version_id) ?? event.version_id
      })}`
    }
    return id
  })
