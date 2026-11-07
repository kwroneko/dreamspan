// The preset document (DATA-MODEL §3.3, DESIGN §1.2): an ST chat-completion preset,
// normalized. Field names follow ST's where the assembler maps them per provider, so a
// value means what it means in ST. Arrays of prompts, order entries and regex scripts are
// keyed by `identifier` or `id`, so the library merge combines them per element.
import { Schema } from "effect"
import { ReplySectionSettings } from "../replySections.ts"
import { RegexScript } from "./regexScript.ts"

export { RegexScript } from "./regexScript.ts"

export const PRESET_SCHEMA_VERSION = 1

export const PromptRole = Schema.Literals(["system", "user", "assistant"])
export type PromptRole = typeof PromptRole.Type

export const PromptCondition = Schema.Literals(["always", "as_character", "as_user", "with_direction"])
export type PromptCondition = typeof PromptCondition.Type

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
  /**
   * When the prompt is sent (DESIGN §2.2): always, only when the model writes as a character,
   * only when it writes as `{{user}}`, or only when the generation has a direction. Absent:
   * always. The end-of-request texts (`endOfRequest.ts`) have none.
   */
  condition: Schema.optionalKey(PromptCondition),
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
  personality_format: Schema.String,
  /**
   * What wraps each character's part of a per-field marker (ST's group join prefix and suffix):
   * `{{char}}` is that character and `<FIELDNAME>` the field. Absent means the defaults
   * (`CARD_JOIN_PREFIX`, `CARD_JOIN_SUFFIX`).
   */
  card_join_prefix: Schema.optionalKey(Schema.String),
  card_join_suffix: Schema.optionalKey(Schema.String),
  /**
   * A merged chat's framing line and its join marker (spec/CHAT-MERGE.md §4): `{{title}}` and
   * `{{cast}}` are the merge's. Absent means the defaults (`MERGE_SECTION_DEFAULT`, `MERGE_JOIN_DEFAULT`).
   */
  merge_section_prompt: Schema.optionalKey(Schema.String),
  merge_join_prompt: Schema.optionalKey(Schema.String)
})
export type UtilityPrompts = typeof UtilityPrompts.Type

export const CARD_JOIN_PREFIX = "<{{char}}>\n"
export const CARD_JOIN_SUFFIX = "\n</{{char}}>"

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

/** Every order entry names a prompt in `prompts`: the library merge matches them by identity. */
const ordersNamePrompts = () =>
  Schema.makeFilter(
    (doc: {
      readonly prompts: ReadonlyArray<{ readonly identifier: string }>
      readonly order: ReadonlyArray<{ readonly identifier: string }>
    }) => {
      const ids = new Set(doc.prompts.map((p) => p.identifier))
      const i = doc.order.findIndex((e) => !ids.has(e.identifier))
      return i === -1 ? undefined : { path: ["order", i], issue: "names no prompt" }
    }
  )

/**
 * A lorebook sent with the preset, by its library ref id, with its own switch. The
 * assembler reads it like a chat's attached lorebook, as the preset owner's (ARCHITECTURE §15).
 */
export const PresetLorebook = Schema.Struct({ id: Schema.String, enabled: Schema.Boolean })
export type PresetLorebook = typeof PresetLorebook.Type

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
  /** ST power-user prompt switches; absent is false for existing revisions. */
  pin_examples: Schema.optionalKey(Schema.Boolean),
  strip_examples: Schema.optionalKey(Schema.Boolean),
  collapse_newlines: Schema.optionalKey(Schema.Boolean),
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
  /**
   * Tagged sections at the start of a reply (spec/REPLY-SECTIONS.md): which tags, on or off,
   * and how many recent replies send theirs back. Absent: `DEFAULT_REPLY_SECTIONS`.
   */
  reply_sections: Schema.optionalKey(ReplySectionSettings),
  regex: Schema.Array(RegexScript).check(Schema.makeFilter(uniqueBy((r: RegexScript) => r.id, "id"))),
  /** Lorebooks sent with the preset, in order; absent is none. ST has no such field. */
  lorebooks: Schema.optionalKey(
    Schema.Array(PresetLorebook).check(Schema.makeFilter(uniqueBy((l: PresetLorebook) => l.id, "id")))
  ),
  /**
   * The user allowed this preset's regex scripts to run, as ST asks once per preset. No script
   * from `regex`, prompt or display, runs until this is true. An import always sets it false,
   * whatever the file says, and export never writes it (DESIGN §11: a file never grants itself
   * capabilities).
   */
  regex_approved: Schema.Boolean,
  /**
   * The user allowed scripts in panels this preset's scripts make to run (spec/HTML-MESSAGES.md
   * §3.4), and to use the internet. Absent: off. Set as `regex_approved`: never by a file.
   */
  html_scripts_approved: Schema.optionalKey(Schema.Boolean),
  html_network_approved: Schema.optionalKey(Schema.Boolean),
  /** The preset's other `extensions` entries, namespaced as in ST, kept for export. */
  extensions: Json,
  /** Top-level ST fields this document doesn't model, kept for export. */
  unsupported: Json
}).check(ordersNamePrompts())
export type LegacyPresetDoc = typeof LegacyPresetDoc.Type

/** Prompt content only. Legacy revisions retain their original model settings in history. */
export const PresetDoc = LegacyPresetDoc.mapFields((fields) => {
  const { samplers, context_target, names_behavior, squash, postprocess, use_sysprompt, ...prompts } = fields
  void [samplers, context_target, names_behavior, squash, postprocess, use_sysprompt]
  return prompts
}).check(ordersNamePrompts())
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
