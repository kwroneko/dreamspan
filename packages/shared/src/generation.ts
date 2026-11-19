import { LcmDefaults, LcmSettingsChange, ModelChoice } from "./lcmSettings.ts"
// What a user's generations use when a chat doesn't choose (DATA-MODEL §5.4): a default
// model and a default preset, both the user's own.
import { Schema } from "effect"
import { EntityId } from "./chat.ts"
import { RefId } from "./library.ts"
import { ConnectionId } from "./providers.ts"

/** How the built-in prompt preset is named, apart from an imported preset that ST also calls Default. */
export const BUILTIN_PRESET_LABEL = "Default (built-in)"

export class GenerationDefaults extends Schema.Class<GenerationDefaults>("GenerationDefaults")({
  /** The current account model; none, and replies cannot be generated. */
  model: Schema.NullOr(ModelChoice),
  /** The account persona for new chats only; missing or null means no persona. */
  persona: Schema.optionalKey(Schema.NullOr(EntityId)),
  lcm: Schema.optionalKey(LcmDefaults),
  /**
   * The decision model that judges soft refusals (spec/LCM.md §2.4); none, and only a
   * provider's own refusal signal is detected.
   */
  judge: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  /**
   * The judge also reads what a model wrote when it never sent the reply (spec/REPLY-CONTRACT.md
   * §3.6): opt-in, as it sends that text to the judge's model. Absent: off.
   */
  judgeEndings: Schema.optionalKey(Schema.Boolean),
  /** The current account prompt preset; none selects the built-in preset named Default. */
  preset: Schema.NullOr(RefId)
}) {}

/**
 * Some of the defaults, each given one replacing the stored one and the rest left as they are,
 * so a page changing one setting doesn't write back what another tab has changed since.
 * `tail` is the default summarization instruction (`lcm.tail`), `fallback` the fallback
 * summarizer (`lcm.fallback`), `summarizer` the model that writes summaries (`lcm.summarizer`);
 * null removes any of them.
 */
export const GenerationDefaultsChange = Schema.Struct({
  persona: Schema.optionalKey(Schema.NullOr(EntityId)),
  model: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  preset: Schema.optionalKey(Schema.NullOr(RefId)),
  judge: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  judgeEndings: Schema.optionalKey(Schema.Boolean),
  fallback: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  summarizer: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  tail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The summarization defaults for new chats (DESIGN §8), one at a time; null restores the built-in. */
  lcm: Schema.optionalKey(LcmSettingsChange)
})
export type GenerationDefaultsChange = typeof GenerationDefaultsChange.Type

/**
 * What counted a `CountTokens` answer (ARCHITECTURE §6 "Text tokens"): the chat model's own
 * tokenizer (`exact`), or an approximation, with why (`note`), for the count's explanation.
 */
export class TokenizerInfo extends Schema.Class<TokenizerInfo>("TokenizerInfo")({
  id: Schema.String,
  /** "gpt-4o's own tokenizer (o200k_base, …)", "o200k_base, …, as an approximation". */
  label: Schema.String,
  exact: Schema.Boolean,
  note: Schema.optionalKey(Schema.String)
}) {}

/**
 * How one of the user's connections counts tokens (owner, 2026-11-02: "NEVER send anything to
 * providers users didn't actually choose to"; DESIGN §11). A connection with no entry counts on
 * this server (the default). `via` is the connection whose provider receives the text and images
 * being counted: the connection itself, or another of the user's, used only for counting.
 */
export const TokenCountingChoice = Schema.Struct({ connectionId: ConnectionId, via: ConnectionId })
export type TokenCountingChoice = typeof TokenCountingChoice.Type

/** How many texts one `CountTokens` takes, and how long each may be. */
export const COUNT_TOKENS_TEXTS = 64
export const COUNT_TOKENS_CHARS = 500_000
