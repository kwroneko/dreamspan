// SillyTavern chat files (JSONL, DATA-MODEL §14): a header line with `chat_metadata`, then one
// message per line. Read from ST's public source (`public/global.d.ts` for the shapes,
// `public/scripts/utils.js` for dates, `chats.js` for hiding, `extensions/memory` for the
// summary). A chat file can be far larger than any card, so it arrives in parts cut at line
// ends (ARCHITECTURE.md §13), and each part is read on its own: lines are separate JSON
// documents, each under the shared JSON caps. Pure: no database, no files.
import { ReportBuilder, shownText } from "@rp/shared/importReport.ts"
import { Predicate } from "effect"
import { defaultLimits, fail, type Limits, parseJson } from "./safety.ts"

const MiB = 1024 * 1024

export const stChatLimits = {
  /** A part of a chat file, and so its longest line: one message with all its swipes. */
  maxPartBytes: 8 * MiB,
  /** Versions kept per message; the owner generates 10 to 50 (DESIGN §3.1). */
  maxSwipes: 1000,
  maxVariables: 1000,
  /** A chat variable's value, as the macro engine bounds a write (ARCHITECTURE.md §10). */
  maxVariableBytes: MiB,
  /** Messages per write: each batch is one transaction in the writer. */
  maxBatchMessages: 100,
  maxBatchBytes: MiB,
  /**
   * Speakers per part. Each is mapped to a card on the main thread and checked in the
   * writer, so a file naming a new speaker on every line can't make that cost grow; a
   * group has a few dozen at most. Messages past it have no speaker.
   */
  maxSpeakers: 1000,
  /** A name or avatar file name, as the report and the speaker map keep them. */
  maxNameChars: 200,
  /** How much of a greeting is compared when linking a chat to a card. */
  maxGreetingChars: 4096
}

/** Lines are messages, not whole files: each is parsed under the shared caps on its own. */
const lineLimits: Limits = defaultLimits

/**
 * A timestamp as ST reads one (`parseTimestamp` in utils.js): epoch milliseconds, digits,
 * ISO 8601, "June 19, 2023 2:20pm", or ST's humanized "2024-07-12@01h31m37s123ms" forms.
 * Null when it's none of them.
 */
export const parseStDate = (value: unknown): number | null => {
  // Within what a JS Date can hold (±8.64e15 ms): larger numbers aren't times, and a timestamp column
  // takes only whole numbers it can store exactly.
  if (typeof value === "number") return value >= 0 && value <= MAX_TIME ? Math.trunc(value) : null
  if (typeof value !== "string" || value.length > 64) return null
  if (/^\d+$/.test(value)) return parseStDate(Number(value))
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)
    ? Date.parse(value)
    : NaN
  if (Number.isFinite(iso)) return iso
  const meridiem = value.match(/(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i)
  if (meridiem) {
    const [, month, day, year, hour, minute, half] = meridiem
    const monthIndex = MONTHS.indexOf(month!.slice(0, 3).toLowerCase())
    if (monthIndex < 0) return null
    const hour24 = (Number(hour) % 12) + (half!.toLowerCase() === "pm" ? 12 : 0)
    // ST reads this form in the browser's time zone; the importer can't know it, so UTC.
    const at = Date.UTC(Number(year), monthIndex, Number(day), hour24, Number(minute))
    return Number.isFinite(at) ? at : null
  }
  const humanized =
    value.match(/(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(?:(\d{1,3})ms)?/) ??
    value.match(/(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/)
  if (humanized) {
    const [, year, month, day, hour, minute, second, ms] = humanized
    const at = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms ?? 0)
    )
    return Number.isFinite(at) ? at : null
  }
  return null
}

const MAX_TIME = 8.64e15

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** ST's author's note, from `chat_metadata` (`authors-note.js`). */
export interface StAuthorNote {
  readonly content: string
  /** ST's extension_prompt_types: 0 after the main prompt, 1 in-chat, 2 before it. */
  readonly position: number
  readonly depth: number
  /** 0 system, 1 user, 2 assistant. */
  readonly role: number
  readonly interval: number
}

/** What a chat's header says, as far as the importer maps it. */
interface StChatHeader {
  /** The chat this one was branched or checkpointed from, by file name without `.jsonl`. */
  readonly mainChat: string | null
  /** The persona the chat is locked to, by avatar file name. */
  readonly persona: string | null
  /** The World Info file attached to the chat, by name. */
  readonly world: string | null
  /** Null when the chat has none of its own: ST then gives it the default note. */
  readonly authorNote: StAuthorNote | null
  /** `[name, value]` pairs of the chat's variables, as JSON. */
  readonly variablesJson: string
  readonly createdAt: number | null
}

/** One version of a message, in the writer's terms (db/stImportWrites.ts). */
interface StVersion {
  readonly content: string
  readonly reasoning: string | null
  readonly at: number
}

/** A message as the writer takes it: a slot with its versions. */
export interface StMessage {
  readonly user: boolean
  readonly hidden: boolean
  /** Who spoke, as a key into the speaker map the main thread resolves; null for the narrator. */
  readonly speaker: string | null
  readonly selected: number
  readonly versions: ReadonlyArray<StVersion>
}

/** A speaker as the file names it, for the main thread to map to a card. */
interface StSpeaker {
  readonly key: string
  readonly user: boolean
  readonly name: string
  /** The avatar file the message names: a persona's for the user, a card's otherwise. */
  readonly avatar: string | null
}

export interface StChatPart {
  /** Part 0 only, and null when the file has no header line (old group chats). */
  readonly header: StChatHeader | null
  /**
   * The part's messages as JSON arrays of `StMessage`, at most a transaction's worth each,
   * with the speaker keys each batch uses.
   */
  readonly batches: ReadonlyArray<{ readonly messagesJson: string; readonly speakers: ReadonlyArray<string> }>
  readonly messages: number
  readonly userTurns: number
  /** Hidden messages from the part's first message on, before the first shown one. */
  readonly leadingHidden: number
  readonly speakers: ReadonlyArray<StSpeaker>
  /** The first message's text when the model wrote it: the greeting, part 0 only. */
  readonly greeting: string | null
  /** The Summarize extension's summaries (`extra.memory`), by message index in the file. */
  readonly summaries: ReadonlyArray<{ readonly index: number; readonly text: string }>
  /** The last message's time, carried into the next part for messages without one. */
  readonly lastAt: number | null
}

const text = (value: unknown) => (typeof value === "string" ? value : null)

/** A file name from ST's avatar fields: a bare file, `User Avatars/<file>`, or a thumbnail URL. */
const avatarFile = (value: unknown, type: "persona" | "avatar"): string | null => {
  const raw = text(value)
  if (raw === null || raw === "" || raw.length > 2048) return null
  if (raw.startsWith("User Avatars/")) return type === "persona" ? raw.slice("User Avatars/".length) : null
  const thumbnail = raw.match(/[?&]type=(\w+)&file=([^&]+)/)
  if (thumbnail) {
    if (thumbnail[1] !== type) return null
    try {
      return decodeURIComponent(thumbnail[2]!)
    } catch {
      return null
    }
  }
  return type === "avatar" && !raw.includes("/") ? raw : null
}

export const bounded = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

/** ST's author's note settings, from a chat's metadata or ST's defaults (`authors-note.js`). */
export const authorNoteFrom = (source: Record<string, unknown>, keys: Record<keyof StAuthorNote, string>) => {
  const number = (key: string, fallback: number) =>
    typeof source[key] === "number" && Number.isFinite(source[key]) ? (source[key] as number) : fallback
  const content = text(source[keys.content])
  return content === null
    ? null
    : {
        content,
        position: number(keys.position, 1),
        depth: Math.max(0, Math.trunc(number(keys.depth, 4))),
        role: number(keys.role, 0),
        interval: Math.trunc(number(keys.interval, 1))
      }
}

const NOTE_KEYS = {
  content: "note_prompt",
  position: "note_position",
  depth: "note_depth",
  role: "note_role",
  interval: "note_interval"
} as const

const headerFrom = (line: Record<string, unknown>, issues: ReportBuilder): StChatHeader => {
  const metadata = Predicate.isObject(line.chat_metadata) ? line.chat_metadata : {}
  const variables: Array<[string, unknown]> = []
  if (Predicate.isObject(metadata.variables)) {
    for (const [name, value] of Object.entries(metadata.variables)) {
      if (variables.length >= stChatLimits.maxVariables) {
        issues.add(
          "warning",
          "st_chat.variables_dropped",
          `Only the first ${stChatLimits.maxVariables} variables were kept.`
        )
        break
      }
      if (JSON.stringify(value).length > stChatLimits.maxVariableBytes) {
        issues.add(
          "warning",
          "st_chat.variable_too_large",
          `The variable "${shownText(name)}" is over 1 MB and was left out.`
        )
        continue
      }
      variables.push([name, value])
    }
  }
  const nameOf = (value: unknown) => (typeof value === "string" && value !== "" ? bounded(value, 1024) : null)
  return {
    mainChat: nameOf(metadata.main_chat),
    persona: nameOf(metadata.persona),
    world: nameOf(metadata.world_info),
    authorNote: authorNoteFrom(metadata, NOTE_KEYS),
    variablesJson: JSON.stringify(variables),
    createdAt: parseStDate(line.create_date)
  }
}

const isHeader = (line: Record<string, unknown>) =>
  !("mes" in line) && ("chat_metadata" in line || "user_name" in line || "character_name" in line)

const ATTACHMENTS = ["image", "media", "files", "file", "video", "inline_image"]

/**
 * Reads one part of a chat file. `firstIndex` is the file index of the part's first
 * message, and `carryAt` the previous part's last time. A message without a time takes
 * the one before it, so a re-import gives every version the same time and matches it.
 */
export const parseStChatPart = (
  bytes: Uint8Array,
  options: { readonly first: boolean; readonly firstIndex: number; readonly carryAt: number | null },
  issues: ReportBuilder
): StChatPart => {
  if (bytes.byteLength > stChatLimits.maxPartBytes) {
    fail("st_chat.part_too_large", `A part of a chat file can be at most ${stChatLimits.maxPartBytes} bytes.`)
  }
  let header: StChatHeader | null = null
  let lastAt = options.carryAt
  let index = options.firstIndex
  let userTurns = 0
  let leadingHidden = 0
  let shownYet = false
  let greeting: string | null = null
  let attachments = 0
  let unreadable = 0
  const speakers = new Map<string, StSpeaker>()
  const summaries: Array<{ index: number; text: string }> = []
  const batches: Array<{ messagesJson: string; speakers: ReadonlyArray<string> }> = []
  let batch: Array<string> = []
  let batchSpeakers = new Set<string>()
  let batchBytes = 0
  let unspoken = 0
  const flush = () => {
    if (batch.length > 0) batches.push({ messagesJson: `[${batch.join(",")}]`, speakers: [...batchSpeakers] })
    batch = []
    batchSpeakers = new Set()
    batchBytes = 0
  }

  let start = 0
  while (start < bytes.byteLength) {
    let end = bytes.indexOf(0x0a, start)
    if (end < 0) end = bytes.byteLength
    const raw = bytes.subarray(start, end)
    start = end + 1
    if (raw.every((byte) => byte === 0x20 || byte === 0x0d || byte === 0x09)) continue
    let value: unknown
    try {
      value = parseJson(raw, stChatLimits.maxPartBytes, lineLimits, issues)
    } catch {
      // ST skips lines it can't parse too (getChatData in chats.js).
      unreadable++
      continue
    }
    if (!Predicate.isObject(value)) {
      unreadable++
      continue
    }
    if (options.first && header === null && index === options.firstIndex && isHeader(value)) {
      header = headerFrom(value, issues)
      lastAt ??= header.createdAt
      continue
    }

    const extra = Predicate.isObject(value.extra) ? value.extra : {}
    const user = value.is_user === true
    const hidden = value.is_system === true
    const mes = text(value.mes) ?? ""
    const sentAt = parseStDate(value.send_date) ?? lastAt ?? 0
    lastAt = sentAt
    const swipeInfo = Array.isArray(value.swipe_info) ? value.swipe_info : []
    const reasoningOf = (source: unknown) =>
      Predicate.isObject(source) && typeof source.reasoning === "string" && source.reasoning !== ""
        ? source.reasoning
        : null
    let versions: Array<StVersion>
    let selected = 0
    const swipes = Array.isArray(value.swipes) ? value.swipes.filter((s): s is string => typeof s === "string") : []
    if (swipes.length === 0) {
      versions = [{ content: mes, reasoning: reasoningOf(extra), at: sentAt }]
    } else {
      if (swipes.length > stChatLimits.maxSwipes) {
        issues.add(
          "warning",
          "st_chat.swipes_dropped",
          `Message ${index} has ${swipes.length} swipes; only the first ${stChatLimits.maxSwipes} were kept.`
        )
      }
      const kept = swipes.slice(0, stChatLimits.maxSwipes)
      versions = kept.map((content, i) => {
        const info = Predicate.isObject(swipeInfo[i]) ? swipeInfo[i] : {}
        return { content, reasoning: reasoningOf(info.extra), at: parseStDate(info.send_date) ?? sentAt }
      })
      const swipeId = typeof value.swipe_id === "number" && Number.isSafeInteger(value.swipe_id) ? value.swipe_id : 0
      // `mes` is what ST shows and sends; the swipe it came from is normally swipe_id.
      selected = kept[swipeId] === mes ? swipeId : kept.indexOf(mes)
      if (selected < 0) {
        versions.push({ content: mes, reasoning: reasoningOf(extra), at: sentAt })
        selected = versions.length - 1
      } else {
        // The shown swipe has the message's own time and reasoning.
        versions[selected] = {
          content: mes,
          reasoning: reasoningOf(extra) ?? versions[selected]!.reasoning,
          at: sentAt
        }
      }
    }

    const name = bounded(text(value.name) ?? "", stChatLimits.maxNameChars)
    let speaker: string | null = null
    if (extra.type !== "narrator") {
      const avatar = user
        ? avatarFile(value.force_avatar, "persona")
        : (avatarFile(value.original_avatar, "avatar") ?? avatarFile(value.force_avatar, "avatar"))
      const shownAvatar = avatar === null ? null : bounded(avatar, stChatLimits.maxNameChars)
      const key = `${user ? "u" : "c"}:${shownAvatar === null ? `name:${name}` : `avatar:${shownAvatar}`}`
      if (speakers.has(key) || speakers.size < stChatLimits.maxSpeakers) {
        speakers.set(key, { key, user, name, avatar: shownAvatar })
        speaker = key
      } else unspoken++
    }

    if (user) userTurns++
    if (!shownYet && hidden) leadingHidden++
    else shownYet = true
    if (index === 0 && !user) greeting = bounded(mes, stChatLimits.maxGreetingChars)
    if (typeof extra.memory === "string" && extra.memory.trim() !== "") summaries.push({ index, text: extra.memory })
    if (ATTACHMENTS.some((key) => extra[key] !== undefined && extra[key] !== null && extra[key] !== false)) {
      attachments++
    }

    const message: StMessage = { user, hidden, speaker, selected, versions }
    const json = JSON.stringify(message)
    if (
      batch.length >= stChatLimits.maxBatchMessages ||
      (batch.length > 0 && batchBytes + json.length > stChatLimits.maxBatchBytes)
    ) {
      flush()
    }
    batch.push(json)
    if (speaker !== null) batchSpeakers.add(speaker)
    batchBytes += json.length
    index++
  }
  flush()
  if (unreadable > 0) {
    issues.add(
      "warning",
      "st_chat.unreadable_lines",
      `${unreadable} lines weren't messages and were skipped, as ST skips them.`
    )
  }
  if (unspoken > 0) {
    issues.add(
      "warning",
      "st_chat.speakers_dropped",
      `${unspoken} messages name more speakers than ${stChatLimits.maxSpeakers}; they were imported without one.`
    )
  }
  if (attachments > 0) {
    issues.add(
      "info",
      "st_chat.attachments",
      `${attachments} messages had images or files attached; only their text was imported.`
    )
  }
  return {
    header,
    batches,
    messages: index - options.firstIndex,
    userTurns,
    leadingHidden,
    speakers: [...speakers.values()],
    greeting,
    summaries,
    lastAt
  }
}
