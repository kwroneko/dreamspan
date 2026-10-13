// The rest of an ST data folder that chats depend on (DATA-MODEL §14): `settings.json` for
// personas, global lorebooks, the default author's note and the Summarize extension's
// settings, and `groups/*.json` for group chats. Read from ST's public source
// (`personas.js`, `world-info.js`, `authors-note.js`, `extensions/memory`, `global.d.ts`).
// Only what the importer maps is read; the rest of `settings.json` is dropped unread.
import { CARD_SCHEMA_VERSION, type CardDoc } from "@rp/shared/docs/card.ts"
import type { ReportBuilder } from "@rp/shared/importReport.ts"
import { Predicate } from "effect"
import type { LoreRole } from "@rp/shared/docs/lorebook.ts"
import { authorNoteFrom, bounded as boundedTo, type StAuthorNote } from "./stChat.ts"
import { defaultLimits, fail, parseJson } from "./safety.ts"

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
  /** ST's extension_prompt_types: -1 none, 0 after the main prompt, 1 in-chat, 2 before it. */
  readonly position: number
  readonly depth: number
  readonly role: number
  readonly template: string
  /** False when the extension is disabled, so ST sent no summary. */
  readonly enabled: boolean
}

export interface StSettings {
  readonly personas: ReadonlyArray<StPersona>
  /** Lorebooks ST applies to every chat (`world_info_settings.world_info.globalSelect`). */
  readonly globalWorlds: ReadonlyArray<string>
  /** Extra lorebooks per character (`world_info_settings.world_info.charLore`), by card file without extension. */
  readonly characterWorlds: ReadonlyArray<{ readonly card: string; readonly worlds: ReadonlyArray<string> }>
  /** The note ST gives a chat that has none of its own (`extension_settings.note`). */
  readonly defaultAuthorNote: StAuthorNote | null
  readonly summary: StSummarySettings
}

/** ST's defaults for the Summarize extension (`defaultSettings` in extensions/memory). */
export const DEFAULT_SUMMARY_SETTINGS: StSummarySettings = {
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

export const parseStSettings = (bytes: Uint8Array, issues: ReportBuilder): StSettings => {
  const settings = object(parseJson(bytes, stDataLimits.maxSettingsBytes, defaultLimits, issues))
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
  const worldInfo = object(object(settings.world_info_settings).world_info)
  const extensions = object(settings.extension_settings)
  const memory = object(extensions.memory)
  const disabled = strings(extensions.disabledExtensions, 1000)
  const note = object(extensions.note)
  const hasNoteSettings = [note.defaultPosition, note.defaultDepth, note.defaultRole, note.defaultInterval].some(
    (value) => typeof value === "number" && Number.isFinite(value)
  )
  const characterNotes = (Array.isArray(note.chara) ? note.chara : []).filter(
    (entry) => object(entry).useChara === true
  )
  if (characterNotes.length > 0) {
    issues.add(
      "warning",
      "st_settings.character_author_notes",
      `${characterNotes.length} characters have an author's note of their own in ST's settings; those aren't imported.`
    )
  }
  return {
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
    summary: {
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
  readonly id: string
  readonly name: string
  /** Card avatar file names. */
  readonly members: ReadonlyArray<string>
  /** Muted members, also by avatar file name. */
  readonly disabledMembers: ReadonlyArray<string>
  /** Its chats' ids, which name the files in `group chats/`. */
  readonly chats: ReadonlyArray<string>
}

export const parseStGroup = (bytes: Uint8Array, fileName: string, issues: ReportBuilder): StGroup => {
  const group = parseJson(bytes, stDataLimits.maxGroupBytes, defaultLimits, issues)
  if (!Predicate.isObject(group)) return fail("st_group.invalid", "A group file must hold an object.")
  const id = typeof group.id === "string" && group.id !== "" ? bounded(group.id) : fileName.replace(/\.json$/i, "")
  const chats = strings(group.chats, stDataLimits.maxGroupChats)
  if (typeof group.chat_id === "string" && !chats.includes(group.chat_id)) chats.push(bounded(group.chat_id))
  return {
    id,
    name: typeof group.name === "string" && group.name !== "" ? bounded(group.name) : id,
    members: strings(group.members, stDataLimits.maxGroupMembers),
    disabledMembers: strings(group.disabled_members, stDataLimits.maxGroupMembers),
    chats
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
  modules: [],
  extensions: {}
})
