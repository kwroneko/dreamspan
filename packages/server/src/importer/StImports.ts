// The ST data folder import (DESIGN §1.4, DATA-MODEL §14, ARCHITECTURE.md §13), on the
// main thread: one import per user at a time, fed one file (or chat part) at a time by the
// client in the order of `ST_FILE_ORDER`. Every file is parsed in a format worker and
// stored through the writer. This keeps what links chats to cards and what earlier imports
// recorded, and drives each chat through its record; what a chat means is stMapping.ts.
//
// A chat file's record (a `jobs` row) is what makes a re-run safe. It's written with the
// chat's first messages, as `processing`, and keeps whether the file went into another
// file's chat (`merged`) and the first slot it added; when its last part is in, it's
// marked complete with the chat state it mapped and the file's last slot (`end`). A run
// that finds a record goes on from it: an unfinished one is finished as the run that
// started it would have, a complete one takes only what's new.
import { summaryMacroPrompts } from "@rp/shared/lcmSettings.ts"
import type { PresetDoc } from "@rp/shared/docs/preset.ts"
import type { ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import type { User } from "@rp/shared/domain.ts"
import { NotFound, ServerError } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { shownList, shownText } from "@rp/shared/importReport.ts"
import type { EntityKind, RefId } from "@rp/shared/library.ts"
import { classifyStPath, type StFile, stParentPath } from "@rp/shared/stFolder.ts"
import { StFileResult, StHiddenRun, type StImportReport, StIssue, StLinkChoice } from "@rp/shared/stImportApi.ts"
import { createHash } from "node:crypto"
import { lstat, rm } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Formats } from "./Formats.ts"
import { MediaHolds } from "./MediaHolds.ts"
import { storeMedia } from "./mediaFiles.ts"
import type { ParsedFile, StChatHeader, StPersona, StSettings, StSpeaker } from "./ops.ts"
import { Report } from "./stReport.ts"
import {
  type CardInfo,
  chatStateChange,
  type ChatState,
  type FolderContext,
  HIDDEN_RUN_MIN,
  type Link,
  linkChat,
  speakerMap,
  stem,
  stForkName
} from "./stMapping.ts"

const IDLE_MS = 60 * 60_000
/**
 * What one import may hold about the folder in memory: cards' names and greetings, groups,
 * personas, and the summaries of the chat being read. Past it, files that would add more
 * are refused for this run. The heap holds about three times this: about 50 MB, for an hour.
 */
const MAX_HELD_CHARS = 16 * 1024 * 1024

/**
 * Earlier versions of the import kept a chat's messages in `DATA_DIR/st-staging` until its
 * first user message. Nothing writes there now; at startup the folder goes, once, unless
 * it's a link: then it's left alone, with a warning, rather than followed.
 */
export const removeOldStaging = (dataDir: string) =>
  Effect.tryPromise(async () => {
    const path = join(dataDir, "st-staging")
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (stat === null) return "absent"
    if (!stat.isDirectory()) return "not a folder"
    // `rm` removes links inside the folder without following them.
    await rm(path, { recursive: true })
    return "removed"
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome === "not a folder"
        ? Effect.logWarning("DATA_DIR/st-staging isn't a folder (a link?), so it was left alone")
        : Effect.void
    ),
    Effect.catch((error) => Effect.logWarning("removing DATA_DIR/st-staging failed", error))
  )

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

/** What a chat request names besides its path. */
export interface ChatRequest {
  readonly createdAt?: number
  readonly part: number
  /** The file's last part: the client needn't know how many parts it has. */
  readonly last: boolean
  /** The user's answer to a link choice: one of their cards, or none. */
  readonly card: EntityId | "none" | null
  /** A branch sent again after the rest: import it on its own if its parent never came. */
  readonly orphan: boolean
}

interface LibraryEntry {
  readonly refId: RefId
  readonly entityId: EntityId
  readonly kind: EntityKind
  readonly label: string
  readonly sourceHash: string | null
  readonly binned: boolean
}

/** A chat file's record, as the session knows it. */
interface ChatRecord {
  readonly recordId: string
  readonly chatId: ChatId
  readonly complete: boolean
  readonly binned: boolean
  /** It went into another file's chat: a branch. */
  readonly merged: boolean
  readonly state: ChatState | null
  readonly notes: Readonly<Record<string, EntityId>>
  readonly end: SlotId | null
  readonly firstAdded: SlotId | null
}

/** Where a chat's messages go: its chat and record, once it has them. */
interface Target {
  readonly chatId: ChatId
  readonly recordId: string
}

interface Batch {
  readonly messagesJson: string
  readonly speakers: ReadonlyArray<string>
}

interface ChatProgress {
  readonly path: string
  readonly countAs: "chat" | "group_chat"
  nextPart: number
  readonly title: string
  readonly header: StChatHeader | null
  readonly link: Link
  /** Null until the chat has a user message (or is too long to be greeting-only). */
  target: Target | null
  /** The chat it merges into, for a branch's first import. */
  readonly into: ChatId | null
  readonly isNew: boolean
  readonly branch: boolean
  /** A branch's name from ST, and its parent file's record, where the name goes. */
  readonly fork: { readonly name: string | null; readonly parentRecordId: string } | null
  readonly prevState: ChatState | null
  readonly prevNotes: Readonly<Record<string, EntityId>>
  /** Where the file ended when last imported, and the first slot an unfinished run added. */
  readonly prevEnd: SlotId | null
  readonly resumeAt: SlotId | null
  matching: boolean
  cursor: SlotId | null
  /** The first slot this run added, and the first past `prevEnd` on this run's path. */
  firstAdded: SlotId | null
  afterEnd: SlotId | null
  atEnd: boolean
  firstSlot: SlotId | null
  /** Messages read, and messages written. */
  index: number
  written: number
  lastAt: number | null
  lastMessageAt: number | null
  userTurns: number
  /**
   * The chat's first message, held back until a second one comes or the file ends: a chat
   * of one message, not a user's, is a greeting-only chat, and is skipped (DESIGN §1.4).
   */
  readonly pending: Array<{ readonly batch: Batch; readonly speakers: ReadonlyMap<string, EntityId | null> }>
  /** Whether it's more than a greeting-only chat, so its messages go in as they come. */
  decided: boolean
  hiddenRun: number
  runOpen: boolean
  throughSlot: SlotId | null
  /** Each with the slot of the message it was saved on, once that message is written. */
  readonly summaries: Array<{ index: number; text: string; slot?: SlotId }>
  /** The budget the summaries hold, given back when the chat is done. */
  summaryChars: number
  readonly spoke: Set<EntityId>
  readonly partHashes: Array<string>
  added: number
  updated: number
  differing: number
}

interface Session extends FolderContext {
  readonly id: string
  touched: number
  readonly report: Report
  settings: StSettings | null
  summaryMacro: boolean
  personaNames: Map<string, ReadonlyArray<string>>
  /** Characters held, against MAX_HELD_CHARS, and the settings' share of them. */
  held: number
  settingsHeld: number
  readonly personas: Map<string, EntityId>
  readonly personaNotes: Map<string, EntityId>
  readonly cards: Map<string, CardInfo>
  readonly worlds: Map<string, RefId>
  /** Groups by each of their chats' ids. */
  readonly groups: Map<string, StGroup>
  readonly library: Map<string, LibraryEntry>
  readonly libraryByHash: Map<string, LibraryEntry>
  readonly records: Map<string, ChatRecord>
  /** Lorebooks already reported missing: once per import, not once per chat naming them. */
  readonly missingWorlds: Set<string>
  chat: ChatProgress | null
}

type StGroup = NonNullable<Link["group"]>

/** Storing a file failed on the server, not because of the file; the error is logged. */
export class StImportFailed extends Schema.TaggedError<StImportFailed>()("StImportFailed", {}) {
  override get message() {
    return "The import failed on the server; try again."
  }
}

const result = (outcome: StFileResult["outcome"], message = "") => new StFileResult({ outcome, message })

export class StImports extends Context.Service<
  StImports,
  {
    readonly start: (user: User, unsupported: ReadonlyArray<string>) => Effect.Effect<string, ServerError>
    readonly report: (user: User, importId: string) => Effect.Effect<StImportReport, NotFound>
    /** One uploaded file, or one part of a chat file. */
    readonly file: (
      user: User,
      importId: string,
      path: string,
      bytes: Uint8Array,
      chat: ChatRequest
    ) => Effect.Effect<StFileResult, NotFound | StImportFailed>
    readonly unhidden: (user: User, chatId: ChatId) => void
    readonly exists: (user: User, importId: string) => boolean
  }
>()("rp/importer/StImports") {
  static readonly layer = Layer.effect(
    StImports,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const formats = yield* Formats
      const reader = yield* Reader
      const writer = yield* Writer
      const { holding } = yield* MediaHolds
      const hub = yield* ChatHub
      const sessions = new Map<string, Session>()

      yield* removeOldStaging(config.dataDir)

      const sessionOf = (user: User, importId: string) => {
        const session = sessions.get(user.id)
        if (session === undefined || session.id !== importId || Date.now() - session.touched > IDLE_MS) {
          return Effect.fail(new NotFound({ entity: "import", id: importId }))
        }
        session.touched = Date.now()
        return Effect.succeed(session)
      }

      const start = (user: User, unsupported: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const sources = yield* reader.StImportSources({ userId: user.id })
          const session: Session = {
            id: uuidv7(),
            touched: Date.now(),
            report: new Report(),
            settings: null,
            summaryMacro: false,
            personaNames: new Map(),
            held: 0,
            settingsHeld: 0,
            personas: new Map(),
            personaNotes: new Map(),
            cards: new Map(),
            worlds: new Map(),
            groups: new Map(),
            library: new Map(),
            libraryByHash: new Map(),
            records: new Map(),
            missingWorlds: new Set(),
            chat: null
          }
          for (const entry of sources.library) {
            session.library.set(entry.sourcePath, entry)
            if (entry.sourceHash !== null && !entry.binned) {
              session.libraryByHash.set(`${entry.kind}:${entry.sourceHash}`, entry)
            }
          }
          for (const record of sources.chats) {
            session.records.set(record.source, {
              ...record,
              state: JSON.parse(record.stateJson) as ChatState | null
            })
          }
          // Chats an earlier import didn't finish: sending the folder again finishes them.
          for (const [source, record] of session.records) {
            if (!record.complete && !record.binned) {
              session.report.issue(
                source,
                "warning",
                "st.unfinished",
                "An earlier import of this chat didn't finish; it's in your chats as it was left, and importing the folder again finishes it."
              )
            }
          }
          for (const path of unsupported) {
            const file = classifyStPath(path)
            if (file?.kind === "unsupported") {
              session.report.unsupported.set(file.what, (session.report.unsupported.get(file.what) ?? 0) + 1)
            }
          }
          // Every run before it is over: none of them writes any more (ARCHITECTURE.md §13).
          yield* writer.StImportBegin({ userId: user.id, importId: session.id })
          sessions.set(user.id, session)
          return session.id
        })

      /** Takes `chars` of the import's budget, or reports the file as one too many. */
      const hold = (session: Session, path: string, countAs: string, chars: number) => {
        if (session.held + chars <= MAX_HELD_CHARS) {
          session.held += chars
          return true
        }
        session.report.count(countAs, "failed")
        session.report.issue(
          path,
          "error",
          "st.too_much",
          "This import holds as much about the folder as it can; import the rest of it in another run."
        )
        return false
      }

      // --- Library files: cards, personas, lorebooks, presets.

      /** A parsed library file into the library, or found there from an earlier import. */
      const importLibrary = (
        session: Session,
        user: User,
        path: string,
        countAs: string,
        parsed: ParsedFile,
        createdAt?: number
      ) =>
        Effect.gen(function* () {
          const { report } = session
          report.file(path, parsed.report)
          const library = parsed.library
          if (library === null) {
            report.count(countAs, "failed")
            const error = parsed.report.issues.find((i) => i.level === "error")
            return { outcome: result("failed", error?.message ?? ""), entity: null, created: false, note: null }
          }
          const earlier = session.library.get(path)
          if (earlier?.binned) {
            report.count(countAs, "skipped")
            report.issue(
              path,
              "info",
              "st.in_bin",
              "An earlier import of this file is in your recycle bin, so it wasn't imported again."
            )
            return { outcome: result("skipped", "in the recycle bin"), entity: null, created: false, note: null }
          }
          const same = earlier ?? session.libraryByHash.get(`${library.kind}:${parsed.sha256}`)
          if (same !== undefined && same.kind === library.kind && same.sourceHash === parsed.sha256) {
            report.count(countAs, "unchanged")
            return { outcome: result("unchanged"), entity: same, created: false, note: null }
          }
          const imported = yield* holding(
            parsed.media.map((file) => file.sha256),
            Effect.gen(function* () {
              yield* Effect.forEach(parsed.media, (file) => storeMedia(config.dataDir, file.sha256, file.bytes), {
                discard: true
              })
              return yield* writer.ImportFile({
                userId: user.id,
                intoRefId: earlier?.refId ?? null,
                ...(createdAt === undefined ? {} : { createdAt }),
                ...library,
                sourceName: path,
                sourceHash: parsed.sha256,
                media: parsed.media.map(({ bytes: _, ...file }) => file),
                // ST scans its notes for lorebook entries, the Character's Note included.
                ...(session.settings?.allowWIScan ? { characterNoteScan: true } : {})
              })
            })
          ).pipe(
            Effect.catchTags({
              NotFound: () => Effect.succeed(null),
              RefOperationRefused: (error) => {
                report.issue(path, "error", "st.not_updated", error.reason)
                return Effect.succeed(null)
              }
            })
          )
          if (imported === null) {
            report.count(countAs, "failed")
            return { outcome: result("failed", "it couldn't be stored"), entity: null, created: false, note: null }
          }
          const entry: LibraryEntry = {
            refId: imported.ref.id,
            entityId: imported.ref.entityId,
            kind: imported.ref.kind,
            label: imported.ref.label,
            sourceHash: parsed.sha256,
            binned: false
          }
          session.library.set(path, entry)
          session.libraryByHash.set(`${entry.kind}:${parsed.sha256}`, entry)
          report.count(countAs, imported.created ? "added" : "updated")
          if (imported.outcome === "conflicts") {
            report.issue(
              path,
              "warning",
              "st.conflicts",
              "Your edits conflict with this version; resolve them in the library."
            )
          }
          return {
            outcome: result(imported.created ? "added" : "updated"),
            entity: entry,
            created: imported.created,
            note: imported.note?.entityId ?? null
          }
        })

      const personaFile = (session: Session, user: User, path: string, file: string, bytes: Uint8Array) =>
        Effect.gen(function* () {
          const persona: StPersona | null = session.settings?.personas.find((p) => p.avatar === file) ?? null
          const parsed = yield* formats.st.persona(bytes, file, persona)
          const imported = yield* importLibrary(session, user, path, "persona", parsed)
          if (imported.entity === null) return imported.outcome
          // Only a new card goes into the persona folder: the user may have refiled it since.
          if (imported.created) {
            yield* writer.SetEntityTags({ userId: user.id, entityId: imported.entity.entityId, tags: ["persona"] })
          }
          session.personas.set(file, imported.entity.entityId)
          // At the author's note's top or bottom: switched off in chats whose author's note ST disabled.
          if (persona !== null && (persona.position === 2 || persona.position === 3) && imported.note !== null)
            session.personaNotes.set(imported.entity.entityId, imported.note)
          if (persona !== null && persona.position === 9) {
            session.report.issue(
              path,
              "info",
              "st.persona_unsent",
              "ST doesn't send this persona's description; its note says so."
            )
          }
          return imported.outcome
        })

      /**
       * The card's Character Author's Note from ST's settings (`note.chara`, by the card's
       * avatar file name), as a private card note (DESIGN §4.1); an empty one isn't imported.
       * Its entity when ST applies it (`useChara`), which a group chat then switches off.
       */
      const characterAuthorNote = (session: Session, user: User, path: string, name: string, card: EntityId) =>
        Effect.gen(function* () {
          const settings = session.settings
          const chara = settings?.characterNotes.find((note) => note.card === name)
          if (!settings || !chara || chara.prompt.trim() === "") return null
          const imported = yield* writer
            .StImportCharacterNote({
              userId: user.id,
              cardEntityId: card,
              prompt: chara.prompt,
              useChara: chara.useChara,
              position: chara.position,
              scanLore: settings.allowWIScan,
              sourcePath: path
            })
            .pipe(
              Effect.catchTags({
                NotFound: () => Effect.succeed(null),
                RefOperationRefused: (error) => {
                  session.report.issue(path, "error", "st.not_updated", error.reason)
                  return Effect.succeed(null)
                }
              })
            )
          session.report.count("character_note", imported === null ? "failed" : imported.created ? "added" : "updated")
          return imported !== null && chara.useChara ? imported.entity : null
        })

      const cardFile = (session: Session, user: User, path: string, file: string, bytes: Uint8Array, ctime?: number) =>
        Effect.gen(function* () {
          const parsed = yield* formats.st.libraryFile(bytes, file, "card")
          const card = parsed.card
          const size = card === null ? 0 : card.name.length + card.greetings.reduce((sum, g) => sum + g.length, 0)
          if (!hold(session, path, "card", size + file.length)) return result("failed", "too much in one import")
          const imported = yield* importLibrary(
            session,
            user,
            path,
            "card",
            parsed.parsed,
            Math.trunc(parsed.parsed.stCreatedAt ?? ctime ?? Date.now())
          )
          if (imported.entity !== null && card !== null) {
            const characterNote = yield* characterAuthorNote(session, user, path, stem(file), imported.entity.entityId)
            session.cards.set(stem(file), {
              ...card,
              entityId: imported.entity.entityId,
              label: imported.entity.label,
              file: stem(file),
              characterNote
            })
          }
          return imported.outcome
        })

      const libraryFile = (
        session: Session,
        user: User,
        path: string,
        file: string,
        bytes: Uint8Array,
        kind: "lorebook" | "preset",
        name: string
      ) =>
        Effect.gen(function* () {
          const parsed = yield* formats.st.libraryFile(bytes, file, kind)
          const imported = yield* importLibrary(session, user, path, kind, parsed.parsed)
          if (imported.entity !== null && kind === "lorebook") {
            session.worlds.set(name, imported.entity.refId)
            // ST applies its global books to every chat: here they're the user's global lorebooks.
            if (session.settings?.globalWorlds.includes(name))
              yield* writer.SetGlobalLorebook({ userId: user.id, ref: imported.entity.refId, global: true })
          }
          // Whether ST sent the summary through `{{summary}}` in the preset it used (DESIGN §8 [P]).
          if (parsed.parsed.library && kind === "preset" && session.settings?.selectedPreset === name)
            session.summaryMacro =
              summaryMacroPrompts(JSON.parse(parsed.parsed.library.docJson) as PresetDoc).length > 0
          if (imported.entity !== null && kind === "preset" && session.settings?.selectedPreset === name) {
            const adopted = yield* writer.StImportDefaultPreset({
              userId: user.id,
              importId: session.id,
              refId: imported.entity.refId
            })
            session.report.selectedPreset = new StIssue({
              path: "settings.json",
              level: "info",
              code: adopted ? "st.preset_default" : "st.preset_kept",
              message: adopted
                ? `ST used preset “${shownText(name)}”; it is now your default preset.`
                : `ST used preset “${shownText(name)}”; your existing default preset was kept.`
            })
          }
          return imported.outcome
        })

      // --- Chats.

      /** Ends the chat being read, giving back the budget its summaries held. */
      const dropChat = (session: Session) =>
        Effect.sync(() => {
          const chat = session.chat
          session.chat = null
          if (chat !== null) session.held -= chat.summaryChars
        })

      /** The chat's record and, for a new one, the chat itself: once it has a user message. */
      const startChat = (session: Session, user: User, progress: ChatProgress) =>
        Effect.gen(function* () {
          const target = yield* writer.StImportStartChat({
            userId: user.id,
            source: progress.path,
            title: progress.title,
            createdAt: progress.header?.createdAt ?? progress.lastAt ?? Date.now(),
            chatId: progress.into,
            lease: session.id
          })
          progress.target = target
          // A part 0 sent again in this run goes on from this record, not a second one.
          session.records.set(progress.path, {
            ...target,
            complete: false,
            binned: false,
            merged: progress.into !== null,
            state: null,
            notes: {},
            end: null,
            firstAdded: null
          })
          return target
        })

      const writeBatch = (
        session: Session,
        user: User,
        progress: ChatProgress,
        target: Target,
        batch: Batch,
        speakers: ReadonlyMap<string, EntityId | null>
      ) =>
        Effect.gen(function* () {
          const written = yield* writer.StImportMessages({
            lease: session.id,
            advanceLeaf: progress.isNew,
            userId: user.id,
            chatId: target.chatId,
            recordId: target.recordId,
            strict: progress.branch,
            parentSlotId: progress.cursor,
            matching: progress.matching,
            messagesJson: batch.messagesJson,
            // Only this batch's, so the map is sent once per speaker, not once per batch.
            speakers: Object.fromEntries(batch.speakers.map((key) => [key, speakers.get(key) ?? null]))
          })
          if (written.added > 0 && progress.firstAdded === null) {
            progress.firstAdded = written.slotIds[written.slotIds.length - written.added]!
            // As the record now says, for this run sending the chat again from its start.
            const cached = session.records.get(progress.path)
            if (cached !== undefined && !cached.complete) {
              session.records.set(progress.path, { ...cached, firstAdded: cached.firstAdded ?? progress.firstAdded })
            }
          }
          for (const slotId of written.slotIds) {
            if (progress.atEnd && progress.afterEnd === null) progress.afterEnd = slotId
            progress.atEnd = slotId === progress.prevEnd
          }
          progress.firstSlot ??= written.slotIds[0] ?? null
          for (const summary of progress.summaries) {
            const at = summary.index - progress.written
            if (at >= 0 && at < written.slotIds.length) summary.slot = written.slotIds[at]!
          }
          const lastHidden = progress.hiddenRun - 1
          if (lastHidden >= progress.written && lastHidden < progress.written + written.slotIds.length) {
            progress.throughSlot = written.slotIds[lastHidden - progress.written]!
          }
          progress.written += written.slotIds.length
          progress.cursor = written.slotIds.at(-1) ?? progress.cursor
          progress.matching = written.matching
          progress.added += written.added
          progress.updated += written.updated
          progress.differing += written.differing
        })

      /** Writes the chat's state and makes it active, once its last part is in. */
      const finishChat = (session: Session, user: User, progress: ChatProgress, target: Target) =>
        Effect.gen(function* () {
          const { report } = session
          const run = { length: progress.hiddenRun, firstSlot: progress.firstSlot, throughSlot: progress.throughSlot }
          const change = chatStateChange(
            session,
            {
              link: progress.link,
              header: progress.header,
              spoke: progress.spoke,
              summaries: progress.summaries,
              messages: progress.index,
              run
            },
            progress.prevState,
            progress.isNew
          )
          for (const name of change.missingWorlds) {
            if (session.missingWorlds.has(name)) continue
            session.missingWorlds.add(name)
            report.issue(
              progress.path,
              "warning",
              "st.world_missing",
              `The lorebook “${shownText(name)}” wasn't in the folder, so it isn't attached to the chats that name it.`
            )
          }
          if (change.summaryOnLast) {
            report.issue(
              progress.path,
              "info",
              "st.summary_on_last",
              "A summary on the chat's last message was left as ST leaves it: unused."
            )
          }
          if (change.summaryIndex !== null && session.settings === null) {
            report.issue(
              progress.path,
              "info",
              "st.summary_defaults",
              "settings.json wasn't imported first, so the summary is placed as ST places it by default."
            )
          }
          if (change.replacedAuthorNote) {
            report.issue(
              progress.path,
              "info",
              "st.character_note_replaced",
              "ST sent the character's own author's note in place of this chat's; both are kept here, the character's at the top of the chat's."
            )
          }
          if (change.summaryTrimmed) {
            report.issue(
              progress.path,
              "info",
              "st.summary_history",
              "Only the latest of the chat's earlier summaries are kept as the summary's history."
            )
          }
          if (progress.differing > 0) {
            report.issue(
              progress.path,
              "info",
              "st.differing",
              `${progress.differing} messages are shown or hidden differently here than in ST; they were left as they are here.`
            )
          }
          // A new chat's state goes at its start. A chat merged into gets what changed from
          // the first message past where this file last ended (which an interrupted run may
          // have written), else from where an unfinished run of it went its own way, else
          // from its first new message.
          const position = progress.isNew ? null : (progress.afterEnd ?? progress.resumeAt ?? progress.firstAdded)
          const applies = progress.isNew || position !== null
          if (!applies && JSON.stringify(change.state) !== JSON.stringify(progress.prevState)) {
            report.issue(
              progress.path,
              "info",
              "st.state_unchanged",
              "The chat's settings changed in ST, but it brought no new message to attach the change to."
            )
          }
          // The writer moves it only if it's unset or still where this file last ended.
          const leaf = progress.cursor === null || progress.branch || !applies ? null : progress.cursor
          const finished = yield* writer.StImportFinishChat({
            lease: session.id,
            userId: user.id,
            chatId: target.chatId,
            recordId: target.recordId,
            position,
            events: applies ? change.events : [],
            notes: applies ? change.notes : [],
            removedNotes: applies ? change.removedNotes : [],
            previousNotes: progress.prevNotes,
            leaf,
            end: progress.cursor,
            lastMessageAt: progress.lastMessageAt,
            sha256: hash(progress.partHashes.join("")),
            stateJson: JSON.stringify(applies ? change.state : progress.prevState),
            fork: progress.fork
          })
          if (finished.fork === "same" && progress.fork?.name != null) {
            report.issue(
              progress.path,
              "info",
              "st.fork_same",
              `This branch is named “${shownText(progress.fork!.name)}” in ST, but it has no message of its own apart from its parent chat's, so no branch was given the name.`
            )
          }
          session.records.set(progress.path, {
            ...target,
            complete: true,
            binned: false,
            merged: progress.branch,
            state: applies ? change.state : progress.prevState,
            notes: finished.notes,
            end: progress.cursor,
            firstAdded: null
          })
          // Open tabs read the chat again: it changed under them.
          if (!progress.isNew) hub.publish(target.chatId, { _tag: "Reload" })
          if (change.summaryIndex !== null) report.summaries++
          // Offered once, for the chat the import made.
          if (progress.hiddenRun >= HIDDEN_RUN_MIN && progress.throughSlot !== null && progress.isNew) {
            const covered = change.summaryIndex === null ? null : change.summaryIndex >= progress.hiddenRun - 1
            if (covered === false) {
              report.issue(
                progress.path,
                "info",
                "st.summary_partial",
                `The summary was made at message ${change.summaryIndex}, before the last of the ${progress.hiddenRun} hidden messages, so it doesn't cover them all.`
              )
            }
            report.offer(
              new StHiddenRun({
                chatId: target.chatId,
                title: progress.title,
                hidden: progress.hiddenRun,
                throughSlotId: progress.throughSlot,
                summaryCovers: covered
              })
            )
          }
          return progress.isNew ? "added" : applies || progress.updated > 0 ? "updated" : "unchanged"
        })

      /** Reads a chat's first part: what it's linked to, and where its messages go. */
      const beginChat = (
        session: Session,
        path: string,
        file: Extract<StFile, { kind: "chat" | "group_chat" }>,
        part: {
          readonly header: StChatHeader | null
          readonly speakers: ReadonlyArray<StSpeaker>
          readonly greeting: string | null
        },
        request: ChatRequest
      ): ChatProgress | StFileResult => {
        const { report } = session
        const header = part.header
        const mainChat = header?.mainChat ?? null
        const parentPath = mainChat === null ? null : stParentPath(file, mainChat)
        const own = session.records.get(path)
        if (own?.binned) {
          report.count(file.kind, "skipped")
          report.issue(
            path,
            "info",
            "st.in_bin",
            "The chat an earlier import made of this file is in your recycle bin, so it wasn't imported again."
          )
          return result("skipped", "in the recycle bin")
        }
        // Which card or group the chat is with.
        let link: Link
        if (file.kind === "group_chat") {
          const group = session.groups.get(file.name) ?? (mainChat === null ? undefined : session.groups.get(mainChat))
          if (group === undefined) {
            report.issue(
              path,
              "warning",
              "st.no_group",
              "No group lists this chat; its speakers were matched by their avatars."
            )
          }
          link = { card: null, group: group ?? null }
        } else if (request.card !== null) {
          const known = [...session.cards.values()].find((card) => card.entityId === request.card)
          const chosen: CardInfo | null =
            request.card === "none"
              ? null
              : (known ?? {
                  entityId: request.card,
                  label: "",
                  file: null,
                  name: "",
                  greetings: [],
                  world: null,
                  book: false
                })
          link = { card: chosen, group: null }
        } else {
          const found = linkChat(session.cards, file.folder, part.speakers, part.greeting)
          if ("choices" in found) {
            report.choose(
              new StLinkChoice({
                path,
                title: file.name,
                reason: found.reason,
                // Cards can share a name; their files tell them apart.
                candidates: found.choices.map((card) => ({
                  entityId: card.entityId,
                  label: card.file === null ? card.label : `${card.label} (${card.file})`
                }))
              })
            )
            return result("needs_link", found.reason)
          }
          link = { card: found.card, group: null }
        }
        report.links.delete(path)

        const parent = parentPath === null ? undefined : session.records.get(parentPath)
        const parentLive = parent !== undefined && !parent.binned ? parent : undefined
        if (own === undefined && parentPath !== null && parentLive === undefined) {
          if (!request.orphan) return result("deferred", "Its parent chat isn't in yet.")
          report.issue(
            path,
            "info",
            "st.orphan_branch",
            "This branch's parent chat wasn't in the folder, so it became a chat of its own."
          )
        }
        // A branch is a file that went into another file's chat; an orphan is a chat of its own.
        const branch = own !== undefined ? own.merged : parentLive !== undefined
        const into = own === undefined && branch ? parentLive! : undefined
        const forkName = branch && parent !== undefined ? stForkName(file.name, mainChat) : null
        // Its state so far: the record's when complete; for a branch not yet finished, its parent's.
        const previous = own?.complete ? own : branch ? parentLive : undefined
        return {
          path,
          countAs: file.kind,
          nextPart: 0,
          title: file.kind === "group_chat" && link.group !== null ? `${link.group.name}: ${file.name}` : file.name,
          header,
          link,
          target: own === undefined ? null : { chatId: own.chatId, recordId: own.recordId },
          into: into?.chatId ?? null,
          // A chat whose first import never finished has no state yet: it's finished as new.
          isNew: !branch && !(own?.complete ?? false),
          branch,
          fork: branch && parent !== undefined ? { name: forkName, parentRecordId: parent.recordId } : null,
          prevState: previous?.state ?? null,
          prevNotes: previous?.notes ?? {},
          prevEnd: own?.complete ? own.end : null,
          resumeAt: own !== undefined && !own.complete ? own.firstAdded : null,
          matching: own !== undefined || into !== undefined,
          cursor: null,
          firstAdded: null,
          afterEnd: null,
          atEnd: false,
          firstSlot: null,
          index: 0,
          written: 0,
          lastAt: null,
          lastMessageAt: null,
          userTurns: 0,
          pending: [],
          decided: false,
          hiddenRun: 0,
          runOpen: true,
          throughSlot: null,
          summaries: [],
          summaryChars: 0,
          spoke: new Set(),
          partHashes: [],
          added: 0,
          updated: 0,
          differing: 0
        }
      }

      const chatFile = (
        session: Session,
        user: User,
        path: string,
        file: Extract<StFile, { kind: "chat" | "group_chat" }>,
        bytes: Uint8Array,
        request: ChatRequest
      ) =>
        Effect.gen(function* () {
          const { report } = session
          if (request.part === 0) yield* dropChat(session)
          else if (session.chat === null || session.chat.path !== path || session.chat.nextPart !== request.part) {
            return result("restart", "Send the chat again from its start.")
          }
          const part = yield* formats.st.chatPart({
            bytes,
            first: request.part === 0,
            firstIndex: session.chat?.index ?? 0,
            carryAt: session.chat?.lastAt ?? null
          })
          report.file(path, part.report)
          if (part.report.issues.some((issue) => issue.level === "error")) {
            yield* dropChat(session)
            report.count(file.kind, "failed")
            return result("failed", part.report.issues.find((i) => i.level === "error")!.message)
          }
          if (session.chat === null) {
            // A file imported before: this run takes its record over, as the record is now.
            const cached = session.records.get(path)
            if (cached !== undefined && !cached.binned) {
              const parentRecordId =
                part.header?.mainChat == null
                  ? undefined
                  : session.records.get(stParentPath(file, part.header.mainChat))?.recordId
              const claimed = yield* writer.StImportClaim({
                userId: user.id,
                recordId: cached.recordId,
                lease: session.id,
                ...(parentRecordId === undefined ? {} : { parentRecordId })
              })
              session.records.set(path, { ...claimed, state: JSON.parse(claimed.stateJson) as ChatState | null })
            }
            const begun = beginChat(session, path, file, part, request)
            if (begun instanceof StFileResult) return begun
            session.chat = begun
          }
          const progress = session.chat
          progress.partHashes.push(part.sha256)
          progress.userTurns += part.userTurns
          if (progress.runOpen) {
            progress.hiddenRun += part.leadingHidden
            progress.runOpen = part.leadingHidden === part.messages
          }
          // The summaries are held until the chat is done, so they count against the budget.
          const summaryChars = part.summaries.reduce((sum, s) => sum + s.text.length, 0)
          if (!hold(session, path, file.kind, summaryChars)) {
            yield* dropChat(session)
            return result("failed", "too much in one import")
          }
          progress.summaryChars += summaryChars
          progress.summaries.push(...part.summaries)
          progress.index += part.messages
          progress.lastAt = part.lastAt
          if (part.lastAt !== null) progress.lastMessageAt = Math.max(progress.lastMessageAt ?? 0, part.lastAt)
          progress.nextPart = request.part + 1
          report.messages += part.messages

          // A chat of one message, not the user's, is the greeting-only chat ST makes by opening a
          // card (DESIGN §1.4): skipped, whether or not an earlier import has it. Its first
          // message waits until a second one comes or the file ends, however its parts fall.
          const speakers = speakerMap(session, progress.link, progress.header, part.speakers, progress.spoke)
          if (!progress.decided) {
            if (progress.index <= 1 && !request.last) {
              progress.pending.push(...part.batches.map((batch) => ({ batch, speakers })))
              return result("continue")
            }
            if (progress.index === 0 || (progress.index === 1 && progress.userTurns === 0)) {
              yield* dropChat(session)
              if (progress.index === 1) report.greetingOnly++
              report.count(file.kind, "skipped")
              return result("skipped", progress.index === 0 ? "no messages" : "only a greeting")
            }
            progress.decided = true
          }
          const target = progress.target ?? (yield* startChat(session, user, progress))
          for (const held of progress.pending.splice(0)) {
            yield* writeBatch(session, user, progress, target, held.batch, held.speakers)
          }
          for (const batch of part.batches) yield* writeBatch(session, user, progress, target, batch, speakers)
          if (!request.last) return result("continue")

          if (progress.userTurns === 0) {
            report.issue(
              path,
              "info",
              "st.no_user_turn",
              "This chat has no message of yours; it was imported all the same."
            )
          }
          const outcome = yield* finishChat(session, user, progress, target)
          yield* dropChat(session)
          report.count(file.kind, outcome)
          return result(outcome)
        })

      const file = (user: User, importId: string, path: string, bytes: Uint8Array, request: ChatRequest) =>
        Effect.gen(function* () {
          const session = yield* sessionOf(user, importId)
          const kind = classifyStPath(path)
          if (kind === null || kind.kind === "unsupported") {
            return result("failed", "This file isn't one the import reads.")
          }
          switch (kind.kind) {
            case "settings": {
              const parsed = yield* formats.st.settings(bytes)
              session.report.file(path, parsed.report)
              const settings = parsed.settings
              if (settings === null) return result("failed")
              const size = JSON.stringify(settings).length
              session.held -= session.settingsHeld
              session.settingsHeld = 0
              if (!hold(session, path, "settings", size)) return result("failed", "too much in one import")
              session.settingsHeld = size
              yield* writer.StImportSummarySettings({
                userId: user.id,
                importId,
                prompt: settings.summary.prompt,
                settings: JSON.stringify(settings.summary)
              })
              session.settings = settings
              session.report.selectedPreset =
                settings.selectedPreset === null
                  ? null
                  : new StIssue({
                      path,
                      level: "warning",
                      code: "st.preset_missing",
                      message: `ST used preset “${shownText(settings.selectedPreset)}”, but its preset file has not been imported from this folder. Your default preset was left unchanged.`
                    })
              session.personaNames = new Map()
              for (const persona of settings.personas) {
                session.personaNames.set(persona.name, [
                  ...(session.personaNames.get(persona.name) ?? []),
                  persona.avatar
                ])
              }
              if (settings.globalWorlds.length > 0) {
                for (const name of settings.globalWorlds) {
                  const ref = session.worlds.get(name)
                  if (ref) yield* writer.SetGlobalLorebook({ userId: user.id, ref, global: true })
                }
                session.report.issue(
                  path,
                  "info",
                  "st.global_worlds",
                  `ST applies ${shownList(settings.globalWorlds)} to every chat; here they're marked “Use in every chat”, which each chat's Lorebooks tab can turn off.`
                )
              }
              return result("added")
            }
            case "persona_avatar":
              return yield* personaFile(session, user, path, kind.file, bytes)
            case "card":
              return yield* cardFile(session, user, path, kind.file, bytes, request.createdAt)
            case "world":
              return yield* libraryFile(session, user, path, `${kind.name}.json`, bytes, "lorebook", kind.name)
            case "preset":
              return yield* libraryFile(session, user, path, `${kind.name}.json`, bytes, "preset", kind.name)
            case "group": {
              const parsed = yield* formats.st.group(bytes, kind.file)
              session.report.file(path, parsed.report)
              const group = parsed.group
              if (group === null) return result("failed")
              const size = [group.name, ...group.members, ...group.disabledMembers, ...group.chats].reduce(
                (sum, text) => sum + text.length + 16,
                0
              )
              if (!hold(session, path, "group", size)) return result("failed", "too much in one import")
              for (const chat of group.chats) session.groups.set(chat, group)
              return result("added")
            }
            case "chat":
            case "group_chat":
              return yield* chatFile(session, user, path, kind, bytes, request).pipe(
                // A chat left between parts is the only one kept; one that failed, or whose
                // request was interrupted, gives back what it held.
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) && session.chat?.path === path ? dropChat(session) : Effect.void
                ),
                Effect.catchTags({
                  // Another run of this import took the file over, or finished it.
                  ImportLeaseLost: () => Effect.succeed(result("failed", "Another import of this chat took it over.")),
                  NotFound: (error) => {
                    const cached = session.records.get(path)
                    // The chat went to the recycle bin meanwhile: like one found there, it's left there.
                    if (error.entity === "chat" && cached !== undefined) {
                      session.records.set(path, { ...cached, binned: true })
                      session.report.count(kind.kind, "skipped")
                      return Effect.succeed(result("skipped", "in the recycle bin"))
                    }
                    if (error.entity === "slot" || error.entity === "import record") {
                      return Effect.succeed(
                        result("restart", "The chat changed meanwhile; send it again from its start.")
                      )
                    }
                    session.report.count(kind.kind, "failed")
                    return Effect.succeed(result("failed", "A card it names isn't in your library."))
                  }
                })
              )
          }
        })

      return StImports.of({
        start: (user, unsupported) =>
          start(user, unsupported).pipe(
            Effect.catch((error) =>
              Effect.logError("starting an ST import failed", error).pipe(
                Effect.andThen(Effect.fail(new ServerError({ message: "The import couldn't start." })))
              )
            )
          ),
        report: (user, importId) => Effect.map(sessionOf(user, importId), (session) => session.report.build()),
        file: (user, importId, path, bytes, request) =>
          file(user, importId, path, bytes, request).pipe(
            Effect.catch((error): Effect.Effect<never, NotFound | StImportFailed> =>
              error instanceof NotFound
                ? Effect.fail(error)
                : Effect.logError("an ST import failed", error).pipe(Effect.andThen(Effect.fail(new StImportFailed())))
            )
          ),
        unhidden: (user, chatId) => void sessions.get(user.id)?.report.hiddenRuns.delete(chatId),
        exists: (user, importId) => sessions.get(user.id)?.id === importId
      })
    })
  )
}
