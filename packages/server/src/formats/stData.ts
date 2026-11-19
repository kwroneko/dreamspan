// The rest of an ST data folder that chats depend on (DATA-MODEL §14): `settings.json` for
// personas, global lorebooks, the default author's note and the Summarize extension's
// settings, its global regex scripts, and `groups/*.json` for group chats. Read from ST's
// public source (`personas.js`, `world-info.js`, `authors-note.js`, `extensions/memory`,
// `extensions/regex`, `global.d.ts`). Only what the importer maps is read; the rest of
// `settings.json` is dropped unread.
import type { RegexScript } from "@dreamspan/shared/docs/regexScript.ts"
import { MAX_GLOBAL_SCRIPTS } from "@dreamspan/shared/regexScripts.ts"
import { readRegex } from "./preset.ts"
import { stIdTime } from "./sourceTime.ts"
import { parseStCreatedAt } from "./stCreatedAt.ts"
import { type ReplySectionSettings } from "@dreamspan/shared/replySections.ts"
import { CARD_SCHEMA_VERSION, type CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { ReportBuilder } from "@dreamspan/shared/importReport.ts"
import { Predicate } from "effect"
import type { LoreRole } from "@dreamspan/shared/docs/lorebook.ts"
import { authorNoteFrom, bounded as boundedTo, type StAuthorNote } from "./stChat.ts"
import { defaultLimits, fail, parseJson } from "./safety.ts"
import { ST_REPLY_ORDERS } from "@dreamspan/shared/naturalOrder.ts"

const MiB = 1024 * 1024

const stDataLimits = {
  /** settings.json holds every extension's settings too, quick replies and all. */
  maxSettingsBytes: 32 * MiB,
  maxGroupBytes: MiB,
  maxPersonas: 10_000,
  maxGroupMembers: 1000,
  maxGroupChats: 100_000,
  maxNameChars: 1024
}

/** A persona from ST's `power_user.personas` and `persona_descriptions`, by avatar file. */
export interface StPersona {
  readonly avatar: string
  readonly name: string
  readonly description: string
  /** ST's persona_description_positions: 0 in the prompt, 2/3 top/bottom of the author's note, 4 at depth, 9 none. */
  readonly position: number
  readonly depth: number
  readonly role: number
}

/** The Summarize extension's injection settings (`extension_settings.memory`). */
interface StSummarySettings {
  readonly prompt: string | null
  readonly promptWords: number
  /** ST's extension_prompt_types: -1 none, 0 after the main prompt, 1 in-chat, 2 before it. */
  readonly position: number
  readonly depth: number
  readonly role: number
  readonly template: string
  /** False when the extension is disabled, so ST sent no summary. */
  readonly enabled: boolean
}

export interface StSettings {
  readonly galleryFolders?: Readonly<Record<string, string>>
  readonly characterTags?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly tagNames?: Readonly<Record<string, string>>
  /** `power_user` settings that are a preset's here, copied into each imported preset. */
  readonly textSwitches?: {
    readonly pin_examples?: boolean
    readonly strip_examples?: boolean
    readonly collapse_newlines?: boolean
    /** ST's reasoning formatting (spec/REPLY-SECTIONS.md), its tags literal, as written. */
    readonly reply_sections?: ReplySectionSettings
  }
  readonly selectedPreset: string | null
  /** ST's default persona avatar, used by an imported chat without a user turn or lock. */
  readonly defaultPersona: string | null
  readonly personas: ReadonlyArray<StPersona>
  /** Lorebooks ST applies to every chat (`world_info_settings.world_info.globalSelect`). */
  readonly globalWorlds: ReadonlyArray<string>
  /** Extra lorebooks per character (`world_info_settings.world_info.charLore`), by card file without extension. */
  readonly characterWorlds: ReadonlyArray<{ readonly card: string; readonly worlds: ReadonlyArray<string> }>
  /** The note ST gives a chat that has none of its own (`extension_settings.note`). */
  readonly defaultAuthorNote: StAuthorNote | null
  /**
   * Characters' own author's notes (`extension_settings.note.chara`), by the card's avatar
   * file name without its extension. `position`: 0 replaces the chat's note, 1 goes before
   * it, 2 after (`chara_note_position`). ST applies one only where `useChara` is set.
   */
  readonly characterNotes: ReadonlyArray<{
    readonly card: string
    readonly prompt: string
    readonly useChara: boolean
    readonly position: number
  }>
  /** ST's "Include in World Info Scanning" for its author's notes (`note.allowWIScan`). */
  readonly allowWIScan: boolean
  /** ST's global regex scripts (`extension_settings.regex`), as data; absent when it has none. */
  readonly globalRegex?: ReadonlyArray<RegexScript>
  readonly summary: StSummarySettings
}

/** ST's defaults for the Summarize extension (`defaultSettings` in extensions/memory). */
export const DEFAULT_SUMMARY_SETTINGS: StSummarySettings = {
  prompt: null,
  promptWords: 200,
  position: 0,
  depth: 2,
  role: 0,
  template: "[Summary: {{summary}}]",
  enabled: true
}

const bounded = (value: string) => boundedTo(value, stDataLimits.maxNameChars)

const ROLES: ReadonlyArray<LoreRole> = ["system", "user", "assistant"]

/** ST's extension_prompt_roles: 0 system, 1 user, 2 assistant. */
export const stRole = (value: number): LoreRole => ROLES[value] ?? "system"
const strings = (value: unknown, max: number) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, max)
        .map(bounded)
    : []
const object = (value: unknown): Record<string, unknown> => (Predicate.isObject(value) ? value : {})
const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

/**
 * ST's reasoning formatting (`power_user.reasoning`) as a preset's reply-section setting:
 * Auto-parse is the switch, its prefix and suffix one literal pair (never a regex: ST has
 * none there) matched with case,
 * as ST's `startsWith` and `includes` do; Add to prompts sends back the last `max_additions`.
 */
const replySectionsFrom = (reasoning: Record<string, unknown>): ReplySectionSettings => {
  const prefix = typeof reasoning.prefix === "string" ? reasoning.prefix : ""
  const suffix = typeof reasoning.suffix === "string" ? reasoning.suffix : ""
  const additions = Math.trunc(numberOr(reasoning.max_additions, 1))
  return {
    enabled: reasoning.auto_parse === true && prefix !== "" && suffix !== "",
    pairs: prefix !== "" && suffix !== "" ? [{ open: prefix, close: suffix, case_sensitive: true }] : [],
    send_back: reasoning.add_to_prompts === true ? Math.min(1000, Math.max(0, additions)) : 0
  }
}

/**
 * ST's global regex scripts: the regex extension's `extension_settings.regex` (ST 1.19 keeps
 * no regex files of its own; its regex presets only name which of these are on). Read as a
 * preset's or a card's are, at most MAX_GLOBAL_SCRIPTS of them.
 */
const globalScripts = (raw: unknown, issues: ReportBuilder): ReadonlyArray<RegexScript> => {
  const path = ["extension_settings", "regex"]
  const scripts = readRegex(raw, issues, path, "global")
  if (scripts.length <= MAX_GLOBAL_SCRIPTS) return scripts
  issues.add(
    "warning",
    "st_settings.regex_dropped",
    `Only the first ${MAX_GLOBAL_SCRIPTS} global regex scripts were imported; ${scripts.length - MAX_GLOBAL_SCRIPTS} more were left out.`,
    path
  )
  return scripts.slice(0, MAX_GLOBAL_SCRIPTS)
}

export const parseStSettings = (bytes: Uint8Array, issues: ReportBuilder): StSettings => {
  const settings = object(parseJson(bytes, stDataLimits.maxSettingsBytes, defaultLimits, issues))
  const selectedPreset = object(settings.oai_settings).preset_settings_openai
  const powerUser = object(settings.power_user)
  const names = object(powerUser.personas)
  const descriptions = object(powerUser.persona_descriptions)
  const personas: Array<StPersona> = []
  for (const avatar of new Set([...Object.keys(names), ...Object.keys(descriptions)])) {
    if (personas.length >= stDataLimits.maxPersonas) {
      issues.add(
        "warning",
        "st_settings.personas_dropped",
        `Only the first ${stDataLimits.maxPersonas} personas were read.`
      )
      break
    }
    const described = object(descriptions[avatar])
    personas.push({
      avatar: bounded(avatar),
      name: bounded(typeof names[avatar] === "string" ? names[avatar] : ""),
      description: typeof described.description === "string" ? described.description : "",
      position: numberOr(described.position, 0),
      depth: Math.max(0, Math.trunc(numberOr(described.depth, 2))),
      role: numberOr(described.role, 0)
    })
  }
  const tagNames = Object.fromEntries(
    (Array.isArray(settings.tags) ? settings.tags : []).slice(0, 10000).flatMap((value) => {
      const tag = object(value)
      return typeof tag.id === "string" && typeof tag.name === "string" ? [[bounded(tag.id), bounded(tag.name)]] : []
    })
  )
  const characterTags = Object.fromEntries(
    Object.entries(object(settings.tag_map))
      .slice(0, 10000)
      .map(([name, ids]) => [bounded(name.replace(/\.[^.]*$/, "")), strings(ids, 1000)])
  )
  const worldInfo = object(object(settings.world_info_settings).world_info)
  const extensions = object(settings.extension_settings)
  const galleryFolders = Object.fromEntries(
    Object.entries(object(object(extensions.gallery).folders))
      .slice(0, 10000)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
  const memory = object(extensions.memory)
  const disabled = strings(extensions.disabledExtensions, 1000)
  const note = object(extensions.note)
  const hasNoteSettings = [note.defaultPosition, note.defaultDepth, note.defaultRole, note.defaultInterval].some(
    (value) => typeof value === "number" && Number.isFinite(value)
  )
  const characterNotes = (Array.isArray(note.chara) ? note.chara : []).slice(0, 10_000).flatMap((entry) => {
    const chara = object(entry)
    return typeof chara.name === "string" && typeof chara.prompt === "string"
      ? [
          {
            card: bounded(chara.name),
            prompt: chara.prompt,
            useChara: chara.useChara === true,
            position: numberOr(chara.position, 0)
          }
        ]
      : []
  })
  const switches = ["pin_examples", "strip_examples", "collapse_newlines"].some((key) => powerUser[key] !== undefined)
    ? {
        pin_examples: Boolean(powerUser.pin_examples),
        strip_examples: Boolean(powerUser.strip_examples),
        collapse_newlines: Boolean(powerUser.collapse_newlines)
      }
    : null
  const reasoning = Predicate.isObject(powerUser.reasoning) ? replySectionsFrom(powerUser.reasoning) : null
  const globalRegex = globalScripts(extensions.regex, issues)
  return {
    ...(switches || reasoning
      ? { textSwitches: { ...switches, ...(reasoning ? { reply_sections: reasoning } : {}) } }
      : {}),
    ...(Object.keys(tagNames).length ? { tagNames } : {}),
    ...(Object.keys(characterTags).length ? { characterTags } : {}),
    ...(Object.keys(galleryFolders).length ? { galleryFolders } : {}),
    selectedPreset: typeof selectedPreset === "string" && selectedPreset !== "" ? bounded(selectedPreset) : null,
    defaultPersona:
      typeof powerUser.default_persona === "string" && powerUser.default_persona !== ""
        ? bounded(powerUser.default_persona)
        : null,
    personas,
    globalWorlds: strings(worldInfo.globalSelect, 1000),
    characterWorlds: (Array.isArray(worldInfo.charLore) ? worldInfo.charLore : []).slice(0, 10_000).flatMap((entry) => {
      const lore = object(entry)
      return typeof lore.name === "string" ? [{ card: bounded(lore.name), worlds: strings(lore.extraBooks, 100) }] : []
    }),
    defaultAuthorNote: authorNoteFrom(
      { ...note, content: typeof note.default === "string" ? note.default : hasNoteSettings ? "" : null },
      {
        content: "content",
        position: "defaultPosition",
        depth: "defaultDepth",
        role: "defaultRole",
        interval: "defaultInterval"
      }
    ),
    characterNotes,
    allowWIScan: note.allowWIScan === true,
    ...(globalRegex.length > 0 ? { globalRegex } : {}),
    summary: {
      prompt: typeof memory.prompt === "string" ? memory.prompt : null,
      promptWords: Math.max(1, Math.trunc(numberOr(memory.promptWords, DEFAULT_SUMMARY_SETTINGS.promptWords))),
      position: numberOr(memory.position, DEFAULT_SUMMARY_SETTINGS.position),
      depth: Math.max(0, Math.trunc(numberOr(memory.depth, DEFAULT_SUMMARY_SETTINGS.depth))),
      role: numberOr(memory.role, DEFAULT_SUMMARY_SETTINGS.role),
      template: typeof memory.template === "string" ? memory.template : DEFAULT_SUMMARY_SETTINGS.template,
      enabled: !disabled.includes("memory")
    }
  }
}

/** A group definition (`groups/<id>.json`, `Group` in global.d.ts). */
export interface StGroup {
  readonly stAddedAt?: number | null
  readonly id: string
  readonly name: string
  /** Card avatar file names. */
  readonly members: ReadonlyArray<string>
  /** Muted members, also by avatar file name. */
  readonly disabledMembers: ReadonlyArray<string>
  /** Its chats' ids, which name the files in `group chats/`. */
  readonly chats: ReadonlyArray<string>
  /** The chat ST opens the group on (`chat_id`): the one last opened. */
  readonly chatId: string | null
  /** Who replies when nobody is picked (`activation_strategy`), as a reply policy id: `natural` (ST's default), `list`, `manual`, `pooled`. */
  readonly replyOrder: string
}

export const parseStGroup = (bytes: Uint8Array, fileName: string, issues: ReportBuilder): StGroup => {
  const group = parseJson(bytes, stDataLimits.maxGroupBytes, defaultLimits, issues)
  if (!Predicate.isObject(group)) return fail("st_group.invalid", "A group file must hold an object.")
  const id = typeof group.id === "string" && group.id !== "" ? bounded(group.id) : fileName.replace(/\.json$/i, "")
  const chats = strings(group.chats, stDataLimits.maxGroupChats)
  if (typeof group.chat_id === "string" && !chats.includes(group.chat_id)) chats.push(bounded(group.chat_id))
  return {
    id,
    ...((stIdTime(id) ?? parseStCreatedAt(group.create_date)) === null
      ? {}
      : { stAddedAt: stIdTime(id) ?? parseStCreatedAt(group.create_date) }),
    name: typeof group.name === "string" && group.name !== "" ? bounded(group.name) : id,
    members: strings(group.members, stDataLimits.maxGroupMembers),
    disabledMembers: strings(group.disabled_members, stDataLimits.maxGroupMembers),
    chats,
    chatId: typeof group.chat_id === "string" && group.chat_id !== "" ? bounded(group.chat_id) : null,
    // ST reads it with `Number(group.activation_strategy ?? NATURAL)`: a numeric string counts too.
    replyOrder: ST_REPLY_ORDERS[Number(group.activation_strategy ?? 0)] ?? "natural"
  }
}

/**
 * A persona as a card for the persona folder (DESIGN §2.2): its name and description. Its
 * avatar is the image file it's named after, stored as the card's avatar.
 */
export const personaCard = (persona: StPersona): CardDoc => ({
  schema_version: CARD_SCHEMA_VERSION,
  name: persona.name,
  description: persona.description,
  personality: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  alternate_greetings: [],
  group_only_greetings: [],
  system_prompt: "",
  post_history_instructions: "",
  creator_notes: "",
  tags: [],
  creator: "",
  character_version: "",
  avatar_media_id: null,
  extensions: {}
})
