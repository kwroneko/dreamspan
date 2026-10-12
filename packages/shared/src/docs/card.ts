// The card document (DATA-MODEL §3.3): the union of Character Card V2 and V3, plus card
// modules (DESIGN §4.1). Field names follow the card specs, so an export maps one to one.
import { Schema } from "effect"
import { LorebookDoc } from "./lorebook.ts"
import { Placement } from "./note.ts"

export const CARD_SCHEMA_VERSION = 1

const Extensions = Schema.Record(Schema.String, Schema.Unknown)

/** A V3 asset. `embeded://` URIs (the spec's spelling) name a file inside a CHARX. */
export const CardAsset = Schema.Struct({
  type: Schema.String,
  uri: Schema.String,
  name: Schema.String,
  ext: Schema.String
})
export type CardAsset = typeof CardAsset.Type

/** An extended prompt attached to the card. Private modules never leave in an export. */
export const CardModule = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  exportable: Schema.Boolean,
  /** Absent: in the card's own section, with its definition (DESIGN §5.2). */
  placement: Schema.optionalKey(Placement),
  /** As a note's (note.ts): stored only, off when absent, and no file sets it. */
  agent_editable: Schema.optionalKey(Schema.Boolean)
})
export type CardModule = typeof CardModule.Type

export const CardDoc = Schema.Struct({
  schema_version: Schema.Literal(CARD_SCHEMA_VERSION),
  /** The in-chat name, what `{{char}}` resolves to (DESIGN §4). */
  name: Schema.String,
  description: Schema.String,
  personality: Schema.String,
  scenario: Schema.String,
  first_mes: Schema.String,
  mes_example: Schema.String,
  alternate_greetings: Schema.Array(Schema.String),
  group_only_greetings: Schema.Array(Schema.String),
  system_prompt: Schema.String,
  post_history_instructions: Schema.String,
  creator_notes: Schema.String,
  creator_notes_multilingual: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  nickname: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Array(Schema.String)),
  tags: Schema.Array(Schema.String),
  creator: Schema.String,
  character_version: Schema.String,
  /** Unix seconds, as V3 has them. */
  creation_date: Schema.optionalKey(Schema.Finite),
  modification_date: Schema.optionalKey(Schema.Finite),
  /** Set by the importer once the avatar is stored; parsers leave it null. */
  avatar_media_id: Schema.NullOr(Schema.String),
  /** Absent means V3's default: the avatar as the main icon. */
  assets: Schema.optionalKey(Schema.Array(CardAsset)),
  /** The stored files of embedded assets, by their `uri`. Set by the importer like the avatar. */
  asset_media_ids: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  character_book: Schema.optionalKey(LorebookDoc),
  modules: Schema.Array(CardModule),
  /** The card's `data.extensions`, verbatim, with plugin namespaces (PLUGINS §3.3). */
  extensions: Extensions,
  /** Keys in `data` the specs don't define, kept so an export writes them back. */
  unknown_fields: Schema.optionalKey(Extensions),
  /** The same for the card's top level. */
  unknown_root_fields: Schema.optionalKey(Extensions)
})
export type CardDoc = typeof CardDoc.Type
