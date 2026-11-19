// What an ST chat file means here (DATA-MODEL §14, ARCHITECTURE.md §13): which card it's
// with, who spoke, and the chat state its metadata maps to, as events against what an
// earlier import made of it. Pure: the import (StImports.ts) does the storing.
import type { EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { cleanName } from "@dreamspan/shared/chatName.ts"
import { noteDepth, type NoteDoc } from "@dreamspan/shared/docs/note.ts"
import { shownText } from "@dreamspan/shared/importReport.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { createHash } from "node:crypto"
import type { StImportNote } from "../db/ops.ts"
import { stStateHash } from "../db/stImportProgress.ts"
import { DEFAULT_SUMMARY_SETTINGS, stRole } from "../formats/stData.ts"
import type { StAuthorNote } from "../formats/stChat.ts"
import type { StChatHeader, StGroup, StSettings, StSpeaker } from "./ops.ts"

/** A run this long, hidden from message 0, is ST's manual-summary pattern (DESIGN §1.4). [P] */
export const HIDDEN_RUN_MIN = 10
/** Earlier summaries kept as the summary note's history, newest kept: at most this many, */
const MAX_SUMMARY_REVISIONS = 200
/** and at most this many characters together, so a note's history stays one short write. */
const MAX_SUMMARY_HISTORY_CHARS = 256 * 1024

export const stem = (file: string) => file.replace(/\.[^.]*$/, "")

/** ST's humanized date in a file name: `2024-7-12@01h31m37s123ms`, older ones without ms. */
const ST_DATE = String.raw`\d{4}-\d{1,2}-\d{1,2} ?@\d{1,2}h ?\d{1,2}m ?\d{1,2}s(?: ?\d{1,3}ms)?`
/**
 * The names ST gives a fork file: `<chat> - Branch #<n>` and `<chat> - Checkpoint #<n>` now,
 * `Branch #<message> - <date>`, `Checkpoint #<n> - <date>` and `Bookmark #<n> - <date>` in
 * older versions.
 */
const AUTOMATIC_FORK = new RegExp(String.raw`^(?:Branch|Checkpoint|Bookmark) #\d+ - ${ST_DATE}$`, "u")
const FORK_SUFFIX = / - (?:Branch|Checkpoint) #[1-9]\d*$/u
const GROUP_STAMP = new RegExp(`^${ST_DATE}$`, "u")

/** ST's createGroup joins the selected characters' names, in character-list order. */
const defaultGroupName = (group: string, members: ReadonlyArray<string | null>) => {
  if (!group.startsWith("Group: ") || members.length === 0 || members.some((name) => name === null)) return false
  // The exported member order needn't be the character-list order. Compare all names,
  // including repeats. Consume whole names, longest first, since a name can contain commas.
  const pending = members.map((name) => cleanName(name!)).sort((a, b) => b.length - a.length)
  let rest = group.slice(7)
  while (pending.length > 0) {
    const index = pending.findIndex((name) => rest === name || rest.startsWith(`${name}, `))
    if (index < 0) return false
    const [name] = pending.splice(index, 1)
    rest = rest.slice(name!.length + (rest === name ? 0 : 2))
  }
  return rest === ""
}

/**
 * The title of the chat a chat file starts (owner, 2026-11-01): never a branch file's name. A
 * file's name is no name of a fork, which only the user gives here, nor of the chat: the
 * family's root is the file, or, for a branch whose parent chat wasn't imported, the main chat
 * its header names, without the branch suffix ST adds; a name ST made up for a branch says
 * nothing and goes. A stamp-only group chat uses its renamed group's name or, for ST's
 * default group name, its cast's names. Its stamp is normalized for `chatName`, which shows
 * the chat's createdAt, just as for character chats. A user-named file keeps that name.
 */
export const stChatTitle = (
  fileName: string,
  mainChat: string | null,
  group: string | null,
  members: ReadonlyArray<string | null> = []
): string => {
  let root = cleanName(mainChat ?? fileName)
  while (FORK_SUFFIX.test(root)) root = root.replace(FORK_SUFFIX, "")
  if (AUTOMATIC_FORK.test(root)) root = ""
  if (group !== null) {
    const name = defaultGroupName(group, members) ? "" : group
    if (root === "") return name
    if (GROUP_STAMP.test(root)) {
      // Older ST group files omit milliseconds. Keep the same internal stamp format as
      // character chats so every existing title surface substitutes createdAt for it.
      const stamp = /ms$/u.test(root) ? root : `${root}000ms`
      return name === "" ? stamp : `${name}: ${stamp}`
    }
  }
  return root
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

export interface CardInfo {
  readonly entityId: EntityId
  readonly label: string
  /** The card file's name without its extension, which names its chats' folder. */
  readonly file: string | null
  readonly name: string
  readonly greetings: ReadonlyArray<string>
  readonly world: string | null
  /**
   * It carries its own lorebook. ST never sends that copy: only a lorebook file named by
   * `world`, which its "Import Card Lore" dialog makes from it. So the import turns the
   * card's own book off in a chat unless that file is in the folder.
   */
  readonly book: boolean
  /** Its Character Author's Note from ST's settings, when the import made one and ST applies it. */
  readonly characterNote?: EntityId | null
  /** The chat file ST opens it on (the card's `chat`), without `.jsonl`: the one last opened. */
  readonly lastChat?: string | null
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
  /** A persona card's note placed at the author's note's top or bottom, as ST placed its description. */
  readonly personaNotes?: ReadonlyMap<string, EntityId>
  /** Personas' avatar files by name. */
  readonly personaNames: ReadonlyMap<string, ReadonlyArray<string>>
  /** Lorebooks by name. */
  readonly worlds: ReadonlyMap<string, RefId>
  /** Lorebooks with entries at the author's note's top or bottom, by ref: placed where ST's default author's note is. */
  readonly anLorebooks?: ReadonlySet<string>
  /** An enabled prompt of the preset ST used holds `{{summary}}`, so ST sent the summary through it. */
  readonly summaryMacro?: boolean
}

/** What an import made of a chat file's state, kept in its record to tell what changed. */
export interface ChatState {
  readonly participants: ReadonlyArray<string>
  readonly lorebooks: ReadonlyArray<string>
  readonly lorebookBindings?: Readonly<Record<string, string>>
  /** Cards whose own lorebook the chat has off, as ST didn't send it. */
  readonly embeddedOff?: ReadonlyArray<string>
  readonly played: ReadonlyArray<string>
  /** Each variable's value, hashed. */
  readonly vars: Readonly<Record<string, string>>
  readonly authorNote: string | null
  readonly summary: string | null
  /** Character Author's Notes a group chat switched off, as ST ignores them there. */
  readonly characterNotesOff?: ReadonlyArray<string>
  /** A group chat's reply order (`reply.order`); absent is the default, natural order. */
  readonly replyOrder?: string
  /**
   * Personas who spoke here but aren't selected: joined for their messages and then left, so
   * the user plays them and the model never does. Absent when there are none.
   */
  readonly otherPersonas?: ReadonlyArray<string>
}

/** Where ST put an extension prompt (`extension_prompt_types`), as a note's placement. */
const placementOf = (position: number, depth: number, role: number): NoteDoc["placement"] =>
  position === -1
    ? { mode: "none" }
    : position === 0
      ? { mode: "section", section: "after_main_prompt", role: stRole(role) }
      : position === 2
        ? { mode: "section", section: "before_main_prompt", role: stRole(role) }
        : { mode: "depth", depth: noteDepth(depth), role: stRole(role) }

/**
 * Where what ST placed at the top or bottom of its author's note goes here, kept (owner,
 * 2026-11-01): the concrete place of the folder's default author's note, ST's own default
 * (in the chat at depth 4 as the system) without one. A note goes there, at its depth and role
 * or beside the main prompt where the author's note was; a lorebook entry, which has no place
 * beside the main prompt, at its depth and role. Personas, characters' own author's notes and
 * lorebooks are the library's, used by every chat, so each has one place: a chat that had one
 * of them at its own author's note, while that note was elsewhere, gets a warning
 * (`st.author_note_riders`, `ridersElsewhere`).
 */
export const authorNotePlace = (note: StAuthorNote | null) => ({
  note: placementOf(note === null || note.position === -1 ? 1 : note.position, note?.depth ?? 4, note?.role ?? 0),
  lore: { depth: noteDepth(note?.depth ?? 4), role: stRole(note?.role ?? 0) }
})

/** A note's placement in words, for the report: "depth 2 as system", "after the main prompt as user". */
const placeText = (placement: NoteDoc["placement"]): string =>
  placement.mode === "depth"
    ? `depth ${placement.depth} as ${placement.role}`
    : placement.mode === "section"
      ? `${placement.section === "before_main_prompt" ? "before" : "after"} the main prompt as ${placement.role}`
      : "not sent"

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
  // The character's name in the chat: a card whose file was renamed (or downloaded again
  // as "name (1)") still has it.
  const names = new Set(speakers.flatMap((s) => (!s.user && s.name.trim() !== "" ? [s.name.trim()] : [])))
  const bySpeaker = one(
    all.filter((card) => names.has(card.name.trim())),
    `Several cards are named “${shownText([...names].join("”, “"))}”.`
  )
  if (bySpeaker) return bySpeaker
  if (greeting !== null) {
    const byGreeting = one(
      all.filter((card) => card.greetings.some((g) => greetingMatches(g, card.name, greeting))),
      "Several cards have this chat's greeting."
    )
    if (byGreeting) return byGreeting
  }
  const who = names.size === 0 ? "" : ` or is named “${shownText([...names].join("”, “"))}”`
  // ST saves a chat under "undefined" when no character was selected.
  return {
    choices: [],
    reason:
      folder === "undefined"
        ? `ST saved this chat without a character (in the folder “undefined”), and no card in the folder${who === "" ? " matches it" : who.replace(" or", "")}.`
        : `No card in the folder has the file name “${shownText(folder)}”${who}. ST's card for this chat may have been deleted or renamed.`
  }
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
        (byName.length === 1 ? folder.personas.get(byName[0]!)! : undefined) ??
        defaultPersona(folder, header)
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

/** Before any user message, prefer the chat's lock, then ST's default persona. */
export const defaultPersona = (folder: FolderContext, header: StChatHeader | null): EntityId | null =>
  (header?.persona ? folder.personas.get(header.persona) : undefined) ??
  (folder.settings?.defaultPersona ? folder.personas.get(folder.settings.defaultPersona) : undefined) ??
  null

/** The chat's participants, lorebooks and variables as the file has them. */
const membership = (
  folder: FolderContext,
  link: Link,
  header: StChatHeader | null,
  spoke: ReadonlySet<EntityId>,
  selectedPersona: EntityId | null
) => {
  const participants: Array<string> = []
  const absent: Array<string> = []
  const worlds: Array<string> = []
  const lorebookBindings: Record<string, string> = {}
  // Cards whose own book ST never imported as a file: ST didn't send it, so it's off.
  const embeddedOff: Array<string> = []
  // Their world is that book's name in the card maker's ST: not missing from the user's.
  const embedded = new Set<string>()
  const primary = (card: CardInfo) => {
    if (card.book && !(card.world && folder.worlds.has(card.world))) embeddedOff.push(card.entityId)
    if (!card.world) return
    if (card.book && !folder.worlds.has(card.world)) embedded.add(card.world)
    worlds.push(card.world)
    const ref = folder.worlds.get(card.world)
    if (ref) lorebookBindings[card.entityId] = ref
  }
  const group = link.group
  if (group !== null) {
    for (const member of group.members) {
      const card = folder.cards.get(stem(member))
      if (card === undefined) continue
      participants.push(card.entityId)
      if (group.disabledMembers.includes(member)) absent.push(card.entityId)
      primary(card)
    }
  } else if (link.card !== null) {
    participants.push(link.card.entityId)
    primary(link.card)
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
    if (ref !== undefined) lorebooks.push(ref)
    else if (!embedded.has(name)) missingWorlds.push(name)
  }
  const played = selectedPersona === null ? [] : [selectedPersona]
  // The user plays every persona who spoke (DESIGN §2.2), but only the selected one stays in
  // the cast. The others join for their messages and then leave, as a persona switched away
  // from in a chat leaves it (the Cast tab's persona control): none is ever a character.
  const otherPersonas = [...spoke].filter((p) => !participants.includes(p) && !played.includes(p))
  return {
    participants: [...participants, ...played.filter((p) => !participants.includes(p))],
    otherPersonas,
    absent,
    played,
    lorebooks,
    missingWorlds,
    lorebookBindings,
    embeddedOff,
    vars: JSON.parse(header?.variablesJson ?? "[]") as Array<[string, unknown]>
  }
}

/** The author's note: the chat's own, or the default ST gives a chat without one. */
const authorNoteOf = (folder: FolderContext, header: StChatHeader | null): StImportNote | null => {
  const note = header?.authorNote ?? folder.settings?.defaultAuthorNote ?? null
  if (note === null) return null
  return {
    kind: "author_note",
    title: "Author's Note",
    contents: [note.content],
    placement: placementOf(note.position === -1 ? 1 : note.position, note.depth, note.role),
    ...(folder.settings?.allowWIScan ? { scanLore: true } : {}),
    // On only if ST sent it: it has text and its frequency isn't 0 (DESIGN §4.1). No
    // frequency is kept: a note goes every turn. An empty one is kept, off, as what rides
    // on the author's note goes where it is.
    activate: note.content.trim() !== "" && note.interval !== 0
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
  summaries: ReadonlyArray<{ readonly index: number; readonly text: string; readonly slot?: SlotId | undefined }>,
  messages: number,
  run: HiddenRun
) => {
  const usable = summaries.filter((s) => s.index < messages - 1)
  const current = usable.at(-1)
  if (current === undefined) return null
  const history: Array<string> = [current.text]
  // Where each text was saved: the earliest of a run of the same text, which ST would find
  // on any path through it.
  const sources: Array<SlotId | null> = [current.slot ?? null]
  let chars = 0
  let trimmed = false
  for (const summary of usable.toReversed()) {
    if (summary.text === history[0]) {
      sources[0] = summary.slot ?? null
      continue
    }
    if (history.length >= MAX_SUMMARY_REVISIONS || chars + summary.text.length > MAX_SUMMARY_HISTORY_CHARS) {
      trimmed = true
      break
    }
    history.unshift(summary.text)
    sources.unshift(summary.slot ?? null)
    chars += summary.text.length
  }
  const { position, depth, role, template, enabled } = folder.settings?.summary ?? DEFAULT_SUMMARY_SETTINGS
  // ST 1.19 sends the summary only while the extension is enabled (a disabled extension isn't
  // loaded, so neither its injection nor its macro exists): injected unless its position is
  // None (-1), and through `{{summary}}` wherever the preset holds it. The note is on exactly
  // when ST sent it; one sent only through the macro isn't placed as well.
  const sent = enabled && (position !== -1 || folder.summaryMacro === true)
  const covers =
    run.length >= HIDDEN_RUN_MIN &&
    run.firstSlot !== null &&
    run.throughSlot !== null &&
    current.index >= run.length - 1
      ? { first_slot_id: run.firstSlot, last_slot_id: run.throughSlot, slot_count: run.length }
      : undefined
  const note: StImportNote = {
    kind: "imported_summary",
    title: "Summary (from ST)",
    contents: history as [string, ...Array<string>],
    ...(sources.some((s) => s !== null) ? { sources } : {}),
    placement: enabled ? placementOf(position, depth, role) : { mode: "none" },
    template,
    ...(covers ? { covers } : {}),
    activate: sent
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
    readonly selectedPersona?: EntityId | null
    readonly summaries: ReadonlyArray<{
      readonly index: number
      readonly text: string
      readonly slot?: SlotId | undefined
    }>
    readonly messages: number
    readonly run: HiddenRun
  },
  previous: ChatState | null,
  /** A new chat takes all of it; a chat merged into gets only what changed. */
  isNew: boolean,
  /**
   * A branch's first import: `previous` is the state in effect where it leaves its parent
   * (StImports.ts `inheritedState`), or, for a parent recorded before that was kept, the
   * parent's at its own end. Who the user plays is then written whatever it says.
   */
  inherited = false
) => {
  const personasBefore = inherited ? null : previous
  const mapped = membership(
    folder,
    file.link,
    file.header,
    file.spoke,
    file.selectedPersona === undefined
      ? ([...file.spoke].at(-1) ?? defaultPersona(folder, file.header))
      : file.selectedPersona
  )
  const authorNote = authorNoteOf(folder, file.header)
  const summary = summaryOf(folder, file.summaries, file.messages, file.run)
  const state: { -readonly [K in keyof ChatState]: ChatState[K] } = {
    participants: mapped.participants,
    lorebooks: mapped.lorebooks,
    lorebookBindings: mapped.lorebookBindings,
    embeddedOff: mapped.embeddedOff,
    played: mapped.played,
    vars: Object.fromEntries(mapped.vars.map(([name, value]) => [name, hash(JSON.stringify(value))])),
    authorNote: authorNote && hash(JSON.stringify(authorNote)),
    // As the confirmed re-import takes it again once the note names its slots (stImportProgress.ts).
    summary: summary && stStateHash(summary.note)
  }
  if (mapped.otherPersonas.length > 0) state.otherPersonas = mapped.otherPersonas
  const events: Array<StateEventData> = []
  for (const entity of mapped.participants) {
    const persona = (mapped.played as ReadonlyArray<string>).includes(entity)
    if (!(persona ? personasBefore : previous)?.participants.includes(entity)) {
      events.push({ key: "participant.join", value: { entity: entity as EntityId } })
    }
  }
  // The other personas join once, so their messages keep their names and faces, unless an
  // earlier import of this chat already joined them.
  for (const entity of mapped.otherPersonas) {
    if (!personasBefore?.participants.includes(entity) && !personasBefore?.otherPersonas?.includes(entity))
      events.push({ key: "participant.join", value: { entity: entity as EntityId } })
  }
  if (isNew) {
    for (const entity of mapped.absent) {
      events.push({ key: "presence.set", value: { entity: entity as EntityId, present: false } })
    }
  }
  if (inherited || JSON.stringify(previous?.played ?? []) !== JSON.stringify(mapped.played)) {
    events.push({ key: "played_by_me.set", value: { entities: mapped.played as Array<EntityId> } })
  }
  // Then leave, as after a persona switch: played by the user, never a character.
  for (const entity of mapped.otherPersonas) {
    if (!personasBefore?.otherPersonas?.includes(entity))
      events.push({ key: "participant.leave", value: { entity: entity as EntityId } })
  }
  // A persona selected before that this file neither selects nor has speak (a branch that
  // leaves its parent before the parent's switch to it) leaves too: it's no one's character.
  for (const entity of previous?.played ?? []) {
    if (!mapped.participants.includes(entity) && !mapped.otherPersonas.includes(entity as EntityId))
      events.push({ key: "participant.leave", value: { entity: entity as EntityId } })
  }
  for (const entity of new Set([
    ...Object.keys(mapped.lorebookBindings),
    ...Object.keys(previous?.lorebookBindings ?? {})
  ])) {
    const ref = mapped.lorebookBindings[entity] ?? null
    if (ref !== (previous?.lorebookBindings?.[entity] ?? null))
      events.push({ key: "lorebook.binding", value: { entity: entity as EntityId, ref: ref as RefId | null } })
  }
  // Off where ST didn't send the card's book; back on if a re-import finds its file now.
  for (const entity of mapped.embeddedOff) {
    if (!previous?.embeddedOff?.includes(entity))
      events.push({ key: "lorebook.embedded", value: { entity: entity as EntityId, on: false } })
  }
  for (const entity of previous?.embeddedOff ?? []) {
    if (!mapped.embeddedOff.includes(entity))
      events.push({ key: "lorebook.embedded", value: { entity: entity as EntityId, on: true } })
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
  // The group's reply strategy, for its chats (ST's `activation_strategy`): only when it isn't
  // the default, or changed since the last import.
  const replyOrder = file.link.group?.replyOrder ?? "natural"
  if (replyOrder !== "natural") state.replyOrder = replyOrder
  if (replyOrder !== (previous?.replyOrder ?? "natural")) events.push({ key: "reply.order", value: replyOrder })
  // ST applies a card's own author's note only in one-to-one chats: a group chat has it off.
  const byEntity = new Map([...folder.cards.values()].map((card) => [card.entityId as string, card]))
  const characterNotesOff = file.link.group
    ? mapped.participants.flatMap((entity) => {
        const note = byEntity.get(entity)?.characterNote
        return note ? [note] : []
      })
    : []
  for (const note of characterNotesOff) {
    if (!previous?.characterNotesOff?.includes(note)) events.push({ key: "note.deactivate", value: { note } })
  }
  // ST sends nothing at the author's note's top or bottom while it's disabled (frequency 0,
  // `setFloatingPrompt`): there the persona's and the card's notes placed on it are switched
  // off in this chat. An empty note that's due still carries them, as in ST.
  const disabled = (file.header?.authorNote ?? folder.settings?.defaultAuthorNote ?? null)?.interval
  const ridersOff =
    disabled !== undefined && disabled <= 0
      ? [
          ...mapped.played.flatMap((entity) => {
            const note = folder.personaNotes?.get(entity)
            return note ? [note] : []
          }),
          ...(file.link.group ? [] : [file.link.card?.characterNote ?? null]).flatMap((note) =>
            note && !characterNotesOff.includes(note) ? [note] : []
          )
        ]
      : []
  for (const note of ridersOff) {
    if (!previous?.characterNotesOff?.includes(note)) events.push({ key: "note.deactivate", value: { note } })
  }
  if (characterNotesOff.length + ridersOff.length > 0) state.characterNotesOff = [...characterNotesOff, ...ridersOff]
  // ST would have sent the character's note in place of the chat's own, which isn't empty.
  const chara = file.link.group ? null : (file.link.card?.file ?? null)
  const replacing = folder.settings?.characterNotes.find((n) => n.card === chara && n.useChara && n.position === 0)
  const replacedAuthorNote = replacing !== undefined && (file.header?.authorNote?.content.trim() ?? "") !== ""
  // What ST put at this chat's own author's note went where the default one is. Only what
  // rode on this chat's note counts (ST's `setFloatingPrompt`, `addPersonaDescriptionExtensionPrompt`,
  // `checkWorldInfo`): nothing while the note is off (frequency 0), the persona played here when
  // it's placed at the note, the card's own note in a one-to-one chat where ST applies it, and the
  // books this chat uses (its own, its cards', ST's global ones) with entries at the note.
  const defaultPlace = authorNotePlace(folder.settings?.defaultAuthorNote ?? null)
  const due = disabled === undefined || disabled > 0
  const personaName = (entity: string) => {
    for (const [avatar, id] of folder.personas) {
      if (id === entity) return folder.settings?.personas.find((p) => p.avatar === avatar)?.name ?? avatar
    }
    return ""
  }
  const bookName = (ref: string) => {
    for (const [name, id] of folder.worlds) if (id === ref) return name
    return ""
  }
  const globalRefs = (folder.settings?.globalWorlds ?? []).flatMap((name) => {
    const ref = folder.worlds.get(name)
    return ref === undefined ? [] : [ref]
  })
  const riding =
    !due || authorNote === null
      ? []
      : [
          ...mapped.played.flatMap((entity) =>
            folder.personaNotes?.has(entity) ? [`the persona ${shownText(personaName(entity))}'s description`] : []
          ),
          ...(!file.link.group && (file.link.card?.characterNote ?? null) !== null
            ? [`${shownText(file.link.card!.name)}'s own author's note`]
            : []),
          ...[...new Set([...mapped.lorebooks, ...globalRefs])].flatMap((ref) =>
            folder.anLorebooks?.has(ref) ? [`the lorebook “${shownText(bookName(ref))}”'s entries at the note`] : []
          )
        ]
  const ridersElsewhere =
    riding.length > 0 && JSON.stringify(authorNote!.placement) !== JSON.stringify(defaultPlace.note)
      ? `${riding.join("; ")}. This chat's note: ${placeText(authorNote!.placement)}; the default's: ${placeText(defaultPlace.note)}.`
      : null
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
    summaryTrimmed: summary?.trimmed ?? false,
    replacedAuthorNote,
    ridersElsewhere
  }
}
