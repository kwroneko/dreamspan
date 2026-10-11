// The note document (DATA-MODEL §3.3, §6; DESIGN §4.1). Only what the importer writes so
// far: a card-owned note at a depth and role, which is what ST's Character's Note is
// (DESIGN §4.1a). Other owners, placements and conditions arrive with the assembler.
import { Schema } from "effect"
import { EntityId } from "../chat.ts"
import { LoreRole } from "./lorebook.ts"

export const NOTE_SCHEMA_VERSION = 1

export const NoteDoc = Schema.Struct({
  schema_version: Schema.Literal(NOTE_SCHEMA_VERSION),
  title: Schema.String,
  content: Schema.String,
  /** In-chat, this many messages from the end, sent with this role. */
  placement: Schema.Struct({
    mode: Schema.Literal("depth"),
    depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    role: LoreRole
  }),
  /** The card whose note this is. */
  owner: Schema.Struct({ card: EntityId }),
  /** Private notes never leave in an export. */
  exportable: Schema.Boolean
})
export type NoteDoc = typeof NoteDoc.Type
