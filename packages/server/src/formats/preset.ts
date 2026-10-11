// SillyTavern chat-completion presets (DESIGN §1.2): import into the preset document and
// export back. The rules follow ST's own loading (public/scripts/openai.js and
// PromptManager.js): its migrations, its defaults for missing fields, and its sanitizing of
// prompts and the prompt order. Nothing here runs anything from the file.
import {
  PRESET_SCHEMA_VERSION,
  type NamesBehavior,
  type PostProcessing,
  type PresetDoc,
  type PresetPrompt,
  type PresetSamplers,
  type PromptOrderEntry,
  type PromptRole,
  type RegexScript,
  type UtilityPrompts
} from "@rp/shared/docs/preset.ts"
import { ImportIssue, type ImportIssueLevel, ImportReport } from "@rp/shared/importReport.ts"

export const ST_PRESET_FORMAT = "st-chat-completion-preset"

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

/** The only prompt order ST's prompt manager uses: its "global" strategy's dummy character. */
const GLOBAL_ORDER_ID = 100001

const DEFAULT_DEPTH = 4
const DEFAULT_ORDER = 100
const MAX_INJECTION_DEPTH = 10_000
const PROMPT_ROLES: ReadonlyArray<string> = ["system", "user", "assistant"]

const NAMES_BEHAVIOR: ReadonlyArray<readonly [NamesBehavior, number]> = [
  ["none", -1],
  ["default", 0],
  ["completion", 1],
  ["content", 2]
]
const SUBSTITUTE_REGEX = ["none", "raw", "escaped"] as const
const POSTPROCESS: ReadonlyArray<PostProcessing> = [
  "none",
  "merge",
  "merge_tools",
  "semi",
  "semi_tools",
  "strict",
  "strict_tools",
  "single"
]

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
  "forbid_overrides"
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

class Reporter {
  readonly issues: Array<ImportIssue> = []
  add(level: ImportIssueLevel, code: string, message: string, path?: Path) {
    this.issues.push(new ImportIssue({ level, code, message, ...(path ? { path } : {}) }))
  }
  done(format: string, document: PresetDoc | null): PresetImport {
    return { document, report: new ImportReport({ format, issues: this.issues }) }
  }
}

/** The other kinds of ST JSON file, by ST's own tests where it has them (preset-manager.js). */
const otherKind = (o: Json): readonly [format: string, label: string] | undefined => {
  const has = (...keys: Array<string>) => keys.every((k) => Object.hasOwn(o, k))
  if (has("name", "input_sequence", "output_sequence")) return ["st-instruct-template", "an instruct template"]
  if (has("name", "story_string")) return ["st-context-template", "a context template"]
  if (has("name", "content")) return ["st-system-prompt", "a system prompt template"]
  if (has("temp", "top_k", "top_p", "rep_pen")) return ["st-text-completion-preset", "a text-completion preset"]
  if (has("name", "prefix", "suffix", "separator")) return ["st-reasoning-template", "a reasoning template"]
  if (has("max_length", "min_length")) return ["st-novelai-preset", "a NovelAI preset"]
  if (["instruct", "context", "sysprompt", "preset", "reasoning"].some((k) => isObject(o[k])))
    return ["st-master-export", "an Advanced Formatting export"]
  return undefined
}

const decodeText = (input: string | Uint8Array) =>
  typeof input === "string" ? input.replace(/^\uFEFF/, "") : new TextDecoder().decode(input)

export const importStPreset = (input: string | Uint8Array): PresetImport => {
  const r = new Reporter()
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeText(input))
  } catch {
    r.add("error", "preset.invalid_json", "The file isn't valid JSON.")
    return r.done("unknown", null)
  }
  if (!isObject(parsed)) {
    r.add("error", "preset.unrecognized", "The file isn't a SillyTavern chat-completion preset.")
    return r.done("unknown", null)
  }
  if (!CHAT_COMPLETION_FIELDS.some((k) => Object.hasOwn(parsed, k))) {
    const other = otherKind(parsed)
    if (!other) {
      r.add("error", "preset.unrecognized", "The file isn't a SillyTavern chat-completion preset.")
      return r.done("unknown", null)
    }
    r.add(
      "warning",
      "preset.unsupported_format",
      `This is ${other[1]}. Only chat-completion presets are supported, so it wasn't imported.`
    )
    return r.done(other[0], null)
  }
  return r.done(ST_PRESET_FORMAT, readPreset(parsed, r))
}

const readPreset = (file: Json, r: Reporter): PresetDoc => {
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
  const utility_prompts = mapDefaults(DEFAULT_UTILITY_PROMPTS)

  const namesValue = num("names_behavior", 0)
  let names_behavior = NAMES_BEHAVIOR.find(([, n]) => n === namesValue)?.[0]
  if (names_behavior === undefined) {
    r.add("warning", "preset.invalid_value", "`names_behavior` has an unknown value, so ST's default is used.", [
      "names_behavior"
    ])
    names_behavior = "default"
  }
  const postValue = str("custom_prompt_post_processing", "") || "none"
  let postprocess = POSTPROCESS.find((p) => p === postValue)
  if (postprocess === undefined) {
    r.add(
      "warning",
      "preset.invalid_value",
      "`custom_prompt_post_processing` has an unknown value, so no post-processing is used.",
      ["custom_prompt_post_processing"]
    )
    postprocess = "none"
  }

  const { prompts, unsendable } = readPrompts(field("prompts"), r)
  const order = readOrder(field("prompt_order"), prompts, unsendable, r)
  const extensions: Json = isObject(src.extensions) ? { ...src.extensions } : {}
  consumed.add("extensions")
  const regex = readRegex(extensions.regex_scripts, r)
  delete extensions.regex_scripts
  for (const key of Object.keys(extensions))
    r.add("info", "preset.extension_kept", `Extension data \`${key}\` is kept for export but not used.`, [
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
    unsupported[key] = src[key]
    if (UI_ONLY.has(key)) continue
    if (!Object.hasOwn(UNMODELED_DEFAULTS, key))
      r.add("info", "preset.unknown_field", `\`${key}\` isn't a known preset field. It's kept for export.`, [key])
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
      `Connection and model settings are ignored and not stored: ${ignored.join(", ")}.`
    )
  if (missing.length > 0)
    r.add("info", "preset.defaults_applied", `The preset doesn't set ${missing.join(", ")}, so ST's defaults are used.`)
  return doc
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

const readPrompts = (raw: unknown, r: Reporter) => {
  if (raw !== undefined && !Array.isArray(raw))
    r.add("warning", "preset.invalid_value", "`prompts` isn't a list, so ST's built-in prompts are used.", ["prompts"])
  const prompts = new Map<string, PresetPrompt>()
  // In-chat prompts that ST never sends: no usable depth or role.
  const unsendable = new Set<string>()
  for (const [i, p] of (Array.isArray(raw) ? raw : []).entries()) {
    const path = ["prompts", i]
    if (!isObject(p)) {
      r.add("warning", "preset.prompt_invalid", "A prompt isn't an object and was dropped.", path)
      continue
    }
    const prompt = readPrompt(p, path, r)
    if (prompts.has(prompt.identifier)) {
      r.add(
        "warning",
        "preset.prompt_duplicate",
        `A second prompt \`${prompt.identifier}\` was dropped. ST only ever uses the first.`,
        path
      )
      continue
    }
    prompts.set(prompt.identifier, prompt)
    if (
      prompt.injection_position === "absolute" &&
      (!validDepth(p.injection_depth) || !PROMPT_ROLES.includes(p.role as string))
    )
      unsendable.add(prompt.identifier)
  }
  // ST's sanitizing adds any built-in prompt that's missing.
  for (const builtIn of ST_DEFAULT_PROMPTS)
    if (!prompts.has(builtIn.identifier as string))
      prompts.set(builtIn.identifier as string, readPrompt(builtIn, [], r))
  return { prompts: [...prompts.values()], unsendable }
}

const validDepth = (d: unknown): d is number =>
  typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= MAX_INJECTION_DEPTH

const readPrompt = (p: Json, path: Path, r: Reporter): PresetPrompt => {
  let identifier = typeof p.identifier === "string" && p.identifier !== "" ? p.identifier : undefined
  if (identifier === undefined) {
    // ST gives it a random id, which no order entry names, so it's never sent.
    identifier = `imported-${path[1]}`
    r.add("info", "preset.prompt_identifier", `A prompt without an identifier was named \`${identifier}\`.`, path)
  }
  let role: PromptRole = "system"
  if (PROMPT_ROLES.includes(p.role as string)) role = p.role as PromptRole
  else if (p.role)
    r.add("warning", "preset.invalid_value", `Prompt \`${identifier}\` has an unknown role, so \`system\` is used.`, [
      ...path,
      "role"
    ])
  const order =
    typeof p.injection_order === "number" || typeof p.injection_order === "string" ? Number(p.injection_order) : NaN
  const unsupported: Json = {}
  for (const key of Object.keys(p)) {
    if (PROMPT_FIELDS.has(key)) continue
    unsupported[key] = p[key]
    if (!ST_PROMPT_EXTRAS.has(key))
      r.add("info", "preset.unknown_field", `Prompt field \`${key}\` isn't known. It's kept for export.`, [
        ...path,
        key
      ])
  }
  return {
    identifier,
    name: typeof p.name === "string" ? p.name : "",
    role,
    content: typeof p.content === "string" ? p.content : "",
    // ST sends a prompt from the order only when this is exactly `false`.
    system_prompt: p.system_prompt !== false,
    marker: Boolean(p.marker),
    injection_position: p.injection_position === 1 ? "absolute" : "relative",
    injection_depth: validDepth(p.injection_depth) ? p.injection_depth : DEFAULT_DEPTH,
    injection_order: Number.isFinite(order) ? order : DEFAULT_ORDER,
    injection_trigger: Array.isArray(p.injection_trigger)
      ? p.injection_trigger.filter((t): t is string => typeof t === "string")
      : [],
    // ST honours the flag only when it's exactly `true`.
    forbid_overrides: p.forbid_overrides === true,
    ...(Object.keys(unsupported).length > 0 ? { unsupported } : {})
  }
}

const readOrder = (
  raw: unknown,
  prompts: ReadonlyArray<PresetPrompt>,
  unsendable: ReadonlySet<string>,
  r: Reporter
): Array<PromptOrderEntry> => {
  let entries: ReadonlyArray<unknown> = DEFAULT_ORDER_ENTRIES
  let basePath: Path = []
  if (raw !== undefined) {
    const lists = Array.isArray(raw) ? raw : []
    const index = lists.findIndex((l) => isObject(l) && String(l.character_id) === String(GLOBAL_ORDER_ID))
    const others = lists.filter((l, i) => i !== index && isObject(l)).map((l) => String((l as Json).character_id))
    if (others.length > 0)
      r.add(
        "info",
        "preset.prompt_orders_dropped",
        `ST uses only the global prompt order (${GLOBAL_ORDER_ID}). Other orders were dropped: ${others.join(", ")}.`,
        ["prompt_order"]
      )
    const global = lists[index] as Json | undefined
    if (global && Array.isArray(global.order)) {
      entries = global.order
      basePath = ["prompt_order", index, "order"]
    } else
      r.add(
        "warning",
        "preset.no_global_order",
        "The preset has no usable global prompt order, so ST's default order is used, as in ST.",
        ["prompt_order"]
      )
  }
  const known = new Set(prompts.map((p) => p.identifier))
  const order = new Map<string, PromptOrderEntry>()
  for (const [i, e] of entries.entries()) {
    const path = [...basePath, i]
    const identifier = isObject(e) && typeof e.identifier === "string" ? e.identifier : undefined
    if (identifier === undefined || !known.has(identifier)) {
      // ST drops order entries that name no prompt.
      r.add("info", "preset.order_entry_dropped", "A prompt order entry names no prompt and was dropped.", path)
      continue
    }
    if (order.has(identifier)) {
      r.add(
        "warning",
        "preset.order_duplicate",
        `\`${identifier}\` appears twice in the prompt order; kept once.`,
        path
      )
      continue
    }
    let enabled = Boolean((e as Json).enabled)
    if (enabled && unsendable.has(identifier)) {
      r.add(
        "warning",
        "preset.prompt_never_sent",
        `In-chat prompt \`${identifier}\` has no valid depth or role, so ST never sends it. It's imported disabled.`,
        path
      )
      enabled = false
    }
    order.set(identifier, { identifier, enabled })
  }
  return [...order.values()]
}

const regexDepth = (v: unknown, min: number): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isNaN(n) || n < min ? null : n
}

const readRegex = (raw: unknown, r: Reporter): Array<RegexScript> => {
  if (raw === undefined || raw === null) return []
  const base = ["extensions", "regex_scripts"]
  if (!Array.isArray(raw)) {
    r.add("warning", "preset.invalid_value", "`regex_scripts` isn't a list, so it was dropped.", base)
    return []
  }
  const scripts = new Map<string, RegexScript>()
  for (const [i, s] of raw.entries()) {
    const path = [...base, i]
    if (!isObject(s)) {
      r.add("warning", "preset.regex_invalid", "A regex script isn't an object and was dropped.", path)
      continue
    }
    let id = typeof s.id === "string" && s.id !== "" ? s.id : `imported-regex-${i}`
    if (scripts.has(id)) {
      let n = 2
      while (scripts.has(`${id}-${n}`)) n++
      r.add("info", "preset.regex_id", `A second regex script \`${id}\` was renamed \`${id}-${n}\`.`, path)
      id = `${id}-${n}`
    }
    const unsupported: Json = {}
    for (const key of Object.keys(s)) {
      if (REGEX_FIELDS.has(key)) continue
      unsupported[key] = s[key]
      r.add("info", "preset.unknown_field", `Regex script field \`${key}\` isn't known. It's kept for export.`, [
        ...path,
        key
      ])
    }
    scripts.set(id, {
      id,
      name: typeof s.scriptName === "string" ? s.scriptName : "",
      find_regex: typeof s.findRegex === "string" ? s.findRegex : "",
      replace_string: typeof s.replaceString === "string" ? s.replaceString : "",
      trim_strings: Array.isArray(s.trimStrings) ? s.trimStrings.filter((t) => typeof t === "string") : [],
      placement: Array.isArray(s.placement) ? s.placement.filter((p) => Number.isInteger(p)) : [],
      disabled: Boolean(s.disabled),
      markdown_only: Boolean(s.markdownOnly),
      prompt_only: Boolean(s.promptOnly),
      run_on_edit: Boolean(s.runOnEdit),
      // ST runs an unknown mode as `none`.
      substitute_regex: SUBSTITUTE_REGEX[Number(s.substituteRegex)] ?? "none",
      // ST applies a minimum from -1 and a maximum from 0; anything lower is no bound.
      min_depth: regexDepth(s.minDepth, -1),
      max_depth: regexDepth(s.maxDepth, 0),
      ...(Object.keys(unsupported).length > 0 ? { unsupported } : {})
    })
  }
  if (scripts.size > 0)
    r.add(
      "info",
      "preset.regex_imported",
      `${scripts.size} regex scripts were imported as data. In ST, a preset's scripts run only after you allow them for that preset.`,
      base
    )
  return [...scripts.values()]
}

/**
 * The document as an ST chat-completion preset that ST loads the same way, with the fields
 * kept in `unsupported{}`. Modelled fields win over an `unsupported{}` entry of the same name.
 * There's no connection or model data to write: ST then keeps its current connection.
 */
export const exportStPreset = (doc: PresetDoc): Json => {
  const prompts = doc.prompts.map((p) => ({
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
    injection_trigger: [...p.injection_trigger],
    forbid_overrides: p.forbid_overrides
  }))
  const regex_scripts = doc.regex.map((s) => ({
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
  return {
    ...doc.unsupported,
    ...doc.samplers,
    ...doc.utility_prompts,
    names_behavior: NAMES_BEHAVIOR.find(([name]) => name === doc.names_behavior)![1],
    squash_system_messages: doc.squash,
    custom_prompt_post_processing: doc.postprocess === "none" ? "" : doc.postprocess,
    use_sysprompt: doc.use_sysprompt,
    assistant_prefill: doc.prefill.assistant,
    assistant_impersonation: doc.prefill.impersonation,
    continue_prefill: doc.prefill.continue,
    continue_postfix: doc.prefill.continue_postfix,
    prompts,
    prompt_order: [{ character_id: GLOBAL_ORDER_ID, order: doc.order.map((e) => ({ ...e })) }],
    extensions: { ...doc.extensions, ...(regex_scripts.length > 0 ? { regex_scripts } : {}) }
  }
}
