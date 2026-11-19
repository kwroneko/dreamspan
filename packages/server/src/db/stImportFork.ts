import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { currentForkSql, replacedIn, selectedInSql } from "./forkState.ts"
import type { SqlClient } from "effect/sql"
import { contextExcludedIn } from "./lcmVisibility.ts"

type Row = Record<string, string | number | null>

/** Copy one recorded position under a new parent without moving or erasing the old path.
 * Called only inside StImportMessages' writer transaction. Work stays bounded by its batch.
 */
export const forkImportSlot = (sql: SqlClient.SqlClient, source: string, parent: string | null, forkId: string) =>
  Effect.gen(function* () {
    // The copy is inserted with the selection the chat's current fork shows (forkState.ts).
    const [slot] =
      yield* sql<Row>`SELECT s.*, ${contextExcludedIn(sql, sql.literal(currentForkSql("s.chat_id")))} AS shown_excluded,
        ${sql.literal(selectedInSql(currentForkSql("s.chat_id"), "s"))} AS shown_version_id
      FROM slots s WHERE s.id = ${source}`
    // The message's own versions, each with the text the current fork shows in its place: a
    // fork's copies stand in for them only in that fork, which this suffix isn't on, but the
    // amend is the current fork's local change, kept as its selection is
    // (spec/FORK-INDEPENDENCE-DELTA.md §5 step 6, unit 9).
    const versions =
      yield* sql<Row>`SELECT v.*, ${replacedIn(sql, sql.literal(currentForkSql("s.chat_id")), "v.id")} AS shown_id
      FROM version_records v JOIN slots s ON s.id = v.slot_id WHERE v.slot_id = ${source} AND v.fork_id IS NULL
      ORDER BY v.ordinal`
    const id = uuidv7()
    const ids = new Map(versions.map((v) => [v.id, uuidv7()]))
    // What referred to a copy (an event attached to it) refers to the version taking its text.
    for (const v of versions) if (v.shown_id !== v.id) ids.set(v.shown_id, ids.get(v.id)!)
    for (const version of versions) {
      const { seq: _seq, shown_id: shownId, ...fields } = version
      const versionId = ids.get(version.id)!
      const [copy] =
        shownId === version.id
          ? []
          : yield* sql<Row>`SELECT content, updated_at FROM version_records WHERE id = ${shownId}`
      yield* sql`INSERT INTO version_records ${sql.insert({
        ...fields,
        ...copy,
        status: version.status === "generating" ? "interrupted" : version.status,
        id: versionId,
        slot_id: id,
        authoring_fork_id: forkId,
        source_version_id: ids.get(version.source_version_id) ?? version.source_version_id
      })}`
      yield* sql`INSERT INTO version_history (version_id, content, replaced_at, images_json, reasoning_json, sections_json)
        SELECT ${versionId}, content, replaced_at, images_json, reasoning_json, sections_json FROM version_history WHERE version_id = ${shownId} ORDER BY id`
      yield* sql`INSERT INTO version_attachments (version_id, ordinal, media_id, kind, alt_text, name, path)
        SELECT ${versionId}, ordinal, media_id, kind, alt_text, name, path FROM version_attachments WHERE version_id = ${shownId}`
    }
    // The copy's chain is the database's to assign (schema/chains.ts), as are its events'.
    const { shown_excluded, shown_version_id, chain_id: _chain, ...position } = slot!
    yield* sql`INSERT INTO slots ${sql.insert({
      ...position,
      context_excluded: shown_excluded,
      id,
      fork_id: forkId,
      parent_slot_id: parent,
      selected_version_id: ids.get(shown_version_id!)!
    })}`
    const events = yield* sql<Row>`SELECT * FROM state_events WHERE slot_id = ${source}`
    for (const { slot_chain_id: _chain, slot_depth: _depth, ...event } of events) {
      // One on another fork's copy stays with that fork, at the slot its path keeps.
      if (event.version_id !== null && !ids.has(event.version_id as string)) continue
      yield* sql`INSERT INTO state_events ${sql.insert({
        ...event,
        id: uuidv7(),
        slot_id: id,
        version_id: ids.get(event.version_id) ?? event.version_id
      })}`
    }
    return id
  })
