// The note document (DATA-MODEL §3.3, §6; DESIGN §4.1). Only what the importers write so
// far: a card-owned note at a depth and role, which is what ST's Character's Note is
// (DESIGN §4.1a), and the chat-owned notes an ST chat brings (ARCHITECTURE.md §13): its
// author's note and its summary. Other owners, placements and conditions arrive with the
// assembler.
import { Schema } from "effect"
import { ChatId, EntityId, SlotId } from "../chat.ts"
import { LoreRole } from "./lorebook.ts"

export const NOTE_SCHEMA_VERSION = 1

/** In-chat, this many messages from the end, sent with this role. */
const DepthPlacement = Schema.Struct({
  mode: Schema.Literal("depth"),
  depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  role: LoreRole
})

/**
 * [P] The fixed places ST puts an extension prompt or a persona description: before or
 * after the main prompt (story string), or at the top or bottom of the author's note.
 */
const SectionPlacement = Schema.Struct({
  mode: Schema.Literal("section"),
  section: Schema.Literals(["before_main_prompt", "after_main_prompt", "author_note_top", "author_note_bottom"])
})

/** [P] Not placed: only a macro (ST's `{{summary}}`) reads it. */
const NoPlacement = Schema.Struct({ mode: Schema.Literal("none") })

export const NoteDoc = Schema.Struct({
  schema_version: Schema.Literal(NOTE_SCHEMA_VERSION),
  title: Schema.String,
  content: Schema.String,
  placement: Schema.Union([DepthPlacement, SectionPlacement, NoPlacement]),
  /** The card or chat whose note this is. */
  owner: Schema.Union([Schema.Struct({ card: EntityId }), Schema.Struct({ chat: ChatId })]),
  /** Private notes never leave in an export. */
  exportable: Schema.Boolean,
  /**
   * [P] What an imported chat note was in ST: its author's note, or the Summarize
   * extension's summary (DESIGN §8.1), kept in its own note.
   */
  kind: Schema.optionalKey(Schema.Literals(["author_note", "imported_summary"])),
  /** [P] ST's author's note frequency: sent every this many messages; 0 never (ST's `note_interval`). */
  interval: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** [P] How a summary is sent: ST's template, with `{{summary}}` standing for the content. */
  template: Schema.optionalKey(Schema.String),
  /**
   * [P] The run of messages hidden from the chat's first message that the summary covers
   * (DESIGN §8.1), so LCM can adopt it as the L1 summary of that range once it's enabled.
   */
  covers: Schema.optionalKey(Schema.Struct({ first_slot_id: SlotId, last_slot_id: SlotId, slot_count: Schema.Int }))
})
export type NoteDoc = typeof NoteDoc.Type
