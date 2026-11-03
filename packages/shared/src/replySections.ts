// Tagged sections at the start of a reply (spec/REPLY-SECTIONS.md): a planning section the
// model wrote in tags (`<think>…</think>`) is taken out of the reply's body and shown in a
// panel of its own. The version keeps the exact text around it, so the reply as the model
// wrote it can always be put back together.
import { Schema } from "effect"

export const ReplySection = Schema.Struct({
  /** The whitespace before its opening tag, as it came. */
  lead: Schema.String,
  /** The opening tag as it came. */
  open: Schema.String,
  text: Schema.String,
  /** The closing tag as it came; null: the reply ended inside the section. */
  close: Schema.NullOr(Schema.String),
  /**
   * How many of the first characters of `lead + open + text` the request's prefill supplied
   * (a preset prefill that opens a section), not the model. Absent: none.
   */
  prefilled: Schema.optionalKey(Schema.Int)
})
export type ReplySection = typeof ReplySection.Type

export const ReplySections = Schema.Struct({
  sections: Schema.Array(ReplySection),
  /** The whitespace between the last section and the body. */
  gap: Schema.String
})
export type ReplySections = typeof ReplySections.Type

/**
 * One opening/closing tag pair. The tags are plain text matched exactly, as SillyTavern's
 * reasoning prefix and suffix are (owner, 2026-11-02), unless `regex` opts the pair into
 * regular expressions; matched case-insensitively unless `case_sensitive`.
 */
export const SectionPair = Schema.Struct({
  open: Schema.String,
  close: Schema.String,
  case_sensitive: Schema.optionalKey(Schema.Boolean),
  /** Both tags are regular expressions (the assembler's linear-time engine); absent: literal text. */
  regex: Schema.optionalKey(Schema.Boolean)
})
export type SectionPair = typeof SectionPair.Type

/** The prompt preset's setting (`reply_sections`); absent: `DEFAULT_REPLY_SECTIONS`. */
export const ReplySectionSettings = Schema.Struct({
  enabled: Schema.Boolean,
  pairs: Schema.Array(SectionPair),
  /** The last N replies with sections send them back in their tags; 0: never. */
  send_back: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
})
export type ReplySectionSettings = typeof ReplySectionSettings.Type

/** Both spellings models use, each closed by its own: literal text, in any case. */
const DEFAULT_SECTION_PAIRS: ReadonlyArray<SectionPair> = [
  { open: "<think>", close: "</think>" },
  { open: "<thinking>", close: "</thinking>" }
]

export const DEFAULT_REPLY_SECTIONS: ReplySectionSettings = {
  enabled: true,
  pairs: DEFAULT_SECTION_PAIRS,
  send_back: 0
}

/** A preset document's setting in effect. */
export const replySectionsOf = (doc: { readonly reply_sections?: ReplySectionSettings | undefined }) =>
  doc.reply_sections ?? DEFAULT_REPLY_SECTIONS

/** A literal tag as a pattern matching just it (how the parser compiles a pair that isn't a regex). */
export const literalPattern = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")

const sectionText = (section: ReplySection) => section.lead + section.open + section.text + (section.close ?? "")

/** The sections in their tags as they came, with the whitespace before the body. */
export const sectionsPrefix = (sections: ReplySections) => sections.sections.map(sectionText).join("") + sections.gap

/** The reply as the request ended up with it: the sections in their tags, then the body. */
export const originalReply = (content: string, sections: ReplySections | null | undefined) =>
  sections ? sectionsPrefix(sections) + content : content

/** What the panel shows: the sections' text, a blank line apart. Streams append-only. */
export const sectionsDisplay = (sections: ReplySections | null | undefined) =>
  (sections?.sections ?? []).map((section) => section.text).join("\n\n")

/** Whether the reply ended inside its last section. */
export const sectionUnclosed = (sections: ReplySections | null | undefined) => sections?.sections.at(-1)?.close === null
