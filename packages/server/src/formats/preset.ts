// SillyTavern chat-completion presets (DESIGN §1.2): import into the preset document and
// export back. The rules follow ST's own loading (public/scripts/openai.js and
// PromptManager.js): its migrations, its defaults for missing fields, and its sanitizing of
// prompts and the prompt order. Nothing here runs anything from the file.
import {
  InjectionDepth,
  NamesBehavior,
  PostProcessing,
  PRESET_SCHEMA_VERSION,
  PromptCondition,
  PromptRole,
  RegexScript,
  type LegacyPresetDoc as PresetDoc,
  type PresetPrompt,
  type PresetSamplers,
  type PromptOrderEntry,
  type UtilityPrompts
} from "@dreamspan/shared/docs/preset.ts"
import { type ImportReport, ReportBuilder, shownList, shownText } from "@dreamspan/shared/importReport.ts"
import { Schema } from "effect"
import { newestMessage, ownTurnNotes, presetOrder, sentOutsideTheOrder } from "@dreamspan/shared/presetOrder.ts"
import {
  conditionOf,
  fromSpeaker,
  gatesNeverMeet,
  triggersWithCondition,
  withEndOfRequest
} from "@dreamspan/shared/presetConditions.ts"
import { CONTINUE_NUDGE, endOfRequestText, GROUP_NUDGE, IMPERSONATION_PROMPT } from "@dreamspan/shared/endOfRequest.ts"
import { defaultLimits, FormatError, parseJson } from "./safety.ts"

const ST_PRESET_FORMAT = "st-chat-completion-preset"

export interface PresetImport {
  /** Null when the file isn't a chat-completion preset or can't be read. */
  readonly document: PresetDoc | null
  readonly report: ImportReport
}

type Json = Record<string, unknown>
type Path = ReadonlyArray<string | number>

// ST's defaults (openai.js `default_settings`), applied to fields a preset lacks. ST itself
// keeps the previously loaded preset's value for those; a fresh ST has these.
const DEFAULT_SAMPLERS: PresetSamplers = {
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  top_p: 1,
  top_k: 0,
  top_a: 0,
  min_p: 0,
  repetition_penalty: 1,
  openai_max_context: 4095,
  openai_max_tokens: 300,
  max_context_unlocked: false,
  seed: -1,
  n: 1,
  reasoning_effort: "auto",
  verbosity: "auto"
}

const DEFAULT_UTILITY_PROMPTS: UtilityPrompts = {
  impersonation_prompt:
    "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
  new_chat_prompt: "[Start a new Chat]",
  new_group_chat_prompt: "[Start a new group chat. Group members: {{group}}]",
  new_example_chat_prompt: "[Example Chat]",
  continue_nudge_prompt: "[Continue your last message without repeating its original content.]",
  group_nudge_prompt: "[Write the next reply only as {{char}}.]",
  send_if_empty: "",
  wi_format: "{0}",
  scenario_format: "{{scenario}}",
  personality_format: "{{personality}}"
}

/** ST's built-in prompts (PromptManager.js `chatCompletionDefaultPrompts`), in its format. */
const ST_DEFAULT_PROMPTS: ReadonlyArray<Json> = [
  {
    identifier: "main",
    name: "Main Prompt",
    system_prompt: true,
    role: "system",
    content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}."
  },
  { identifier: "nsfw", name: "Auxiliary Prompt", system_prompt: true, role: "system", content: "" },
  { identifier: "dialogueExamples", name: "Chat Examples", system_prompt: true, marker: true },
  { identifier: "jailbreak", name: "Post-History Instructions", system_prompt: true, role: "system", content: "" },
  { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
  { identifier: "worldInfoAfter", name: "World Info (after)", system_prompt: true, marker: true },
  { identifier: "worldInfoBefore", name: "World Info (before)", system_prompt: true, marker: true },
  {
    identifier: "enhanceDefinitions",
    name: "Enhance Definitions",
    system_prompt: true,
    role: "system",
    content:
      "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    marker: false
  },
  { identifier: "charDescription", name: "Char Description", system_prompt: true, marker: true },
  { identifier: "charPersonality", name: "Char Personality", system_prompt: true, marker: true },
  { identifier: "scenario", name: "Scenario", system_prompt: true, marker: true },
  { identifier: "personaDescription", name: "Persona Description", system_prompt: true, marker: true }
]

/** The prompts a card's system prompt and post-history instructions replace (DESIGN §5.0). */
const OVERRIDABLE = new Set(["main", "jailbreak"])

/**
 * A preset made here: ST's, but with card prompt overrides forbidden on the prompts they could
 * replace, as DESIGN §5.0 has it for a new preset.
 */
export const forbidCardOverrides = (doc: PresetDoc): PresetDoc => ({
  ...doc,
  prompts: doc.prompts.map((p) => (OVERRIDABLE.has(p.identifier) ? { ...p, forbid_overrides: true } : p))
})

/** ST's default prompt order (`promptManagerDefaultPromptOrder`). */
const DEFAULT_ORDER_ENTRIES: ReadonlyArray<PromptOrderEntry> = [
  "main",
  "worldInfoBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "enhanceDefinitions",
  "nsfw",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
  "jailbreak"
].map((identifier) => ({ identifier, enabled: identifier !== "enhanceDefinitions" }))

/** Markers ST sends as `system` when the preset gives them no role (openai.js `systemPrompts`). */
const SYSTEM_ROLE_MARKERS = new Set([
  "worldInfoBefore",
  "worldInfoAfter",
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription"
])

/** The only prompt order ST's prompt manager uses: its "global" strategy's dummy character. */
const GLOBAL_ORDER_ID = 100001

const DEFAULT_DEPTH = 4
const DEFAULT_INJECTION_ORDER = 100
const isRole = (v: unknown): v is PromptRole => (PromptRole.literals as ReadonlyArray<unknown>).includes(v)
const validDepth = Schema.is(InjectionDepth)
const SUBSTITUTE_REGEX = RegexScript.fields.substitute_regex.literals
// ST numbers names_behavior from -1, in the order of the document's literals.
const namesBehavior = (n: number) => NamesBehavior.literals[n + 1]

/** ST preset fields the document doesn't model, with ST's defaults: kept, and reported when set. */
const UNMODELED_DEFAULTS: Json = {
  bias_preset_selected: "Default (none)",
  media_inlining: true,
  inline_image_quality: "auto",
  function_calling: false,
  tool_call_recurse_limit: 5,
  show_thoughts: true,
  enable_web_search: false,
  request_images: false,
  request_image_aspect_ratio: "",
  request_image_resolution: "",
  tool_reasoning_mode: "disabled"
}
/** Kept silently: a client preference with no effect on what's sent. */
const UI_ONLY = new Set(["stream_openai"])

// Connection and model fields: ST's `isConnection` settings, plus older per-source sort and
// group flags. Ignored by design (DESIGN §1.2); some hold proxy credentials.
const CONNECTION_FIELDS = new Set([
  "chat_completion_source",
  "group_models",
  "sort_models",
  "reverse_proxy",
  "proxy_password",
  "show_external_models",
  "bypass_status_check",
  "custom_url",
  "custom_include_body",
  "custom_exclude_body",
  "custom_include_headers",
  "workers_ai_account_id"
])
const isConnectionField = (key: string) =>
  CONNECTION_FIELDS.has(key) ||
  /(?:api[_-]?key|password|secret|credential)/i.test(key) ||
  /(_model|_models|_endpoint)$/.test(key) ||
  /^(openrouter|vertexai|azure|nanogpt)_/.test(key)

// ST's `migrateChatCompletionSettings`, the entries for fields that aren't connection data, in
// ST's order. As in ST, the old key is deleted whether or not its value matched.
const MIGRATIONS: ReadonlyArray<readonly [string, unknown, string, unknown]> = [
  ["names_in_completion", true, "names_behavior", 1],
  ["custom_prompt_post_processing", "claude", "custom_prompt_post_processing", "merge"],
  ["image_inlining", false, "media_inlining", false],
  ["image_inlining", true, "media_inlining", true],
  ["video_inlining", true, "media_inlining", true],
  ["audio_inlining", true, "media_inlining", true],
  ["claude_use_sysprompt", true, "use_sysprompt", true],
  ["use_makersuite_sysprompt", true, "use_sysprompt", true]
]

const PROMPT_FIELDS = new Set([
  "identifier",
  "name",
  "role",
  "content",
  "system_prompt",
  "marker",
  "injection_position",
  "injection_depth",
  "injection_order",
  "injection_trigger",
  "forbid_overrides",
  // Ours, written by export so a reimport keeps what ST has no field for.
  "condition",
  "sent_with_direction",
  "enabled_here"
])
/** Prompt fields ST has but the document doesn't model; kept without a report. */
const ST_PROMPT_EXTRAS = new Set(["enabled", "position", "extension"])
const REGEX_FIELDS = new Set([
  "id",
  "scriptName",
  "findRegex",
  "replaceString",
  "trimStrings",
  "placement",
  "disabled",
  "markdownOnly",
  "promptOnly",
  "runOnEdit",
  "substituteRegex",
  "minDepth",
  "maxDepth"
])

/** Fields only a chat-completion preset has, current or old. */
const CHAT_COMPLETION_FIELDS = [
  "prompts",
  "prompt_order",
  "chat_completion_source",
  "openai_max_context",
  "openai_max_tokens",
  "frequency_penalty",
  "assistant_prefill",
  "squash_system_messages",
  "impersonation_prompt",
  "wi_format",
  "main_prompt",
  "jailbreak_prompt"
]

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * The value if it's a primitive, else the fallback. Converting an object with `String()` or
 * `Number()` throws when its `toString` and `valueOf` keys aren't functions.
 */
const primitiveOr = (v: unknown, fallback: unknown): unknown => (typeof v === "object" && v !== null ? fallback : v)

// ST's bundled default chat-completion preset is 8 KB and its largest bundled JSON file 27 KB,
// so 2 MB leaves room for presets with long prompts and many regex scripts while keeping an
// import under a second of CPU. The other JSON limits are the shared ones (safety.ts).
export const MAX_PRESET_BYTES = 2 * 1024 * 1024
const done = (r: ReportBuilder, format: string, document: PresetDoc | null): PresetImport => ({
  document,
  report: r.build(format)
})

/** Picks ids nothing in the file uses: `base`, else `base-2`, `base-3`, …; linear over many repeats. */
class FreshIds {
  private readonly used: Set<string>
  private readonly next = new Map<string, number>()
  constructor(fileIds: Iterable<string>) {
    this.used = new Set(fileIds)
  }
  take(base: string): string {
    let id = base
    if (this.used.has(base)) {
      let n = this.next.get(base) ?? 2
      while (this.used.has(`${base}-${n}`)) n++
      this.next.set(base, n + 1)
      id = `${base}-${n}`
    }
    this.used.add(id)
    return id
  }
}

const stringIds = (list: ReadonlyArray<unknown>, key: string) =>
  list.flatMap((x) => (isObject(x) && typeof x[key] === "string" ? [x[key]] : []))

/** The other kinds of ST JSON file, by ST's own tests where it has them (preset-manager.js). */
const OTHER_KINDS: ReadonlyArray<readonly [keys: ReadonlyArray<string>, format: string, label: string]> = [
  [["name", "input_sequence", "output_sequence"], "st-instruct-template", "an instruct template"],
  [["name", "story_string"], "st-context-template", "a context template"],
  [["name", "content"], "st-system-prompt", "a system prompt template"],
  [["temp", "top_k", "top_p", "rep_pen"], "st-text-completion-preset", "a text-completion preset"],
  [["name", "prefix", "suffix", "separator"], "st-reasoning-template", "a reasoning template"],
  [["max_length", "min_length"], "st-novelai-preset", "a NovelAI preset"]
]
/** An Advanced Formatting export has one of these as an object. */
const MASTER_EXPORT_KEYS = ["instruct", "context", "sysprompt", "preset", "reasoning"]

const otherKind = (o: Json): readonly [format: string, label: string] | undefined => {
  const kind = OTHER_KINDS.find(([keys]) => keys.every((k) => Object.hasOwn(o, k)))
  if (kind) return [kind[1], kind[2]]
  if (MASTER_EXPORT_KEYS.some((k) => isObject(o[k]))) return ["st-master-export", "an Advanced Formatting export"]
  return undefined
}

/**
 * Whether a JSON file with these top-level keys is one `importStPreset` should read: a
 * chat-completion preset, or another ST preset or template it reports as unsupported.
 */
export const isStPresetFile = (keys: ReadonlySet<string>) =>
  CHAT_COMPLETION_FIELDS.some((k) => keys.has(k)) ||
  OTHER_KINDS.some(([kindKeys]) => kindKeys.every((k) => keys.has(k))) ||
  MASTER_EXPORT_KEYS.some((k) => keys.has(k))

/**
 * An ST chat-completion preset file to the document. Never throws on a file's content: every
 * problem goes in the report, and a file that can't be imported has no document.
 */
export const importStPreset = (input: string | Uint8Array): PresetImport => {
  const r = new ReportBuilder()
  let parsed: unknown
  try {
    // A leading byte-order mark is dropped when the bytes are decoded.
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
    parsed = parseJson(bytes, MAX_PRESET_BYTES, defaultLimits, r)
  } catch (error) {
    if (!(error instanceof FormatError)) throw error
    r.add("error", error.code, error.message)
    return done(r, "unknown", null)
  }
  if (!isObject(parsed)) {
    r.add("error", "preset.unrecognized", "The file isn't a SillyTavern chat-completion preset.")
    return done(r, "unknown", null)
  }
  if (!CHAT_COMPLETION_FIELDS.some((k) => Object.hasOwn(parsed, k))) {
    const other = otherKind(parsed)
    if (!other) {
      r.add("error", "preset.unrecognized", "The file isn't a SillyTavern chat-completion preset.")
      return done(r, "unknown", null)
    }
    r.add(
      "warning",
      "preset.unsupported_format",
      `This is ${other[1]}. Only chat-completion presets are supported, so it wasn't imported.`
    )
    return done(r, other[0], null)
  }
  return done(r, ST_PRESET_FORMAT, readPreset(parsed, r))
}

const readPreset = (file: Json, r: ReportBuilder): PresetDoc => {
  const src = migrate(file)
  const consumed = new Set<string>()
  const missing: Array<string> = []

  const field = (key: string): unknown => {
    consumed.add(key)
    if (src[key] === undefined) missing.push(key)
    return src[key]
  }
  // ST sends numbers through Number(), applies checkboxes by truthiness, and text as strings.
  const num = (key: string, fallback: number) => {
    const value = field(key)
    if (value === undefined) return fallback
    const n = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN
    if (Number.isFinite(n)) return n
    r.add("warning", "preset.invalid_value", `\`${key}\` isn't a number, so ST's default is used.`, [key])
    return fallback
  }
  const bool = (key: string, fallback: boolean) => {
    const value = field(key)
    return value === undefined ? fallback : Boolean(value)
  }
  const str = (key: string, fallback: string) => {
    const value = field(key)
    if (value === undefined || value === null) return fallback
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    r.add("warning", "preset.invalid_value", `\`${key}\` isn't text, so ST's default is used.`, [key])
    return fallback
  }
  const mapDefaults = <T extends object>(defaults: T): T =>
    Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [
        key,
        typeof fallback === "number"
          ? num(key, fallback)
          : typeof fallback === "boolean"
            ? bool(key, fallback)
            : str(key, fallback)
      ])
    ) as T

  const samplers = mapDefaults(DEFAULT_SAMPLERS)
  const utility_prompts: UtilityPrompts = {
    ...mapDefaults(DEFAULT_UTILITY_PROMPTS),
    ...Object.fromEntries(
      ["merge_section_prompt", "merge_join_prompt", "absent_gap_prompt", "absent_join_prompt"]
        .filter((key) => src[key] !== undefined)
        .map((key) => [key, str(key, "")])
    )
  }

  let names_behavior = namesBehavior(num("names_behavior", 0))
  if (names_behavior === undefined) {
    r.add("warning", "preset.invalid_value", "`names_behavior` has an unknown value, so ST's default is used.", [
      "names_behavior"
    ])
    names_behavior = "default"
  }
  const postValue = str("custom_prompt_post_processing", "") || "none"
  let postprocess = PostProcessing.literals.find((p) => p === postValue)
  if (postprocess === undefined) {
    r.add(
      "warning",
      "preset.invalid_value",
      "`custom_prompt_post_processing` has an unknown value, so no post-processing is used.",
      ["custom_prompt_post_processing"]
    )
    postprocess = "none"
  }

  const { prompts, neverSent, exportedOff } = readPrompts(field("prompts"), r)
  const importedOrder = readOrder(field("prompt_order"), prompts, neverSent, r).map((e) =>
    exportedOff.has(e.identifier) ? { ...e, enabled: true } : e
  )
  const included = new Set(importedOrder.map((e) => e.identifier))
  const outside = prompts.filter((p) => !included.has(p.identifier) && p.identifier !== "newestMessage")
  const on = outside.filter((p) => sentOutsideTheOrder.includes(p.identifier))
  const off = outside.filter((p) => !sentOutsideTheOrder.includes(p.identifier))
  if (on.length)
    r.add(
      "info",
      "preset.markers_appended_on",
      `Markers outside the ST order were appended, on, since ST still sends them after the other prompts: ${shownList(on.map((p) => p.name || p.identifier))}.`,
      ["prompt_order"]
    )
  if (off.length)
    r.add(
      "info",
      "preset.prompts_appended_off",
      `Prompts outside the ST order were appended, off: ${shownList(off.map((p) => p.name || p.identifier))}.`,
      ["prompt_order"]
    )
  if (!prompts.some((p) => p.identifier === newestMessage.identifier)) prompts.push(newestMessage)
  // The file's `forbid_overrides` is kept, as ST reads it; say which prompts a card can replace.
  const replaceable = prompts.filter((p) => OVERRIDABLE.has(p.identifier) && !p.forbid_overrides)
  if (replaceable.length)
    r.add(
      "info",
      "preset.overrides_allowed",
      `A card's own prompts can replace ${shownList(replaceable.map((p) => p.name || p.identifier))}, as the file allows.`,
      ["prompts"]
    )
  const order = presetOrder(prompts, importedOrder)
  if (!prompts.some((p) => p.identifier === ownTurnNotes.identifier)) {
    prompts.push(ownTurnNotes)
    const history = order.findIndex((e) => e.identifier === "chatHistory")
    const tail = history < 0 ? order.length : history + (order[history + 1]?.identifier === "newestMessage" ? 2 : 1)
    order.splice(tail, 0, { identifier: ownTurnNotes.identifier, enabled: true })
  }
  const extensions: Json = isObject(src.extensions) ? { ...src.extensions } : {}
  consumed.add("extensions")
  const regex = readRegex(extensions.regex_scripts, r)
  delete extensions.regex_scripts
  for (const key of Object.keys(extensions))
    r.add("info", "preset.extension_kept", `Extension data \`${shownText(key)}\` is kept for export but not used.`, [
      "extensions",
      key
    ])

  const unsupported: Json = {}
  const doc: PresetDoc = {
    schema_version: PRESET_SCHEMA_VERSION,
    prompts,
    order,
    samplers,
    utility_prompts,
    ...Object.fromEntries(
      ["pin_examples", "strip_examples", "collapse_newlines"]
        .filter((key) => src[key] !== undefined)
        .map((key) => [key, bool(key, false)])
    ),
    names_behavior,
    squash: bool("squash_system_messages", false),
    postprocess,
    use_sysprompt: bool("use_sysprompt", false),
    prefill: {
      assistant: str("assistant_prefill", ""),
      impersonation: str("assistant_impersonation", ""),
      continue: bool("continue_prefill", false),
      continue_postfix: str("continue_postfix", " ")
    },
    regex,
    // A file never grants itself permission to run its scripts (DESIGN §11).
    regex_approved: false,
    extensions,
    unsupported
  }

  const ignored: Array<string> = []
  for (const key of Object.keys(src)) {
    if (consumed.has(key)) continue
    if (isConnectionField(key)) {
      ignored.push(key)
      continue
    }
    if (key === "regex_approved" || key === "html_scripts_approved" || key === "html_network_approved") {
      // Not kept, so no export can carry a file's claim of approval anywhere.
      r.add("warning", "preset.approval_ignored", `The file's \`${key}\` was dropped. Only you can allow scripts.`, [
        key
      ])
      continue
    }
    unsupported[key] = src[key]
    if (UI_ONLY.has(key)) continue
    if (!Object.hasOwn(UNMODELED_DEFAULTS, key))
      r.add("info", "preset.unknown_field", `\`${shownText(key)}\` isn't a known preset field. It's kept for export.`, [
        key
      ])
    else if (src[key] !== UNMODELED_DEFAULTS[key])
      r.add(
        "warning",
        "preset.unsupported_field",
        `This preset sets \`${key}\`, which isn't supported yet. It's kept for export.`,
        [key]
      )
  }
  if (ignored.length > 0)
    r.add(
      "info",
      "preset.connection_ignored",
      `Connection and model settings are ignored and not stored: ${shownList(ignored)}.`
    )
  if (missing.length > 0)
    r.add("info", "preset.defaults_applied", `The preset doesn't set ${missing.join(", ")}, so ST's defaults are used.`)
  return conditioned(doc, r)
}

/** ST's migrations of older presets, on a copy. */
const migrate = (file: Json): Json => {
  const src = { ...file }
  for (const [oldKey, oldValue, newKey, newValue] of MIGRATIONS) {
    if (!Object.hasOwn(src, oldKey)) continue
    if (src[oldKey] === oldValue) src[newKey] = newValue
    if (oldKey !== newKey) delete src[oldKey]
  }
  // PromptManager's migration of presets from before the prompt manager.
  const legacy = ["main", "nsfw", "jailbreak"].filter((id) => src[`${id}_prompt`])
  if (legacy.length === 0) return src
  const prompts = Array.isArray(src.prompts) && src.prompts.length > 0 ? src.prompts : ST_DEFAULT_PROMPTS
  src.prompts = prompts.map((p: unknown) =>
    isObject(p) && typeof p.identifier === "string" && legacy.includes(p.identifier)
      ? { ...p, content: src[`${p.identifier}_prompt`] }
      : p
  )
  for (const id of legacy) delete src[`${id}_prompt`]
  return src
}

/** A text field, reported when the file has something other than text there. */
const text = (o: Json, key: string, path: Path, what: string, r: ReportBuilder) => {
  const v = o[key]
  if (typeof v === "string") return v
  if (v !== undefined && v !== null)
    r.add("warning", "preset.invalid_value", `${what} has a \`${key}\` that isn't text, so it's empty.`, [...path, key])
  return ""
}

const readPrompts = (raw: unknown, r: ReportBuilder) => {
  if (raw !== undefined && !Array.isArray(raw))
    r.add("warning", "preset.invalid_value", "`prompts` isn't a list, so ST's built-in prompts are used.", ["prompts"])
  const list = Array.isArray(raw) ? raw : []
  const ids = new FreshIds(stringIds(list, "identifier"))
  const prompts = new Map<string, PresetPrompt>()
  // Prompts ST never sends, with the reason.
  const neverSent = new Map<string, string>()
  // Prompts our export turned off for ST: direction prompts, which ST sends every turn, and
  // prompts whose condition and generation types never meet, which ST would send.
  const exportedOff = new Set<string>()
  for (const [i, p] of list.entries()) {
    const path = ["prompts", i]
    if (!isObject(p)) {
      r.add("warning", "preset.prompt_invalid", "A prompt isn't an object and was dropped.", path)
      continue
    }
    const prompt = readPrompt(p, path, ids, r)
    if (prompts.has(prompt.identifier)) {
      r.add(
        "warning",
        "preset.prompt_duplicate",
        `A second prompt \`${shownText(prompt.identifier)}\` was dropped. ST only ever uses the first.`,
        path
      )
      continue
    }
    prompts.set(prompt.identifier, prompt)
    if (prompt.condition === "with_direction" && p.sent_with_direction === true) exportedOff.add(prompt.identifier)
    if (p.enabled_here === true && gatesNeverMeet(prompt)) exportedOff.add(prompt.identifier)
    const reason = whyNeverSent(p, prompt)
    if (reason !== undefined) neverSent.set(prompt.identifier, reason)
  }
  // ST's sanitizing adds any built-in prompt that's missing.
  for (const builtIn of ST_DEFAULT_PROMPTS)
    if (!prompts.has(builtIn.identifier as string))
      prompts.set(builtIn.identifier as string, readPrompt(builtIn, [], ids, r))
  return { prompts: [...prompts.values()], neverSent, exportedOff }
}

const whyNeverSent = (p: Json, prompt: PresetPrompt): string | undefined => {
  // ST sends a prompt only for the generation types listed; an empty list means all.
  if (Array.isArray(p.injection_trigger) && p.injection_trigger.length > 0 && prompt.injection_trigger.length === 0)
    return "none of its generation types is valid"
  if (prompt.injection_position !== "absolute") return undefined
  if (!validDepth(p.injection_depth)) return "its in-chat depth isn't an integer from 0 to 10000"
  if (isRole(p.role) || ((p.role === undefined || p.role === null) && SYSTEM_ROLE_MARKERS.has(prompt.identifier)))
    return undefined
  return "it has no valid role"
}

const readPrompt = (p: Json, path: Path, ids: FreshIds, r: ReportBuilder): PresetPrompt => {
  let identifier = typeof p.identifier === "string" && p.identifier !== "" ? p.identifier : undefined
  if (identifier === undefined) {
    // ST gives it a random id, which no order entry names, so it's never sent.
    identifier = ids.take(`imported-${path[1]}`)
    r.add("info", "preset.prompt_identifier", `A prompt without an identifier was named \`${identifier}\`.`, path)
  }
  const what = `Prompt \`${shownText(identifier)}\``
  let role: PromptRole = "system"
  if (isRole(p.role)) role = p.role
  else if (p.role)
    r.add("warning", "preset.invalid_value", `${what} has an unknown role, so \`system\` is used.`, [...path, "role"])
  const order =
    typeof p.injection_order === "number" || typeof p.injection_order === "string" ? Number(p.injection_order) : NaN
  const unsupported: Json = {}
  for (const key of Object.keys(p)) {
    if (PROMPT_FIELDS.has(key)) continue
    unsupported[key] = p[key]
    if (!ST_PROMPT_EXTRAS.has(key))
      r.add("info", "preset.unknown_field", `Prompt field \`${shownText(key)}\` isn't known. It's kept for export.`, [
        ...path,
        key
      ])
  }
  return {
    identifier,
    name: text(p, "name", path, what, r),
    role,
    content: text(p, "content", path, what, r),
    // ST sends a relative prompt from the order only when this is exactly `false`.
    system_prompt: p.system_prompt !== false,
    marker: Boolean(p.marker),
    injection_position: p.injection_position === 1 ? "absolute" : "relative",
    injection_depth: validDepth(p.injection_depth) ? p.injection_depth : DEFAULT_DEPTH,
    injection_order: Number.isFinite(order) ? order : DEFAULT_INJECTION_ORDER,
    injection_trigger: Array.isArray(p.injection_trigger)
      ? p.injection_trigger.filter((t): t is string => typeof t === "string")
      : [],
    // ST honours the flag only when it's exactly `true`.
    forbid_overrides: p.forbid_overrides === true,
    ...(PromptCondition.literals.some((c) => c === p.condition) ? { condition: p.condition as PromptCondition } : {}),
    ...(Object.keys(unsupported).length > 0 ? { unsupported } : {})
  }
}

/**
 * ST's group nudge and impersonation prompt as end-of-request texts (DESIGN §2.2), each
 * reported; an empty one keeps our default. ST's triggers of the other prompts stay as they are.
 */
const conditioned = (doc: PresetDoc, r: ReportBuilder): PresetDoc => {
  const { doc: converted, changes } = withEndOfRequest(doc)
  for (const change of changes)
    r.add(
      "info",
      `preset.${change.kind}_prompt`,
      change.kind === "group_nudge"
        ? "The group nudge is now the end-of-request text “When a character speaks”, sent last whenever the model writes as a character, with {{char}} as {{speaker}}."
        : "The impersonation prompt is now the end-of-request text “When your card speaks”, sent last when the model writes as a card you play, with {{user}} as {{speaker}}.",
      ["prompts"]
    )
  return converted
}

const readOrder = (
  raw: unknown,
  prompts: ReadonlyArray<PresetPrompt>,
  neverSent: ReadonlyMap<string, string>,
  r: ReportBuilder
): Array<PromptOrderEntry> => {
  let entries: ReadonlyArray<unknown> = DEFAULT_ORDER_ENTRIES
  let basePath: Path = []
  if (raw !== undefined) {
    const lists = Array.isArray(raw) ? raw : []
    // ST compares ids as strings.
    const id = (l: unknown) => {
      const v = isObject(l) ? primitiveOr(l.character_id, undefined) : undefined
      return v === undefined || v === null ? "?" : String(v)
    }
    const index = lists.findIndex((l) => isObject(l) && id(l) === String(GLOBAL_ORDER_ID))
    const others = lists.filter((l, i) => i !== index && isObject(l)).map(id)
    if (others.length > 0)
      r.add(
        "info",
        "preset.prompt_orders_dropped",
        `ST uses only the global prompt order (${GLOBAL_ORDER_ID}). Other orders were dropped: ${shownList(others)}.`,
        ["prompt_order"]
      )
    const global = lists[index] as Json | undefined
    if (global && Array.isArray(global.order)) {
      entries = global.order
      basePath = ["prompt_order", index, "order"]
    } else if (global)
      r.add(
        "warning",
        "preset.no_global_order",
        "The global prompt order has no list of prompts, so ST would send none of the preset's prompts. ST's default order is used instead.",
        ["prompt_order", index]
      )
    else
      r.add(
        "warning",
        "preset.no_global_order",
        "The preset has no global prompt order, so ST's default order is used, as in ST.",
        ["prompt_order"]
      )
  }
  const known = new Set(prompts.map((p) => p.identifier))
  const inChatIds = new Set(prompts.filter((p) => p.injection_position === "absolute").map((p) => p.identifier))
  const order = new Map<string, PromptOrderEntry>()
  const enabledEntries = new Map<string, number>()
  for (const [i, e] of entries.entries()) {
    const path = [...basePath, i]
    const identifier = isObject(e) && typeof e.identifier === "string" ? e.identifier : undefined
    if (identifier === undefined || !known.has(identifier)) {
      // ST drops order entries that name no prompt.
      r.add("info", "preset.order_entry_dropped", "A prompt order entry names no prompt and was dropped.", path)
      continue
    }
    // ST injects an in-chat prompt once per enabled entry. A relative prompt is sent at most
    // once, and only if its first entry is enabled.
    const inChat = inChatIds.has(identifier)
    const enabled = Boolean((e as Json).enabled)
    if (enabled && inChat) enabledEntries.set(identifier, (enabledEntries.get(identifier) ?? 0) + 1)
    if (!order.has(identifier)) order.set(identifier, { identifier, enabled })
    else {
      r.add(
        "warning",
        "preset.order_duplicate",
        `\`${shownText(identifier)}\` appears more than once in the prompt order. It's kept once, ${inChat ? "enabled if any entry is" : "as its first entry, as ST reads it"}.`,
        path
      )
      if (enabled && inChat) order.set(identifier, { identifier, enabled })
    }
  }
  for (const [identifier, count] of enabledEntries)
    if (count > 1)
      r.add(
        "warning",
        "preset.order_repeated",
        `ST sends \`${shownText(identifier)}\` once per enabled entry, ${count} times. Here it's sent once.`,
        basePath
      )
  for (const entry of order.values()) {
    const reason = neverSent.get(entry.identifier)
    if (entry.enabled && reason !== undefined) {
      r.add(
        "warning",
        "preset.prompt_never_sent",
        `ST never sends prompt \`${shownText(entry.identifier)}\`: ${reason}. It's imported disabled.`,
        basePath
      )
      order.set(entry.identifier, { ...entry, enabled: false })
    }
  }
  return [...order.values()]
}

/**
 * A regex depth bound as ST applies it: a minimum from -1 and a maximum from 0, anything lower
 * being no bound. An infinite maximum is no bound; an infinite minimum excludes every depth,
 * kept as the largest finite number.
 */
const regexDepth = (s: Json, key: "minDepth" | "maxDepth", path: Path, r: ReportBuilder): number | null => {
  const v = s[key]
  if (v === null || v === undefined) return null
  const n = Number(primitiveOr(v, NaN))
  if (Number.isNaN(n) || n < (key === "minDepth" ? -1 : 0)) return null
  if (n !== Infinity) return n
  r.add(
    "info",
    "preset.regex_infinite_depth",
    key === "minDepth"
      ? "`minDepth` is infinite, so ST never applies this script at a message depth. It's kept as the largest number."
      : "`maxDepth` is infinite, which ST treats as no limit.",
    [...path, key]
  )
  return key === "minDepth" ? Number.MAX_VALUE : null
}

/** ST's `regex_scripts` as data (a preset's or, with its own path, a card's); nothing is compiled. */
export const readRegex = (
  raw: unknown,
  r: ReportBuilder,
  base: ReadonlyArray<string | number> = ["extensions", "regex_scripts"],
  owner: "preset" | "card" | "global" = "preset"
): Array<RegexScript> => {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    r.add("warning", "preset.invalid_value", "`regex_scripts` isn't a list, so it was dropped.", base)
    return []
  }
  const ids = new FreshIds(stringIds(raw, "id"))
  const scripts = new Map<string, RegexScript>()
  for (const [i, s] of raw.entries()) {
    const path = [...base, i]
    if (!isObject(s)) {
      r.add("warning", "preset.regex_invalid", "A regex script isn't an object and was dropped.", path)
      continue
    }
    let id = typeof s.id === "string" && s.id !== "" ? s.id : ids.take(`imported-regex-${i}`)
    if (scripts.has(id)) {
      const renamed = ids.take(id)
      r.add(
        "info",
        "preset.regex_id",
        `A second regex script \`${shownText(id)}\` was renamed \`${shownText(renamed)}\`.`,
        path
      )
      id = renamed
    }
    const what = `Regex script \`${shownText(id)}\``
    const unsupported: Json = {}
    for (const key of Object.keys(s)) {
      if (REGEX_FIELDS.has(key)) continue
      unsupported[key] = s[key]
      r.add(
        "info",
        "preset.unknown_field",
        `Regex script field \`${shownText(key)}\` isn't known. It's kept for export.`,
        [...path, key]
      )
    }
    scripts.set(id, {
      id,
      name: text(s, "scriptName", path, what, r),
      find_regex: text(s, "findRegex", path, what, r),
      replace_string: text(s, "replaceString", path, what, r),
      trim_strings: Array.isArray(s.trimStrings) ? s.trimStrings.filter((t) => typeof t === "string") : [],
      placement: Array.isArray(s.placement) ? s.placement.filter((p) => Number.isSafeInteger(p)) : [],
      disabled: Boolean(s.disabled),
      markdown_only: Boolean(s.markdownOnly),
      prompt_only: Boolean(s.promptOnly),
      run_on_edit: Boolean(s.runOnEdit),
      // ST runs an unknown mode as `none`.
      substitute_regex: SUBSTITUTE_REGEX[Number(primitiveOr(s.substituteRegex, NaN))] ?? "none",
      min_depth: regexDepth(s, "minDepth", path, r),
      max_depth: regexDepth(s, "maxDepth", path, r),
      ...(Object.keys(unsupported).length > 0 ? { unsupported } : {})
    })
  }
  // Global scripts are reported by the import once it knows whether they went in (an account
  // with scripts of its own keeps them).
  if (scripts.size > 0 && owner !== "global")
    r.add(
      "info",
      "preset.regex_imported",
      `${scripts.size} regex scripts were imported as data. As in ST, none runs until you allow this ${owner}'s scripts.`,
      base
    )
  return [...scripts.values()]
}

/** Scripts back to ST's `regex_scripts` shape, their unknown fields in place. */
export const regexToSt = (scripts: ReadonlyArray<RegexScript>) =>
  scripts.map((s) => ({
    ...s.unsupported,
    id: s.id,
    scriptName: s.name,
    findRegex: s.find_regex,
    replaceString: s.replace_string,
    trimStrings: [...s.trim_strings],
    placement: [...s.placement],
    disabled: s.disabled,
    markdownOnly: s.markdown_only,
    promptOnly: s.prompt_only,
    runOnEdit: s.run_on_edit,
    substituteRegex: SUBSTITUTE_REGEX.indexOf(s.substitute_regex),
    minDepth: s.min_depth,
    maxDepth: s.max_depth
  }))

/**
 * The document as an ST chat-completion preset that ST loads the same way, with the fields
 * kept in `unsupported{}`. Modelled fields win over an `unsupported{}` entry of the same name.
 * There's no connection or model data to write: ST then keeps its current connection. The
 * regex approval isn't written: ST keeps its own.
 */
export const exportStPreset = (stored: PresetDoc): Json => {
  // Back to what ST has (DESIGN §2.2): the turn texts to its utility prompts, with their macros
  // (ST has no field for the direction text, which isn't written); a condition to the triggers
  // that mean it, with the prompt's own; a prompt sent only with a direction, which ST would
  // send every turn, off.
  const doc = withEndOfRequest(stored).doc
  const enabled = new Map(doc.order.map((e) => [e.identifier, e.enabled]))
  const text = (identifier: string) => doc.prompts.find((p) => p.identifier === identifier)?.content ?? ""
  const utility = (identifier: string, macro: "char" | "user") => fromSpeaker(text(identifier), macro)
  const utility_prompts = {
    ...doc.utility_prompts,
    group_nudge_prompt: utility(GROUP_NUDGE, "char"),
    impersonation_prompt: utility(IMPERSONATION_PROMPT, "user"),
    continue_nudge_prompt: text(CONTINUE_NUDGE)
  }
  const prompts = doc.prompts
    .filter((p) => !endOfRequestText(p.identifier))
    .map((p) => ({
      ...p.unsupported,
      identifier: p.identifier,
      name: p.name,
      role: p.role,
      content: p.content,
      system_prompt: p.system_prompt,
      marker: p.marker,
      injection_position: p.injection_position === "absolute" ? 1 : 0,
      injection_depth: p.injection_depth,
      injection_order: p.injection_order,
      injection_trigger: triggersWithCondition(p),
      forbid_overrides: p.forbid_overrides,
      // ST ignores the condition; a reimport restores it. A prompt sent only with a direction
      // goes out off, and a reimport turns it back on.
      ...(conditionOf(p) !== "always" ? { condition: conditionOf(p) } : {}),
      ...(conditionOf(p) === "with_direction" ? { sent_with_direction: enabled.get(p.identifier) === true } : {}),
      // Its condition and generation types never meet: never sent here, so off for ST, which
      // would send it on its generation types. A reimport restores the switch.
      ...(gatesNeverMeet(p) ? { enabled_here: enabled.get(p.identifier) === true } : {})
    }))
  const off = new Set(
    doc.prompts.filter((p) => conditionOf(p) === "with_direction" || gatesNeverMeet(p)).map((p) => p.identifier)
  )
  const order = doc.order.map((e) => (off.has(e.identifier) ? { ...e, enabled: false } : { ...e }))
  const regex_scripts = regexToSt(doc.regex)
  return {
    ...doc.unsupported,
    ...doc.samplers,
    ...utility_prompts,
    ...Object.fromEntries(
      ["pin_examples", "strip_examples", "collapse_newlines"]
        .filter((key) => doc[key as keyof PresetDoc] !== undefined)
        .map((key) => [key, doc[key as keyof PresetDoc]])
    ),
    names_behavior: NamesBehavior.literals.indexOf(doc.names_behavior) - 1,
    squash_system_messages: doc.squash,
    custom_prompt_post_processing: doc.postprocess === "none" ? "" : doc.postprocess,
    use_sysprompt: doc.use_sysprompt,
    assistant_prefill: doc.prefill.assistant,
    assistant_impersonation: doc.prefill.impersonation,
    continue_prefill: doc.prefill.continue,
    continue_postfix: doc.prefill.continue_postfix,
    prompts,
    prompt_order: [{ character_id: GLOBAL_ORDER_ID, order }],
    extensions: { ...doc.extensions, ...(regex_scripts.length > 0 ? { regex_scripts } : {}) }
  }
}
