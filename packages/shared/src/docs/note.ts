// The note document (DATA-MODEL §3.3, §6; DESIGN §4.1). What the importers write so far: a
// card-owned note at a depth and role, which is what ST's Character's Note is (DESIGN
// §4.1a), and the chat-owned notes an ST chat brings (ARCHITECTURE.md §13): its author's
// note and its summary. The card editor makes more card notes. Other owners and conditions
// arrive with the assembler.
import { Schema } from "effect"
import { ChatId, EntityId, SlotId } from "../chat.ts"
import { LoreRole } from "./lorebook.ts"

export const NOTE_SCHEMA_VERSION = 1

/** The deepest a note goes in the chat: ST's own limit (`MAX_INJECTION_DEPTH`). */
export const MAX_NOTE_DEPTH = 10_000

/** A depth ST would use: past its limit, the limit; not a whole number from 0, its default, 4. */
export const noteDepth = (depth: unknown) =>
  typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0 ? Math.min(depth, MAX_NOTE_DEPTH) : 4

/**
 * Where a note or card module goes in the context (DESIGN §5.2, proposed): in-chat at a
 * depth with a role; at the tail (depth 0); in a fixed section; or nowhere, read only by a
 * macro.
 */
export const Placement = Schema.Union([
  /** In-chat, this many messages from the end, sent with this role. */
  Schema.Struct({
    mode: Schema.Literal("depth"),
    depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_NOTE_DEPTH })),
    role: LoreRole
  }),
  Schema.Struct({ mode: Schema.Literal("tail"), role: LoreRole }),
  /**
   * [P] `card`: with the card's definition, at the top. The others are the fixed places ST
   * puts an extension prompt or a persona description: before or after the main prompt
   * (story string), or at the top or bottom of the author's note.
   */
  Schema.Struct({
    mode: Schema.Literal("section"),
    section: Schema.Literals([
      "card",
      "before_main_prompt",
      "after_main_prompt",
      "author_note_top",
      "author_note_bottom"
    ])
  }),
  /** [P] Not placed: only a macro (ST's `{{summary}}`) reads it. */
  Schema.Struct({ mode: Schema.Literal("none") })
])
export type Placement = typeof Placement.Type

export const NoteDoc = Schema.Struct({
  schema_version: Schema.Literal(NOTE_SCHEMA_VERSION),
  title: Schema.String,
  content: Schema.String,
  placement: Placement,
  /** The card or chat whose note this is. */
  owner: Schema.Union([Schema.Struct({ card: EntityId }), Schema.Struct({ chat: ChatId })]),
  /** Private notes never leave in an export. */
  exportable: Schema.Boolean,
  /**
   * The agent may change this note during a chat (DESIGN §4.1a, proposed). Absent is off.
   * Stored only: nothing reads it until agents exist, and no file sets it.
   */
  agent_editable: Schema.optionalKey(Schema.Boolean),
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
