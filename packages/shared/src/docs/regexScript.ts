// ST's regex scripts as data (extensions/regex). Presets, cards and the account's global list
// hold the same shape; the assembler and the write path run them (ARCHITECTURE §9, §15).
import { Schema } from "effect"

const Json = Schema.Record(Schema.String, Schema.Unknown)

/**
 * A regex script (ST's regex extension): a preset's, a card's or the account's global list. Stored as data and never compiled at import; compiling
 * one needs a ReDoS guard. `prompt_only` scripts rewrite text only in the assembled prompt;
 * `markdown_only` ones only in what's displayed (display rules); a script with neither
 * rewrites message text as it's sent or received.
 */
export const RegexScript = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  find_regex: Schema.String,
  replace_string: Schema.String,
  trim_strings: Schema.Array(Schema.String),
  /** ST's numbers: 1 user input, 2 AI output, 3 slash commands, 5 world info, 6 reasoning. */
  placement: Schema.Array(Schema.Int),
  disabled: Schema.Boolean,
  markdown_only: Schema.Boolean,
  prompt_only: Schema.Boolean,
  run_on_edit: Schema.Boolean,
  /** Whether macros in `find_regex` are expanded first, and how (escaped for use in a regex). */
  substitute_regex: Schema.Literals(["none", "raw", "escaped"]),
  /**
   * Message depths the script applies to; null means unbounded. ST reads an infinite minimum
   * as "never at any depth", imported as `Number.MAX_VALUE`.
   */
  min_depth: Schema.NullOr(Schema.Finite),
  max_depth: Schema.NullOr(Schema.Finite),
  unsupported: Schema.optionalKey(Json)
})
export type RegexScript = typeof RegexScript.Type
