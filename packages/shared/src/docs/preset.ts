// The preset document (DATA-MODEL §3.3, DESIGN §1.2): an ST chat-completion preset,
// normalized. Field names follow ST's where the assembler maps them per provider, so a
// value means what it means in ST. Arrays of prompts, order entries and regex scripts are
// keyed by `identifier` or `id`, so the library merge combines them per element.
import { Schema } from "effect"

export const PRESET_SCHEMA_VERSION = 1

export const PromptRole = Schema.Literals(["system", "user", "assistant"])
export type PromptRole = typeof PromptRole.Type

const Json = Schema.Record(Schema.String, Schema.Unknown)
/** ST injects at depths 0 to 10000 (`MAX_INJECTION_DEPTH`). */
export const InjectionDepth = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))

const PresetPrompt = Schema.Struct({
  identifier: Schema.NonEmptyString,
  name: Schema.String,
  role: PromptRole,
  /** Ignored for markers whose content the assembler fills (`charDescription`, `chatHistory`, …). */
  content: Schema.String,
  /**
   * ST's flag for its built-in prompts. A relative prompt with `false` is sent where the order
   * puts it; one with `true` is sent only if the assembler knows its identifier (main, nsfw,
   * jailbreak, enhanceDefinitions and the markers). In-chat prompts are sent whatever the flag.
   * An imported prompt without the flag is `true`, because ST treats a missing flag the same way.
   */
  system_prompt: Schema.Boolean,
  marker: Schema.Boolean,
  /** `absolute` is ST's "in-chat": inserted into the history at `injection_depth`. */
  injection_position: Schema.Literals(["relative", "absolute"]),
  injection_depth: InjectionDepth,
  /** Among in-chat prompts at one depth, higher orders end up nearer the end of the history. */
  injection_order: Schema.Finite,
  /** Generation types the prompt is sent for (`normal`, `continue`, `impersonate`, …); empty means all. */
  injection_trigger: Schema.Array(Schema.String),
  /** A card's own main prompt or post-history instructions don't replace this one. */
  forbid_overrides: Schema.Boolean,
  /** Fields of the ST prompt this document doesn't model, kept for export. */
  unsupported: Schema.optionalKey(Json)
})
export type PresetPrompt = typeof PresetPrompt.Type

const PromptOrderEntry = Schema.Struct({
  identifier: Schema.NonEmptyString,
  enabled: Schema.Boolean
})
export type PromptOrderEntry = typeof PromptOrderEntry.Type

/** ST's names and values; mapping them to a provider's parameters happens at assembly. */
const PresetSamplers = Schema.Struct({
  temperature: Schema.Finite,
  frequency_penalty: Schema.Finite,
  presence_penalty: Schema.Finite,
  top_p: Schema.Finite,
  top_k: Schema.Finite,
  top_a: Schema.Finite,
  min_p: Schema.Finite,
  repetition_penalty: Schema.Finite,
  openai_max_context: Schema.Finite,
  openai_max_tokens: Schema.Finite,
  max_context_unlocked: Schema.Boolean,
  /** -1 means no seed. */
  seed: Schema.Finite,
  n: Schema.Finite,
  reasoning_effort: Schema.String,
  verbosity: Schema.String
})
export type PresetSamplers = typeof PresetSamplers.Type

/** ST's "utility prompts": text the assembler uses in specific situations. Names are ST's. */
const UtilityPrompts = Schema.Struct({
  impersonation_prompt: Schema.String,
  new_chat_prompt: Schema.String,
  new_group_chat_prompt: Schema.String,
  new_example_chat_prompt: Schema.String,
  continue_nudge_prompt: Schema.String,
  group_nudge_prompt: Schema.String,
  /** Sent as the user turn when the user sends nothing. */
  send_if_empty: Schema.String,
  /** `{0}` is replaced with the world info text. */
  wi_format: Schema.String,
  scenario_format: Schema.String,
  personality_format: Schema.String
})
export type UtilityPrompts = typeof UtilityPrompts.Type

/**
 * How ST adds speaker names to messages: `none`; `default` (names only in groups and for
 * example messages); `completion` (the message's `name` field); `content` (`Name: ` prefixed
 * to the text).
 */
export const NamesBehavior = Schema.Literals(["none", "default", "completion", "content"])

/** ST's prompt post-processing (`custom_prompt_post_processing`); `none` is ST's empty string. */
export const PostProcessing = Schema.Literals([
  "none",
  "merge",
  "merge_tools",
  "semi",
  "semi_tools",
  "strict",
  "strict_tools",
  "single"
])

/**
 * A regex script from the preset. Stored as data and never compiled at import; compiling
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

const uniqueBy =
  <A>(key: (a: A) => string, what: string) =>
  (items: ReadonlyArray<A>) => {
    const seen = new Set<string>()
    for (const [i, item] of items.entries()) {
      const k = key(item)
      if (seen.has(k)) return { path: [i], issue: `duplicate ${what} ${JSON.stringify(k)}` }
      seen.add(k)
    }
    return undefined
  }

export const LegacyPresetDoc = Schema.Struct({
  schema_version: Schema.Literal(PRESET_SCHEMA_VERSION),
  prompts: Schema.Array(PresetPrompt).check(
    Schema.makeFilter(uniqueBy((p: PresetPrompt) => p.identifier, "identifier"))
  ),
  /** The one prompt order (DATA-MODEL §16.3). Every entry names a prompt in `prompts`. */
  order: Schema.Array(PromptOrderEntry).check(
    Schema.makeFilter(uniqueBy((e: PromptOrderEntry) => e.identifier, "identifier"))
  ),
  samplers: PresetSamplers,
  /** Total target after a history cut; absent means 80% of the effective maximum. */
  context_target: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  utility_prompts: UtilityPrompts,
  names_behavior: NamesBehavior,
  /** ST's `squash_system_messages`: consecutive system messages are joined into one. */
  squash: Schema.Boolean,
  postprocess: PostProcessing,
  /** Send the system prompt as the provider's system parameter (Claude, Gemini). */
  use_sysprompt: Schema.Boolean,
  prefill: Schema.Struct({
    /** Starts the model's reply. */
    assistant: Schema.String,
    /** Starts the reply when the model writes as the user (impersonation). */
    impersonation: Schema.String,
    /** Continue sends the message being continued as a prefill instead of a nudge prompt. */
    continue: Schema.Boolean,
    /** Appended to the continued message: ST offers "", " ", "\n" and "\n\n". */
    continue_postfix: Schema.String
  }),
  regex: Schema.Array(RegexScript).check(Schema.makeFilter(uniqueBy((r: RegexScript) => r.id, "id"))),
  /**
   * The user allowed this preset's regex scripts to run, as ST asks once per preset. No script
   * from `regex`, prompt or display, runs until this is true. An import always sets it false,
   * whatever the file says, and export never writes it (DESIGN §11: a file never grants itself
   * capabilities).
   */
  regex_approved: Schema.Boolean,
  /** The preset's other `extensions` entries, namespaced as in ST, kept for export. */
  extensions: Json,
  /** Top-level ST fields this document doesn't model, kept for export. */
  unsupported: Json
}).check(
  Schema.makeFilter((doc) => {
    const ids = new Set(doc.prompts.map((p) => p.identifier))
    const i = doc.order.findIndex((e) => !ids.has(e.identifier))
    return i === -1 ? undefined : { path: ["order", i], issue: "names no prompt" }
  })
)
export type LegacyPresetDoc = typeof LegacyPresetDoc.Type

/** Prompt content only. Legacy revisions retain their original model settings in history. */
export const PresetDoc = LegacyPresetDoc.mapFields((fields) => {
  const { samplers, context_target, names_behavior, squash, postprocess, use_sysprompt, ...prompts } = fields
  void [samplers, context_target, names_behavior, squash, postprocess, use_sysprompt]
  return prompts
})
export type PresetDoc = typeof PresetDoc.Type

export const promptPreset = (doc: LegacyPresetDoc): PresetDoc => {
  const prompt = Schema.decodeUnknownSync(PresetDoc)(doc)
  const modelKeys = new Set([
    "stop",
    "stopping_strings",
    "logit_bias",
    "stream_openai",
    "reasoning_effort",
    "verbosity",
    "cache_control",
    "cacheRetention",
    "provider"
  ])
  return {
    ...prompt,
    unsupported: Object.fromEntries(
      Object.entries(prompt.unsupported).filter(
        ([key]) => !modelKeys.has(key) && !/^(openrouter|vertexai|azure|nanogpt)_/.test(key)
      )
    )
  }
}
