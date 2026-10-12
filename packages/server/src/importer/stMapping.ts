// What an ST chat file means here (DATA-MODEL §14, ARCHITECTURE.md §13): which card it's
// with, who spoke, and the chat state its metadata maps to, as events against what an
// earlier import made of it. Pure: the import (StImports.ts) does the storing.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import { shownText } from "@rp/shared/importReport.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { createHash } from "node:crypto"
import type { StImportNote } from "../db/ops.ts"
import { DEFAULT_SUMMARY_SETTINGS, stRole } from "../formats/stData.ts"
import type { StChatHeader, StGroup, StSettings, StSpeaker } from "./ops.ts"

/** A run this long, hidden from message 0, is ST's manual-summary pattern (DESIGN §1.4). [P] */
export const HIDDEN_RUN_MIN = 10
/** Earlier summaries kept as the summary note's history, newest kept: at most this many, */
const MAX_SUMMARY_REVISIONS = 200
/** and at most this many characters together, so a note's history stays one short write. */
const MAX_SUMMARY_HISTORY_CHARS = 256 * 1024

export const stem = (file: string) => file.replace(/\.[^.]*$/, "")
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

export interface CardInfo {
  readonly entityId: EntityId
  readonly label: string
  /** The card file's name without its extension, which names its chats' folder. */
  readonly file: string | null
  readonly name: string
  readonly greetings: ReadonlyArray<string>
  readonly world: string | null
}

export interface Link {
  readonly card: CardInfo | null
  readonly group: StGroup | null
}

/** What the import knows of the folder that a chat's mapping reads. */
export interface FolderContext {
  readonly settings: StSettings | null
  /** Cards by file name without extension. */
  readonly cards: ReadonlyMap<string, CardInfo>
  /** Persona cards by avatar file. */
  readonly personas: ReadonlyMap<string, EntityId>
  /** Personas' avatar files by name. */
  readonly personaNames: ReadonlyMap<string, ReadonlyArray<string>>
  /** Lorebooks by name. */
  readonly worlds: ReadonlyMap<string, RefId>
}

/** What an import made of a chat file's state, kept in its record to tell what changed. */
export interface ChatState {
  readonly participants: ReadonlyArray<string>
  readonly lorebooks: ReadonlyArray<string>
  readonly played: ReadonlyArray<string>
  /** Each variable's value, hashed. */
  readonly vars: Readonly<Record<string, string>>
  readonly authorNote: string | null
  readonly summary: string | null
}

/** Where ST put an extension prompt (`extension_prompt_types`), as a note's placement. */
const placementOf = (position: number, depth: number, role: number): NoteDoc["placement"] =>
  position === -1
    ? { mode: "none" }
    : position === 0
      ? { mode: "section", section: "after_main_prompt" }
      : position === 2
        ? { mode: "section", section: "before_main_prompt" }
        : { mode: "depth", depth, role: stRole(role) }

/** A card greeting as a pattern: `{{char}}` filled in, `{{user}}` matching any name. */
const greetingMatches = (greeting: string, cardName: string, chatGreeting: string) => {
  const filled = greeting.trim().replace(/\{\{char\}\}|<BOT>|<CHAR>/gi, cardName)
  const segments = filled.split(/\{\{user\}\}|<USER>/i)
  const text = chatGreeting.trim()
  if (!text.startsWith(segments[0]!)) return false
  let at = segments[0]!.length
  for (const segment of segments.slice(1)) {
    const found = text.indexOf(segment, at)
    if (found < 0) return false
    at = found + segment.length
  }
  return segments.length > 1 || text.length === at || text.length >= 4096
}

type LinkFound = { readonly card: CardInfo } | { readonly choices: ReadonlyArray<CardInfo>; readonly reason: string }

/** Which card a single chat is with: by folder, name, avatar, then greeting. */
export const linkChat = (
  cards: ReadonlyMap<string, CardInfo>,
  folder: string,
  speakers: ReadonlyArray<StSpeaker>,
  greeting: string | null
): LinkFound => {
  const all = [...cards.values()]
  const one = (found: ReadonlyArray<CardInfo>, reason: string): LinkFound | null =>
    found.length === 1 ? { card: found[0]! } : found.length > 1 ? { choices: found, reason } : null
  const byFolder = cards.get(folder)
  if (byFolder) return { card: byFolder }
  const byName = one(
    all.filter((card) => card.name === folder),
    `Several cards are named “${shownText(folder)}”.`
  )
  if (byName) return byName
  const avatars = new Set(speakers.flatMap((s) => (!s.user && s.avatar !== null ? [stem(s.avatar)] : [])))
  const byAvatar = one(
    all.filter((card) => card.file !== null && avatars.has(card.file)),
    "The chat's messages name several cards' avatars."
  )
  if (byAvatar) return byAvatar
  if (greeting !== null) {
    const byGreeting = one(
      all.filter((card) => card.greetings.some((g) => greetingMatches(g, card.name, greeting))),
      "Several cards have this chat's greeting."
    )
    if (byGreeting) return byGreeting
  }
  return { choices: [], reason: `No card matches the folder “${shownText(folder)}”.` }
}

/**
 * Each speaker of a part (at most `stChatLimits.maxSpeakers`) as a card, or null. Personas
 * that spoke are added to `spoke`.
 */
export const speakerMap = (
  folder: FolderContext,
  link: Link,
  header: StChatHeader | null,
  speakers: ReadonlyArray<StSpeaker>,
  spoke: Set<EntityId>
) => {
  const map = new Map<string, EntityId | null>()
  const members = new Map<string, Array<CardInfo>>()
  for (const member of link.group?.members ?? []) {
    const card = folder.cards.get(stem(member))
    if (card) members.set(card.name, [...(members.get(card.name) ?? []), card])
  }
  for (const speaker of speakers) {
    let entity: EntityId | null = null
    if (speaker.user) {
      const byName = (folder.personaNames.get(speaker.name) ?? []).filter((avatar) => folder.personas.has(avatar))
      entity =
        (speaker.avatar !== null ? folder.personas.get(speaker.avatar) : undefined) ??
        (header?.persona ? folder.personas.get(header.persona) : undefined) ??
        (byName.length === 1 ? folder.personas.get(byName[0]!)! : null)
      if (entity !== null) spoke.add(entity)
    } else {
      // A message names its card's avatar in group chats (and from ST's /sendas).
      const byAvatar = speaker.avatar === null ? undefined : folder.cards.get(stem(speaker.avatar))
      const byName = members.get(speaker.name) ?? []
      entity =
        byAvatar?.entityId ??
        (link.group === null ? (link.card?.entityId ?? null) : byName.length === 1 ? byName[0]!.entityId : null)
    }
    map.set(speaker.key, entity)
  }
  return map
}

/** The chat's participants, lorebooks and variables as the file has them. */
const membership = (folder: FolderContext, link: Link, header: StChatHeader | null, spoke: ReadonlySet<EntityId>) => {
  const participants: Array<string> = []
  const absent: Array<string> = []
  const worlds: Array<string> = []
  const group = link.group
  if (group !== null) {
    for (const member of group.members) {
      const card = folder.cards.get(stem(member))
      if (card === undefined) continue
      participants.push(card.entityId)
      if (group.disabledMembers.includes(member)) absent.push(card.entityId)
      if (card.world) worlds.push(card.world)
    }
  } else if (link.card !== null) {
    participants.push(link.card.entityId)
    if (link.card.world) worlds.push(link.card.world)
  }
  // ST's extra books for each character (charLore), by card file.
  const files = group?.members.map(stem) ?? (link.card?.file ? [link.card.file] : [])
  for (const lore of folder.settings?.characterWorlds ?? []) {
    if (files.includes(lore.card)) worlds.push(...lore.worlds)
  }
  if (header?.world) worlds.push(header.world)
  const lorebooks: Array<string> = []
  const missingWorlds: Array<string> = []
  for (const name of new Set(worlds)) {
    const ref = folder.worlds.get(name)
    if (ref === undefined) missingWorlds.push(name)
    else lorebooks.push(ref)
  }
  const played = [...spoke]
  return {
    participants: [...participants, ...played.filter((p) => !participants.includes(p))],
    absent,
    played,
    lorebooks,
    missingWorlds,
    vars: JSON.parse(header?.variablesJson ?? "[]") as Array<[string, unknown]>
  }
}

/** The author's note: the chat's own, or the default ST gives a chat without one. */
const authorNoteOf = (folder: FolderContext, header: StChatHeader | null): StImportNote | null => {
  const note = header?.authorNote ?? folder.settings?.defaultAuthorNote ?? null
  if (note === null || note.content.trim() === "") return null
  return {
    kind: "author_note",
    title: "Author's Note",
    contents: [note.content],
    placement: placementOf(note.position === -1 ? 1 : note.position, note.depth, note.role),
    interval: Math.max(0, note.interval),
    // ST never sends a note whose frequency is 0.
    activate: note.interval > 0
  }
}

/** The hidden run from message 0, as far as it was written. */
export interface HiddenRun {
  readonly length: number
  readonly firstSlot: SlotId | null
  readonly throughSlot: SlotId | null
}

/**
 * The chat's summary (DESIGN §8.1): the Summarize extension's latest `extra.memory`, not
 * counting the last message's, as ST reads it (`getLatestMemoryFromChat`), with its earlier
 * ones as the note's history. Placed as ST's settings placed it.
 */
const summaryOf = (
  folder: FolderContext,
  summaries: ReadonlyArray<{ readonly index: number; readonly text: string }>,
  messages: number,
  run: HiddenRun
) => {
  const usable = summaries.filter((s) => s.index < messages - 1)
  const current = usable.at(-1)
  if (current === undefined) return null
  const history: Array<string> = [current.text]
  let chars = 0
  let trimmed = false
  for (const summary of usable.toReversed()) {
    if (summary.text === history[0]) continue
    if (history.length >= MAX_SUMMARY_REVISIONS || chars + summary.text.length > MAX_SUMMARY_HISTORY_CHARS) {
      trimmed = true
      break
    }
    history.unshift(summary.text)
    chars += summary.text.length
  }
  const { position, depth, role, template, enabled } = folder.settings?.summary ?? DEFAULT_SUMMARY_SETTINGS
  const covers =
    run.length >= HIDDEN_RUN_MIN &&
    run.firstSlot !== null &&
    run.throughSlot !== null &&
    current.index >= run.length - 1
      ? { first_slot_id: run.firstSlot, last_slot_id: run.throughSlot, slot_count: run.length }
      : undefined
  const note: StImportNote = {
    kind: "imported_summary",
    title: "Summary",
    contents: history as [string, ...Array<string>],
    placement: placementOf(position, depth, role),
    template,
    ...(covers ? { covers } : {}),
    activate: enabled
  }
  return { note, index: current.index, trimmed }
}

/** What the import does with a chat's state once its last part is in. */
export const chatStateChange = (
  folder: FolderContext,
  file: {
    readonly link: Link
    readonly header: StChatHeader | null
    readonly spoke: ReadonlySet<EntityId>
    readonly summaries: ReadonlyArray<{ readonly index: number; readonly text: string }>
    readonly messages: number
    readonly run: HiddenRun
  },
  previous: ChatState | null,
  /** A new chat takes all of it; a chat merged into gets only what changed. */
  isNew: boolean
) => {
  const mapped = membership(folder, file.link, file.header, file.spoke)
  const authorNote = authorNoteOf(folder, file.header)
  const summary = summaryOf(folder, file.summaries, file.messages, file.run)
  const state: ChatState = {
    participants: mapped.participants,
    lorebooks: mapped.lorebooks,
    played: mapped.played,
    vars: Object.fromEntries(mapped.vars.map(([name, value]) => [name, hash(JSON.stringify(value))])),
    authorNote: authorNote && hash(JSON.stringify(authorNote)),
    summary: summary && hash(JSON.stringify(summary.note))
  }
  const events: Array<StateEventData> = []
  for (const entity of mapped.participants) {
    if (!previous?.participants.includes(entity)) {
      events.push({ key: "participant.join", value: { entity: entity as EntityId } })
    }
  }
  if (isNew) {
    for (const entity of mapped.absent) {
      events.push({ key: "presence.set", value: { entity: entity as EntityId, present: false } })
    }
  }
  if (mapped.played.length > 0 && JSON.stringify(previous?.played ?? []) !== JSON.stringify(mapped.played)) {
    events.push({ key: "played_by_me.set", value: { entities: mapped.played as Array<EntityId> } })
  }
  for (const ref of mapped.lorebooks) {
    if (!previous?.lorebooks.includes(ref)) events.push({ key: "lorebook.attach", value: { ref: ref as RefId } })
  }
  for (const ref of previous?.lorebooks ?? []) {
    if (!mapped.lorebooks.includes(ref)) events.push({ key: "lorebook.detach", value: { ref: ref as RefId } })
  }
  for (const [name, value] of mapped.vars) {
    if (previous?.vars[name] !== state.vars[name]) events.push({ key: "var.set", value: { name, value } })
  }
  const notes: Array<StImportNote> = []
  const removedNotes: Array<StImportNote["kind"]> = []
  if (authorNote !== null && state.authorNote !== previous?.authorNote) notes.push(authorNote)
  if (authorNote === null && (previous?.authorNote ?? null) !== null) removedNotes.push("author_note")
  if (summary !== null && state.summary !== previous?.summary) notes.push(summary.note)
  if (summary === null && (previous?.summary ?? null) !== null) removedNotes.push("imported_summary")
  return {
    state,
    events,
    notes,
    removedNotes,
    missingWorlds: mapped.missingWorlds,
    summaryIndex: summary?.index ?? null,
    summaryOnLast: file.summaries.some((s) => s.index >= file.messages - 1),
    summaryTrimmed: summary?.trimmed ?? false
  }
}
