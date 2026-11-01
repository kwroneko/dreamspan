// The note document (DATA-MODEL §3.3, §6; DESIGN §4.1). A note slot belongs to a card or a
// chat; a shared named note (`owner: { shared: "global" }`) is the text a slot can link to.
// ST's Character's Note, Character Author's Note and author's note import as notes (§13).
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
   * [P] `card`: with the card's definition, at the top. Before or after the main prompt (story
   * string) are the fixed places ST puts an extension prompt. `author_note_top` and
   * `author_note_bottom` are only decoded, in revisions from before notes had no author's note
   * to ride on (owner, 2026-11-01): nothing writes them, and they're read as `LEGACY_PLACEMENT`.
   */
  Schema.Struct({
    mode: Schema.Literal("section"),
    section: Schema.Literals([
      "context_start",
      "tail_start",
      "tail_end",
      "card",
      "before_main_prompt",
      "after_main_prompt",
      "author_note_top",
      "author_note_bottom"
    ]),
    role: Schema.optionalKey(LoreRole)
  }),
  /** [P] Not placed: only a macro (ST's `{{summary}}`) reads it. */
  Schema.Struct({ mode: Schema.Literal("none") })
])
export type Placement = typeof Placement.Type

/**
 * Where a placement from an old revision that put a note at the top or bottom of the chat's
 * author's note goes: ST's default author's note place, in the chat at depth 4 as the system.
 * The startup conversion gave every live note its chat's concrete place; this is for history.
 */
export const LEGACY_PLACEMENT = { mode: "depth", depth: 4, role: "system" } as const satisfies Placement

/** A placement as it's used: an old revision's author's-note-relative one as `LEGACY_PLACEMENT`. */
export const concretePlacement = (placement: Placement): Placement =>
  placement.mode === "section" &&
  (placement.section === "author_note_top" || placement.section === "author_note_bottom")
    ? LEGACY_PLACEMENT
    : placement

/**
 * When a note applies (DESIGN §4.1): always; only on a card's turn (the speaker of the
 * message being generated); or while a card isn't muted. Absent is always.
 */
export const NoteCondition = Schema.Union([
  Schema.Struct({ when: Schema.Literal("always") }),
  Schema.Struct({ when: Schema.Literal("turn"), card: EntityId }),
  Schema.Struct({ when: Schema.Literal("not_muted"), card: EntityId })
])
export type NoteCondition = typeof NoteCondition.Type

/** Who a note belongs to: a card, a chat, or no one (a shared named note/snippet, global or chat-scoped). */
const NoteOwner = Schema.Union([
  Schema.Struct({ card: EntityId }),
  Schema.Struct({ chat: ChatId }),
  Schema.Struct({ shared: Schema.Union([Schema.Literal("global"), ChatId]) })
])

export const NoteDoc = Schema.Struct({
  schema_version: Schema.Literal(NOTE_SCHEMA_VERSION),
  title: Schema.String,
  content: Schema.String,
  placement: Placement,
  /** The card or chat whose note this is, or `shared` for a shared named note. */
  owner: NoteOwner,
  /** When it applies (absent: always). */
  condition: Schema.optionalKey(NoteCondition),
  /** Lorebook entries can trigger on its text (ST's "Include in World Info Scanning"). Absent is off. */
  scan_lore: Schema.optionalKey(Schema.Boolean),
  /** A card's note on in every chat with the card unless the chat switches it off. Absent is off. */
  on_by_default: Schema.optionalKey(Schema.Boolean),
  /**
   * The shared named note this slot shows: its text is that note's library head, and this
   * slot's own `content` is ignored while linked. Changed only by its own actions.
   */
  link: Schema.optionalKey(EntityId),
  /** The card module this note was made from, or an export's note id: how re-imports find it. */
  module_id: Schema.optionalKey(Schema.String),
  /** Private notes never leave in an export. */
  exportable: Schema.Boolean,
  /**
   * The agent may change this note during a chat (DESIGN §4.1a, proposed). Absent is off.
   * Stored only: nothing reads it until agents exist, and no file sets it.
   */
  agent_editable: Schema.optionalKey(Schema.Boolean),
  /**
   * [P] What an imported note was in ST: the Summarize extension's summary (DESIGN §8.1), kept
   * in its own note; or a card's Character Author's Note from ST's settings
   * (`extension_settings.note.chara`), which a re-import finds by it. `author_note` and
   * `persona_description` are still decoded in old revisions, never written and ignored: a
   * chat's imported author's note is an ordinary note (owner, 2026-11-01), and migration 0050
   * made persona notes ordinary (DESIGN §4.1: no hidden note kinds).
   */
  kind: Schema.optionalKey(
    Schema.Literals(["author_note", "imported_summary", "persona_description", "character_author_note"])
  ),
  /**
   * Deprecated: ST's author's note frequency, which older imports kept. Still read, never
   * written; the assembler ignores it (a note goes every turn, DESIGN §4.1).
   */
  interval: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** [P] How a summary is sent: ST's template, with `{{summary}}` standing for the content. */
  template: Schema.optionalKey(Schema.String),
  /**
   * [P] The run of messages hidden from the chat's first message that the summary covers
   * (DESIGN §8.1), so LCM can adopt it as the L1 summary of that range once it's enabled.
   */
  covers: Schema.optionalKey(Schema.Struct({ first_slot_id: SlotId, last_slot_id: SlotId, slot_count: Schema.Int })),
  /**
   * [P] For an imported summary, the message ST saved this text on (`extra.memory`): ST sends
   * the latest one on the chat before its last message, so it applies on paths through it.
   */
  source_slot_id: Schema.optionalKey(SlotId)
})
export type NoteDoc = typeof NoteDoc.Type

/** A note's condition, absent read as always. */
export const noteCondition = (doc: Pick<NoteDoc, "condition">): NoteCondition => doc.condition ?? { when: "always" }
