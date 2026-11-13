// The note document (DATA-MODEL §3.3, §6; DESIGN §4.1). A note slot belongs to a card or a
// chat; a shared named note (`owner: { shared: "global" }`) is the text a slot can link to.
// ST's Character's Note, Character Author's Note and author's note import as notes (§13).
import { Option, Schema, SchemaTransformation } from "effect"
import { ChatId, EntityId, SlotId } from "../chat.ts"
import { LoreRole } from "./lorebook.ts"

export const NOTE_SCHEMA_VERSION = 1

export const OWN_TURN_FRAMING =
  "[Background on {{char}}, as the story began. Where the story since then shows {{char}} differently, the story wins.]"

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
   * string) are the fixed places ST puts an extension prompt. Nothing is placed relative to
   * another note (owner, 2026-11-01: no author's note).
   */
  Schema.Struct({
    mode: Schema.Literal("section"),
    section: Schema.Literals([
      "context_start",
      "tail_start",
      "own_turn",
      "tail_end",
      "card",
      "before_main_prompt",
      "after_main_prompt"
    ]),
    role: Schema.optionalKey(LoreRole)
  }),
  /** [P] Not placed: only a macro (ST's `{{summary}}`) reads it. */
  Schema.Struct({ mode: Schema.Literal("none") })
])
export type Placement = typeof Placement.Type

/** The most cards a note's condition names. */
const MAX_CONDITION_CARDS = 100

/** A conditioned note's cards: one or more, each once. */
const ConditionCards = Schema.Array(EntityId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CONDITION_CARDS),
  Schema.isUnique()
)

/** The conditions that name cards: on the turn of one of them, or while one of them isn't muted. */
const CardCondition = Schema.Struct({ when: Schema.Literals(["turn", "not_muted"]), cards: ConditionCards })

/**
 * The shape from before a condition named several cards (`card`, one), still in stored notes:
 * read as a list of that one card, and written as the list from then on.
 */
const SingleCard = Schema.Struct({ when: Schema.Literals(["turn", "not_muted"]), card: EntityId })
const SingleCardCondition = SingleCard.pipe(
  Schema.decodeTo(
    CardCondition,
    SchemaTransformation.transform<typeof CardCondition.Encoded, typeof SingleCard.Type>({
      decode: ({ when, card }) => ({ when, cards: [card] }),
      encode: ({ when, cards }) => ({ when, card: cards[0] as EntityId })
    })
  )
)

/**
 * When a note applies (DESIGN §4.1): always; on the turn of any of its cards (the speaker of
 * the message being generated is one of them); or while any of its cards is in the chat and
 * not muted. Absent is always. A stored `{ when, card }` reads as `{ when, cards: [card] }`.
 */
export const NoteCondition = Schema.Union([
  Schema.Struct({ when: Schema.Literal("always") }),
  Schema.Struct({ when: Schema.Literal("own_turn") }),
  CardCondition,
  SingleCardCondition
])
export type NoteCondition = typeof NoteCondition.Type

/**
 * The card fields a note can replace (DESIGN §4.2, spec/NOTE-OVERRIDES.md): those sent as prompt
 * text. A persona has only its description.
 */
export const REPLACEABLE_CARD_FIELDS = [
  "description",
  "personality",
  "scenario",
  "mes_example",
  "system_prompt",
  "post_history_instructions"
] as const
export type ReplaceableCardField = (typeof REPLACEABLE_CARD_FIELDS)[number]

/**
 * What a note replaces wherever it applies (DESIGN §4.2): a preset prompt by its identifier,
 * resolved in whichever preset the chat uses, or a card field. A card field's `card` is the
 * character's place in the chat: the card named, or whichever card took its place through the
 * branch's swaps (Fork for this chat, Use another version). A card's own note may leave it out
 * for its own card.
 */
export const ReplaceTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("preset_prompt"),
    identifier: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
  }),
  Schema.Struct({
    kind: Schema.Literal("card_field"),
    field: Schema.Literals(REPLACEABLE_CARD_FIELDS),
    card: Schema.optionalKey(EntityId)
  })
])
export type ReplaceTarget = typeof ReplaceTarget.Type

const decodeTarget = Schema.decodeUnknownOption(ReplaceTarget)

/** A stored `replaces`, or null when there's none or it isn't one (an undecoded document's). */
export const readReplaceTarget = (raw: unknown): ReplaceTarget | null => Option.getOrNull(decodeTarget(raw))

/**
 * Whether a note goes where the prompt it replaces goes (DESIGN §4.2: by default), rather than at
 * its own placement: then its placement is ignored.
 */
export const replacesInPlace = (doc: { readonly replaces?: unknown; readonly own_position?: unknown }) =>
  readReplaceTarget(doc.replaces) !== null && doc.own_position !== true

/**
 * The card a card-field target names, its own card filled in for a card's note; null for a
 * preset prompt, or a chat's note that names none.
 */
export const targetCard = (target: ReplaceTarget, ownerCard: string | null): string | null =>
  target.kind === "card_field" ? (target.card ?? ownerCard) : null

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
  /**
   * The preset prompt or card field this note replaces wherever it applies (DESIGN §4.2): on, it's
   * sent in that prompt's place, and empty, the prompt is off; off, the prompt comes back.
   */
  replaces: Schema.optionalKey(ReplaceTarget),
  /**
   * With `replaces`: the note goes at its own `placement`, and the prompt it replaces is left out.
   * Absent or false, it goes where that prompt would have gone.
   */
  own_position: Schema.optionalKey(Schema.Boolean),
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
  /** Notes made by the same field move, switched together. No card ids, so exports keep it. */
  move_group: Schema.optionalKey(Schema.String),
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
   * (`extension_settings.note.chara`), which a re-import finds by it. A chat's imported author's
   * note is an ordinary note with no kind (owner, 2026-11-01). `persona_description` is still
   * decoded in old revisions, never written and ignored: migration 0050 made those notes
   * ordinary (DESIGN §4.1: no hidden note kinds).
   */
  kind: Schema.optionalKey(Schema.Literals(["imported_summary", "persona_description", "character_author_note"])),
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

const decodeCondition = Schema.decodeUnknownOption(NoteCondition)

/**
 * A condition as stored, either shape, read as the current one: for a document that hasn't
 * been decoded (the editor's). Absent, or not a condition, is always.
 */
export const readNoteCondition = (raw: unknown): NoteCondition =>
  Option.getOrElse(decodeCondition(raw), (): NoteCondition => ({ when: "always" }))

/** A stored condition in the single-card shape, and nothing else, as the list; any other value as it is. */
export const upgradedCondition = (value: unknown): unknown =>
  Schema.is(SingleCard)(value) && Object.keys(value).length === 2 ? { when: value.when, cards: [value.card] } : value

/** Names as a sentence lists them, any one of them: "Aria", "Aria or Bram", "Aria, Bram or Cato". */
export const anyOf = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`

/** The cards a condition names: none for always. */
export const conditionCards = (condition: NoteCondition): ReadonlyArray<EntityId> =>
  condition.when === "always" || condition.when === "own_turn" ? [] : condition.cards
