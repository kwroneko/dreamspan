// What the database writer found when it last started (ARCHITECTURE.md §3.7). Its own module,
// so the database workers, which return it, don't bundle the whole HTTP API from api.ts.
import { Schema } from "effect"

/** Rows that point at a row that isn't there, by table and the table they point into. */
export class BrokenReferences extends Schema.Class<BrokenReferences>("BrokenReferences")({
  table: Schema.String,
  parent: Schema.String,
  rows: Schema.Int
}) {}

/**
 * What the database writer found when it last started: the broken references it started
 * with anyway, and the database changes it applied.
 */
export class DatabaseStartup extends Schema.Class<DatabaseStartup>("DatabaseStartup")({
  broken: Schema.Array(BrokenReferences),
  applied: Schema.Array(Schema.String)
}) {}
