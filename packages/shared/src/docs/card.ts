// The card document (DATA-MODEL §3.3): the union of Character Card V2 and V3. Field names
// follow the card specs, so an export maps one to one. Card modules are card notes now
// (DESIGN §5.0); older revisions keep their `modules`.
import { Schema } from "effect"
import { StoredCrop } from "../media.ts"
import { LorebookDoc } from "./lorebook.ts"
import { Placement, REPLACEABLE_CARD_FIELDS } from "./note.ts"
import { RegexScript } from "./regexScript.ts"

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

/** Deprecated: an extended prompt attached to the card, before card modules became card notes. */
const CardModule = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  exportable: Schema.Boolean,
  /** Absent: in the card's own section, with its definition (DESIGN §5.2). */
  placement: Schema.optionalKey(Placement),
  /** As a note's (note.ts): stored only, off when absent, and no file sets it. */
  agent_editable: Schema.optionalKey(Schema.Boolean)
})

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
  /**
   * The avatar's cuts: the optional Picture rectangle and the 2:3 part small portraits show (ARCHITECTURE.md §14.5c), for
   * the image it names. Absent, or for another image: the default. Changed only with the avatar
   * (SetCardAvatar) or by SetCardAvatarCrop, never by a draft.
   */
  avatar_crop: Schema.optionalKey(StoredCrop),
  /** Absent means V3's default: the avatar as the main icon. */
  assets: Schema.optionalKey(Schema.Array(CardAsset)),
  /** The stored files of embedded assets, by their `uri`. Set by the importer like the avatar. */
  asset_media_ids: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  character_book: Schema.optionalKey(LorebookDoc),
  /** Deprecated: read only by the migration that made them card notes (DESIGN §5.0). */
  modules: Schema.optionalKey(Schema.Array(CardModule)),
  /**
   * ST's scoped regex scripts (`extensions.regex_scripts`), as data: the importer moves them
   * here and the exporter writes them back. Absent: none.
   */
  regex: Schema.optionalKey(Schema.Array(RegexScript)),
  /**
   * The user allowed this card's regex scripts to run, as ST asks once per character. None of
   * `regex` runs until this is true. Import never sets it and export never writes it (DESIGN
   * §11: a file never grants itself capabilities); only SetRegexApproval changes it.
   */
  regex_approved: Schema.optionalKey(Schema.Boolean),
  /**
   * The user allowed scripts in this card's panels to run (spec/HTML-MESSAGES.md §3.4), in
   * sandboxed frames. Absent: off. Import never sets it and export never writes it, as
   * `regex_approved`; only SetHtmlApproval changes it.
   */
  html_scripts_approved: Schema.optionalKey(Schema.Boolean),
  /** Its panels may also load from and send to other sites (`https:`); only with scripts allowed. */
  html_network_approved: Schema.optionalKey(Schema.Boolean),
  /**
   * The fields an agent reply may change in a chat (DESIGN §4.1a, spec/AGENTIC.md §4.3): never the
   * card itself, a note replacing the field there (§4.6). Absent: none. A chat can override it.
   * Import never sets it and export never writes it, as `regex_approved`.
   */
  agent_editable_fields: Schema.optionalKey(Schema.Array(Schema.Literals(REPLACEABLE_CARD_FIELDS))),
  /** The card's `data.extensions`, verbatim, with plugin namespaces (PLUGINS §3.3). */
  extensions: Extensions,
  /** Keys in `data` the specs don't define, kept so an export writes them back. */
  unknown_fields: Schema.optionalKey(Extensions),
  /** The same for the card's top level. */
  unknown_root_fields: Schema.optionalKey(Extensions)
})
export type CardDoc = typeof CardDoc.Type
