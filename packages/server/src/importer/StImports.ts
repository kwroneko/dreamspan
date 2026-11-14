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
import { shownText } from "@rp/shared/importReport.ts"
import type { EntityKind, RefId } from "@rp/shared/library.ts"
import { classifyStPath, type StFile, stParentPath } from "@rp/shared/stFolder.ts"
import { sourceTime, stIdTime } from "../formats/sourceTime.ts"
import {
  StFileResult,
  StHiddenRun,
  type StImportReport,
  type StArrival,
  StIssue,
  StLinkChoice
} from "@rp/shared/stImportApi.ts"
import { createHash } from "node:crypto"
import { lstat, rm } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { CardSources } from "../sources/CardSources.ts"
import { Formats } from "./Formats.ts"
import { MediaHolds } from "./MediaHolds.ts"
import { prepareAvatarThumbnails } from "./prepareThumbnails.ts"
import { describeImage } from "./images.ts"
import { stGalleryFolder } from "@rp/shared/stFolder.ts"
import { storeMedia } from "./mediaFiles.ts"
import type { ParsedFile, StChatHeader, StPersona, StSettings, StSpeaker } from "./ops.ts"
import { Report } from "./stReport.ts"
import { stChatTarget } from "./stChatTarget.ts"
import { stepWriteProgress, stFinishAt, stIndexSlot, type StStagedBatch } from "../db/stImportProgress.ts"
import { stBytesHash, type StPlanExpect, type StPlanExpectFile, stPartsHash } from "./stPlanExpect.ts"
import { ST_CHANGED_SINCE_CHECK as CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import {
  type CardInfo,
  chatStateChange,
  defaultPersona,
  type ChatState,
  type FolderContext,
  HIDDEN_RUN_MIN,
  type Link,
  linkChat,
  speakerMap,
  stem,
  stChatTitle,
  authorNotePlace
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

/** What a chat request names besides its path. */
export interface ChatRequest {
  /** File.lastModified for uploads; stat.mtimeMs for server folders. */
  readonly modifiedAt?: number
  readonly birthAt?: number
  readonly arrival?: StArrival
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
  readonly hashes?: ReadonlyArray<string>
  readonly messagesJson: string
  readonly speakers: ReadonlyArray<string>
}

interface ChatProgress {
  readonly modifiedAt: number
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
  /** A branch's parent file's record. */
  readonly fork: { readonly parentRecordId: string } | null
  /** ST opens the file's card or group on it (a card's `chat`, a group's `chat_id`): its last-opened chat. */
  readonly stCurrent: boolean
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
  /** The first message's time, from the first part with one. */
  firstAt: number | null
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
  selectedPersona: EntityId | null
  readonly partHashes: Array<string>
  /** A confirmed re-import's hash of the bytes taken (`stBytesHash`), compared with the check's. */
  content: ReturnType<typeof stBytesHash> | null
  added: number
  updated: number
  differing: number
  /**
   * Held to the confirmed re-import check: nothing of it is written until its last part is in
   * and matches the bytes checked; then all of it goes in one transaction (`StImportCommitChat`).
   */
  exact: StPlanExpectFile | null
  /** Its batches waiting in the writer for that transaction. */
  staged: number
  /** The record of the parent its header names, which claiming its own record takes. */
  claimParent: string | undefined
}

interface Session extends FolderContext {
  readonly galleryCards: Map<string, Array<RefId>>
  readonly arrivalRefs: Map<EntityId, RefId>
  readonly importedAt: number
  settingsModifiedAt: number | null
  readonly id: string
  touched: number
  readonly report: Report
  settings: StSettings | null
  summaryMacro: boolean
  readonly anLorebooks: Set<string>
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
  /** ST's global World Info books attached to its selected preset: the preset's name and theirs. */
  globalAttached: { readonly preset: string; readonly books: ReadonlyArray<string> } | null
  chat: ChatProgress | null
  /** The confirmed re-import check this run is held to (ARCHITECTURE.md §13), if any. */
  readonly exact: StPlanExpect | null
  /** Each chat's stamp as the check read it, then as this run's own writes left it. */
  readonly stamps: Map<string, string>
}

type StGroup = NonNullable<Link["group"]>

/** Storing a file failed on the server, not because of the file; the error is logged. */
export class StImportFailed extends Schema.TaggedError<StImportFailed>()("StImportFailed", {}) {
  override get message() {
    return "The import failed on the server; try again."
  }
}

/** One uploaded file of the folder, as its kind's handler receives it. */
export interface StFolderCall<F extends StFile = StFile> {
  readonly session: Session
  readonly user: User
  readonly importId: string
  readonly path: string
  readonly file: F
  readonly bytes: Uint8Array
  readonly request: ChatRequest
}

/**
 * What the import does with the folder files of one kind (PLUGINS §8): the dispatch by the
 * file's place in the folder. The built-ins register through the same registry a plugin's
 * handler does, which replaces or wraps (`get` first) one for a scope. The handler reads
 * through the typed format operations (`Formats.st`, worker execution) and stores through
 * the writer's typed operations; it holds no database access of its own.
 */
export interface StFolderHandler {
  /** The kind of folder file it handles: `settings`, `card`, `chat`... */
  readonly id: Exclude<StFile["kind"], "unsupported">
  readonly run: (call: StFolderCall) => Effect.Effect<StFileResult, unknown>
}

const on = <K extends Exclude<StFile["kind"], "unsupported">>(
  id: K,
  run: (call: StFolderCall<Extract<StFile, { kind: K }>>) => Effect.Effect<StFileResult, unknown>
): StFolderHandler => ({ id, run: run as StFolderHandler["run"] })

const result = (outcome: StFileResult["outcome"], message = "") => new StFileResult({ outcome, message })

export class StImports extends Context.Service<
  StImports,
  {
    /**
     * Starts the user's import run. `expect`: the re-import preview the user confirmed, which
     * the run is held to file by file: a file whose chat or bytes changed since is refused.
     */
    readonly start: (
      user: User,
      unsupported: ReadonlyArray<string>,
      expect?: StPlanExpect
    ) => Effect.Effect<string, ServerError>
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
    /** Ends the user's import if it's this one: its files are refused from now on. */
    readonly end: (user: User, importId: string) => void
    /** Where the import found the library entry of an entity, by an earlier import's records too. */
    readonly sourcesOf: (user: User, importId: string, entityId: EntityId) => ReadonlyArray<string>
    /** The folder-file handlers by kind, for a plugin to register into, wrap or disable. */
    readonly handlers: Registry<StFolderHandler>
  }
>()("rp/importer/StImports") {
  static readonly layer = Layer.effect(
    StImports,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const formats = yield* Formats
      const reader = yield* Reader
      const writer = yield* Writer
      const sources = yield* CardSources
      const { holding } = yield* MediaHolds
      const hub = yield* ChatHub
      const sessions = new Map<string, Session>()
      const handlers = makeRegistry<StFolderHandler>()

      yield* removeOldStaging(config.dataDir)

      const sessionOf = (user: User, importId: string) => {
        const session = sessions.get(user.id)
        if (session === undefined || session.id !== importId || Date.now() - session.touched > IDLE_MS) {
          return Effect.fail(new NotFound({ entity: "import", id: importId }))
        }
        session.touched = Date.now()
        return Effect.succeed(session)
      }

      const start = (user: User, unsupported: ReadonlyArray<string>, expect: StPlanExpect | undefined) =>
        Effect.gen(function* () {
          const sources = yield* reader.StImportSources({ userId: user.id })
          const session: Session = {
            id: uuidv7(),
            importedAt: Date.now(),
            arrivalRefs: new Map(),
            settingsModifiedAt: null,
            touched: Date.now(),
            report: new Report(),
            settings: null,
            summaryMacro: false,
            anLorebooks: new Set(),
            personaNames: new Map(),
            held: 0,
            settingsHeld: 0,
            personas: new Map(),
            personaNotes: new Map(),
            cards: new Map(),
            galleryCards: new Map(),
            worlds: new Map(),
            groups: new Map(),
            library: new Map(),
            libraryByHash: new Map(),
            records: new Map(),
            missingWorlds: new Set(),
            globalAttached: null,
            chat: null,
            exact: expect ?? null,
            stamps: new Map(expect?.stamps ?? [])
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
        createdAt?: number,
        presetLorebooks?: ReadonlyArray<RefId>,
        modifiedAt?: number,
        arrival?: StArrival
      ) =>
        Effect.gen(function* () {
          const { report } = session
          report.file(path, parsed.report)
          if (parsed.library === null) {
            report.count(countAs, "failed")
            const error = parsed.report.issues.find((i) => i.level === "error")
            return { outcome: result("failed", error?.message ?? ""), entity: null, created: false, note: null }
          }
          const { links, ...library } = parsed.library
          const earlier = session.library.get(path)
          if (earlier?.binned) {
            report.count(countAs, "skipped")
            report.issue(
              path,
              "warning",
              "st.in_bin",
              "An earlier import of this file is in your recycle bin, so it wasn't imported again: restore it there, or delete it for good and import the folder again."
            )
            return { outcome: result("skipped", "in the recycle bin"), entity: null, created: false, note: null }
          }
          const same = earlier ?? session.libraryByHash.get(`${library.kind}:${parsed.sha256}`)
          const unchanged = same !== undefined && same.kind === library.kind && same.sourceHash === parsed.sha256
          // A preset taking ST's global books goes to the writer even unchanged: the books may be
          // new. What it stores is the import's line (§3.9), so the same books add no revision.
          const attaching = presetLorebooks !== undefined && presetLorebooks.length > 0
          if (unchanged && !attaching && arrival === undefined) {
            report.count(countAs, "unchanged")
            const note =
              library.noteDocJson === null
                ? null
                : yield* reader.GetCardImportNote({ userId: user.id, cardRefId: same.refId })
            return { outcome: result("unchanged"), entity: same, created: false, note }
          }
          const imported = yield* holding(
            parsed.media.map((file) => file.sha256),
            Effect.gen(function* () {
              yield* Effect.forEach(parsed.media, (file) => storeMedia(config.dataDir, file.sha256, file.bytes), {
                discard: true
              })
              const recognized = links ? sources.recognize(links) : []
              return yield* writer.ImportFile({
                userId: user.id,
                intoRefId: (earlier ?? (unchanged ? same : undefined))?.refId ?? null,
                ...(recognized.length ? { recognized } : {}),
                ...(attaching ? { presetLorebooks } : {}),
                ...(createdAt === undefined ? {} : { createdAt }),
                modifiedAt: modifiedAt ?? session.importedAt,
                ...(arrival === undefined ? {} : { arrival }),
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
          // The grid's thumbnails, on this import's lane, so its cards show from disk.
          yield* prepareAvatarThumbnails(formats, config.dataDir, parsed.media)
          const entry: LibraryEntry = {
            refId: imported.ref.id,
            entityId: imported.ref.entityId,
            kind: imported.ref.kind,
            label: imported.ref.label,
            sourceHash: parsed.sha256,
            binned: false
          }
          if (arrival !== undefined) session.arrivalRefs.set(entry.entityId, entry.refId)
          session.library.set(path, entry)
          session.libraryByHash.set(`${entry.kind}:${parsed.sha256}`, entry)
          const counted = imported.created
            ? "added"
            : unchanged && imported.outcome === "up_to_date"
              ? "unchanged"
              : "updated"
          report.count(countAs, counted)
          if (imported.outcome === "conflicts") {
            report.issue(
              path,
              "warning",
              "st.conflicts",
              "Your edits conflict with this version; resolve them in the library."
            )
          }
          return {
            outcome: result(counted),
            entity: entry,
            created: imported.created,
            note: imported.note?.entityId ?? null
          }
        })

      const personaFile = (
        session: Session,
        user: User,
        path: string,
        file: string,
        bytes: Uint8Array,
        modifiedAt: number,
        arrival: StArrival
      ) =>
        Effect.gen(function* () {
          const persona: StPersona | null = session.settings?.personas.find((p) => p.avatar === file) ?? null
          // At the author's note's top or bottom: where the folder's default author's note is.
          const riding = persona !== null && (persona.position === 2 || persona.position === 3)
          const parsed = yield* formats.st.persona(
            bytes,
            file,
            persona,
            authorNotePlace(session.settings?.defaultAuthorNote ?? null).note
          )
          const imported = yield* importLibrary(
            session,
            user,
            path,
            "persona",
            parsed,
            arrival.at,
            undefined,
            persona === null ? modifiedAt : Math.max(modifiedAt, session.settingsModifiedAt ?? modifiedAt),
            arrival
          )
          if (imported.entity === null) return imported.outcome
          // Only a new card goes into the persona folder: the user may have refiled it since.
          if (imported.created) {
            yield* writer.SetEntityTags({ userId: user.id, entityId: imported.entity.entityId, tags: ["persona"] })
          }
          session.personas.set(file, imported.entity.entityId)
          if (session.settings?.defaultPersona === file) {
            yield* writer.StImportDefaultPersona({
              userId: user.id,
              importId: session.id,
              entityId: imported.entity.entityId
            })
          }
          // Where the author's note was: switched off in chats whose author's note ST disabled.
          if (riding && imported.note !== null) session.personaNotes.set(imported.entity.entityId, imported.note)
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
              // Before, after or in place of the author's note: where the folder's default one is.
              placement: authorNotePlace(settings.defaultAuthorNote).note,
              scanLore: settings.allowWIScan,
              sourcePath: path,
              modifiedAt: session.settingsModifiedAt ?? session.importedAt
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

      const cardFile = (
        session: Session,
        user: User,
        path: string,
        file: string,
        bytes: Uint8Array,
        modifiedAt: number,
        arrivalFile: StArrival
      ) =>
        Effect.gen(function* () {
          const parsed = yield* formats.st.libraryFile(bytes, file, "card", undefined, undefined, {
            cards: Object.fromEntries([...session.cards].map(([name, card]) => [name, card.entityId])),
            tags: session.settings?.tagNames ?? {},
            cardTags: session.settings?.characterTags?.[stem(file)] ?? []
          })
          const card = parsed.card
          const arrival: StArrival =
            parsed.parsed.stCreatedAt == null ? arrivalFile : { at: parsed.parsed.stCreatedAt, basis: 0 }
          const size = card === null ? 0 : card.name.length + card.greetings.reduce((sum, g) => sum + g.length, 0)
          if (!hold(session, path, "card", size + file.length)) return result("failed", "too much in one import")
          const imported = yield* importLibrary(
            session,
            user,
            path,
            "card",
            parsed.parsed,
            card?.authoredAt ?? arrival.at,
            undefined,
            parsed.parsed.stModifiedAt ?? modifiedAt,
            arrival
          )
          if (imported.created && imported.entity !== null && card !== null) {
            const folder = stGalleryFolder(session.settings?.galleryFolders?.[file] ?? card.name)
            session.galleryCards.set(folder, [...(session.galleryCards.get(folder) ?? []), imported.entity.refId])
          }
          if (imported.entity !== null && card !== null) {
            const characterNote = yield* characterAuthorNote(session, user, path, stem(file), imported.entity.entityId)
            session.cards.set(stem(file), {
              ...card,
              entityId: imported.entity.entityId,
              label: imported.entity.label,
              file: stem(file),
              characterNote,
              lastChat: parsed.parsed.stChat ?? null
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
        name: string,
        modifiedAt: number
      ) =>
        Effect.gen(function* () {
          const parsed = yield* formats.st.libraryFile(
            bytes,
            file,
            kind,
            session.settings?.textSwitches,
            kind === "lorebook" ? authorNotePlace(session.settings?.defaultAuthorNote ?? null).lore : undefined,
            kind === "lorebook"
              ? {
                  cards: Object.fromEntries([...session.cards].map(([name, card]) => [name, card.entityId])),
                  tags: session.settings?.tagNames ?? {}
                }
              : undefined
          )
          const anEntries = parsed.parsed.report.issues.some((issue) => issue.code === "lorebook.author_note_riders")
          // ST applies its global books to every chat: here they go with the preset ST had
          // selected, the books already imported (lorebooks come before presets, §13).
          const selected = kind === "preset" && session.settings?.selectedPreset === name
          const globals = selected
            ? (session.settings?.globalWorlds ?? []).flatMap((world) => {
                const ref = session.worlds.get(world)
                return ref === undefined ? [] : [{ world, ref }]
              })
            : []
          const imported = yield* importLibrary(
            session,
            user,
            path,
            kind,
            parsed.parsed,
            undefined,
            globals.map((book) => book.ref),
            // ST rewrites settings.json during ordinary use; only this entity's file dates its edits.
            modifiedAt
          )
          if (imported.entity !== null && kind === "lorebook") {
            session.worlds.set(name, imported.entity.refId)
            // Its entries at the author's note's top or bottom: a chat using it had them at its note.
            if (anEntries) session.anLorebooks.add(imported.entity.refId)
            else session.anLorebooks.delete(imported.entity.refId)
          }
          if (imported.entity !== null && globals.length > 0)
            session.globalAttached = { preset: name, books: globals.map((book) => book.world) }
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
              // Your chats use your default preset: one that isn't ST's is yours to switch.
              level: adopted ? "info" : "warning",
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
      /** What a chat file's record and chat start with. */
      const startFields = (progress: ChatProgress) => ({
        title: progress.title,
        ...(progress.link.group?.arrival === undefined
          ? {}
          : {
              groupId: progress.link.group.id,
              arrival:
                progress.link.group.arrival.basis > 1 && progress.header?.createdAt != null
                  ? { at: progress.header.createdAt, basis: 1 as const }
                  : progress.link.group.arrival
            }),
        // When ST started it: its header's date, else its first message's (never its last's).
        createdAt: progress.header?.createdAt ?? progress.firstAt ?? progress.lastAt ?? Date.now()
      })

      const startChat = (session: Session, user: User, progress: ChatProgress) =>
        Effect.gen(function* () {
          const target = yield* writer.StImportStartChat({
            userId: user.id,
            source: progress.path,
            ...(progress.fork === null ? {} : { parentRecordId: progress.fork.parentRecordId }),
            ...startFields(progress),
            chatId: progress.into,
            lease: session.id
          })
          progress.target = target
          session.report.chat(progress.path, target.chatId)
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

      /** A batch's messages and what they name, as the writer takes them. */
      const batchFields = (
        session: Session,
        batch: Batch,
        speakers: ReadonlyMap<string, EntityId | null>
      ): StStagedBatch => ({
        messagesJson: batch.messagesJson,
        ...(batch.hashes === undefined ? {} : { hashes: batch.hashes }),
        // Only this batch's, so the map is sent once per speaker, not once per batch.
        speakers: Object.fromEntries(batch.speakers.map((key) => [key, speakers.get(key) ?? null])),
        arrivalRefs: Object.fromEntries(
          batch.speakers.flatMap((key) => {
            const entity = speakers.get(key)
            const ref = entity == null ? undefined : session.arrivalRefs.get(entity)
            return ref === undefined ? [] : [[key, ref]]
          })
        )
      })

      const groupFields = (progress: ChatProgress) =>
        progress.link.group?.arrival === undefined
          ? {}
          : { groupArrival: progress.link.group.arrival, groupId: progress.link.group.id }

      /** A confirmed re-import's batch, held in the writer until its file is written whole. */
      const stageBatch = (
        session: Session,
        user: User,
        progress: ChatProgress,
        batch: Batch,
        speakers: ReadonlyMap<string, EntityId | null>
      ) =>
        writer.StImportStage({
          userId: user.id,
          lease: session.id,
          path: progress.path,
          seq: progress.staged++,
          batchJson: JSON.stringify(batchFields(session, batch, speakers))
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
            ...batchFields(session, batch, speakers),
            ...groupFields(progress)
          })
          if (stepWriteProgress(progress, written, progress.prevEnd, progress.hiddenRun, progress.summaries)) {
            // As the record now says, for this run sending the chat again from its start.
            const cached = session.records.get(progress.path)
            if (cached !== undefined && !cached.complete) {
              session.records.set(progress.path, { ...cached, firstAdded: cached.firstAdded ?? progress.firstAdded })
            }
          }
        })

      /** What the file's chat state becomes, from what the file says and the slots it went to. */
      const stateChangeOf = (session: Session, progress: ChatProgress) =>
        chatStateChange(
          session,
          {
            link: progress.link,
            header: progress.header,
            spoke: progress.spoke,
            selectedPersona: progress.selectedPersona,
            summaries: progress.summaries,
            messages: progress.index,
            run: { length: progress.hiddenRun, firstSlot: progress.firstSlot, throughSlot: progress.throughSlot }
          },
          progress.prevState,
          progress.isNew
        )
      type StateChange = ReturnType<typeof stateChangeOf>

      /** What the report says of a finished file; `applies`: its state went in. */
      const finishIssues = (session: Session, progress: ChatProgress, change: StateChange, applies: boolean) => {
        const { report } = session
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
            "ST sent the character's own author's note in place of this chat's; both are kept here, at the default author's note's place."
          )
        }
        if (change.ridersElsewhere !== null) {
          report.issue(
            progress.path,
            "warning",
            "st.author_note_riders",
            "ST put a persona's description, a character's own author's note or lorebook entries at these chats' own author's note. Here they're where ST's default author's note is, the same place in every chat, so they may land elsewhere in the prompt than in ST.",
            change.ridersElsewhere
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
        if (!applies && JSON.stringify(change.state) !== JSON.stringify(progress.prevState)) {
          report.issue(
            progress.path,
            "info",
            "st.state_unchanged",
            "The chat's settings changed in ST, but it brought no new message to attach the change to."
          )
        }
      }

      /** The finish's notes, each dated as the file or the settings it came from. */
      const datedNotes = (session: Session, progress: ChatProgress, change: StateChange) =>
        change.notes.map((note) => ({
          ...note,
          modifiedAt:
            note.kind === "author_note" && progress.header?.authorNote == null
              ? (session.settingsModifiedAt ?? progress.modifiedAt)
              : progress.modifiedAt
        }))

      /** After the file's finish is stored: the record as the run now knows it, and the report. */
      const finished = (
        session: Session,
        progress: ChatProgress,
        target: Target,
        change: StateChange,
        applies: boolean,
        notes: Readonly<Record<string, EntityId>>
      ) => {
        const { report } = session
        session.records.set(progress.path, {
          ...target,
          complete: true,
          binned: false,
          merged: progress.branch,
          state: applies ? change.state : progress.prevState,
          notes,
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
      }

      /** Writes the chat's state and makes it active, once its last part is in. */
      const finishChat = (session: Session, user: User, progress: ChatProgress, target: Target) =>
        Effect.gen(function* () {
          const change = stateChangeOf(session, progress)
          const { position, applies, leaf } = stFinishAt(progress)
          finishIssues(session, progress, change, applies)
          const stored = yield* writer.StImportFinishChat({
            lease: session.id,
            userId: user.id,
            chatId: target.chatId,
            recordId: target.recordId,
            position,
            events: applies ? change.events : [],
            notes: applies ? datedNotes(session, progress, change) : [],
            removedNotes: applies ? change.removedNotes : [],
            previousNotes: progress.prevNotes,
            leaf,
            end: progress.cursor,
            lastMessageAt: progress.lastMessageAt,
            sha256: stPartsHash(progress.partHashes),
            stateJson: JSON.stringify(applies ? change.state : progress.prevState),
            fork: progress.fork,
            stCurrent: progress.stCurrent
          })
          return finished(session, progress, target, change, applies, stored.notes)
        })

      /**
       * A file of a confirmed re-import not imported, as the report says: what it would do now
       * isn't what the check showed. Nothing of it was written; what the writer held goes.
       */
      const refuse = (session: Session, user: User, path: string, countAs: string, staged: boolean) =>
        Effect.gen(function* () {
          if (staged)
            yield* writer
              .StImportStage({ userId: user.id, lease: session.id, path, seq: 0, batchJson: null })
              .pipe(Effect.catch(() => Effect.void))
          session.report.issue(path, "warning", CHANGED_SINCE_CHECK, "Changed since the check. Not imported.")
          session.report.count(countAs, "skipped")
          return result("skipped", "Changed since the check. Not imported.")
        })

      /**
       * A confirmed re-import's file, once its last part is in and matches the bytes checked:
       * all of it in one transaction (`StImportCommitChat`), which writes nothing unless its
       * chat is as the check read it (or as this run's own writes left it) and its messages
       * place as the check showed.
       */
      const commitChat = (session: Session, user: User, progress: ChatProgress, exact: StPlanExpectFile) =>
        Effect.gen(function* () {
          const stamp = session.stamps.get(exact.chatId)
          if (stamp === undefined) return null
          // The finish names the slots of the file's messages by their places in it; the
          // transaction takes the slots they go to.
          for (const summary of progress.summaries)
            if (summary.index < progress.index) summary.slot = stIndexSlot(summary.index)
          progress.firstSlot = progress.index > 0 ? stIndexSlot(0) : null
          progress.throughSlot = progress.hiddenRun > 0 ? stIndexSlot(progress.hiddenRun - 1) : null
          const change = stateChangeOf(session, progress)
          const own = progress.target
          const committed = yield* writer.StImportCommitChat({
            userId: user.id,
            lease: session.id,
            path: progress.path,
            chatId: exact.chatId as ChatId,
            stamp,
            claim:
              own === null
                ? null
                : {
                    recordId: own.recordId,
                    ...(progress.claimParent === undefined ? {} : { parentRecordId: progress.claimParent })
                  },
            start:
              own === null && progress.fork !== null
                ? { parentRecordId: progress.fork.parentRecordId, ...startFields(progress) }
                : null,
            batches: progress.staged,
            advanceLeaf: progress.isNew,
            strict: progress.branch,
            matching: progress.matching,
            ...groupFields(progress),
            finish: {
              isNew: progress.isNew,
              branch: progress.branch,
              prevEnd: progress.prevEnd,
              resumeAt: progress.resumeAt,
              hiddenRun: progress.hiddenRun,
              events: change.events,
              notes: datedNotes(session, progress, change),
              previousNotes: progress.prevNotes,
              removedNotes: change.removedNotes,
              lastMessageAt: progress.lastMessageAt,
              sha256: stPartsHash(progress.partHashes),
              stateJson: JSON.stringify(change.state),
              prevStateJson: JSON.stringify(progress.prevState),
              fork: progress.fork,
              stCurrent: progress.stCurrent
            },
            slotsAt: progress.summaries.filter((s) => s.index < progress.index).map((s) => s.index),
            expect: exact.uncertain ? null : { counts: exact.counts, digest: exact.digest, keepsTip: exact.keepsTip }
          })
          progress.staged = 0
          Object.assign(progress, committed.progress)
          for (const summary of progress.summaries) {
            const slot = committed.slots[summary.index]
            if (slot === undefined) delete summary.slot
            else summary.slot = slot
          }
          session.stamps.set(exact.chatId, committed.stamp)
          const target: Target = { chatId: committed.chatId, recordId: committed.recordId }
          progress.target = target
          if (own === null) session.report.chat(progress.path, target.chatId)
          if (progress.userTurns === 0) {
            session.report.issue(
              progress.path,
              "info",
              "st.no_user_turn",
              "This chat has no message of yours; it was imported all the same."
            )
          }
          // The report as the finish's own writes worked it out, with the slots they went to.
          const stored = stateChangeOf(session, progress)
          const { applies } = stFinishAt(progress)
          finishIssues(session, progress, stored, applies)
          return finished(session, progress, target, stored, applies, committed.notes)
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
        // Where it goes, as the re-import preview also works it out (stChatTarget.ts).
        const target = stChatTarget(session.records, path, parentPath, request.orphan)
        const own = target._tag === "bin" ? target.own : target._tag === "chat" ? target.own : undefined
        if (target._tag === "bin") {
          report.count(file.kind, "skipped")
          report.issue(
            path,
            "warning",
            "st.in_bin",
            "The chat an earlier import made of this file is in your recycle bin, so it wasn't imported again: restore it there, or delete it for good and import the folder again."
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
              "info",
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

        if (target._tag === "deferred") return result("deferred", "Its parent chat isn't in yet.")
        const { parent, parentLive, branch, into } = target
        if (target.orphan) {
          report.issue(
            path,
            "info",
            "st.orphan_branch",
            "This branch's parent chat wasn't in the folder, so it became a chat of its own."
          )
        }
        // ST's record of the chat it opens the card or group on, which the chat opens on here.
        const stCurrent =
          file.kind === "group_chat"
            ? link.group !== null && link.group.chatId === file.name
            : link.card !== null && link.card.file === file.folder && link.card.lastChat === file.name
        // Its state so far: the record's when complete; for a branch not yet finished, its parent's.
        const previous = own?.complete ? own : branch ? parentLive : undefined
        if (own !== undefined) report.chat(path, own.chatId)
        return {
          path,
          countAs: file.kind,
          modifiedAt: request.modifiedAt ?? session.importedAt,
          nextPart: 0,
          title: stChatTitle(
            file.name,
            mainChat,
            file.kind === "group_chat" ? (link.group?.name ?? "") : null,
            link.group?.members.map((member) => session.cards.get(stem(member))?.name ?? null)
          ),
          header,
          link,
          target: own === undefined ? null : { chatId: own.chatId, recordId: own.recordId },
          into: into?.chatId ?? null,
          // A chat whose first import never finished has no state yet: it's finished as new.
          isNew: !branch && !(own?.complete ?? false),
          branch,
          fork: branch && parent !== undefined ? { parentRecordId: parent.recordId } : null,
          stCurrent,
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
          firstAt: null,
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
          selectedPersona: defaultPersona(session, header),
          partHashes: [],
          content: null,
          added: 0,
          updated: 0,
          differing: 0,
          exact: null,
          staged: 0,
          claimParent: undefined
        }
      }

      /**
       * Whether a confirmed re-import takes the file where it's going now: where the check
       * mapped it, a file the check read; a chat of its own, one it didn't.
       */
      const sameRoute = (exact: StPlanExpect, progress: ChatProgress, expected: StPlanExpectFile | undefined) => {
        const own = progress.target
        if (expected === undefined) return own === null && (progress.into === null || !exact.stamps.has(progress.into))
        return own === null
          ? expected.recordId === null && progress.into === expected.chatId && progress.fork !== null
          : own.recordId === expected.recordId && own.chatId === expected.chatId
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
          // Held to the check: its bytes hashed as they come, before the parse takes them.
          const content =
            session.exact === null ? null : request.part === 0 ? stBytesHash() : (session.chat?.content ?? null)
          content?.update(bytes)
          const part = yield* formats.st.chatPart({
            bytes,
            first: request.part === 0,
            firstIndex: session.chat?.index ?? 0,
            carryAt: session.chat?.lastAt ?? null,
            fallbackAt: session.chat?.modifiedAt ?? request.modifiedAt ?? session.importedAt
          })
          report.file(path, part.report)
          if (part.report.issues.some((issue) => issue.level === "error")) {
            yield* dropChat(session)
            report.count(file.kind, "failed")
            return result("failed", part.report.issues.find((i) => i.level === "error")!.message)
          }
          if (session.chat === null) {
            // A confirmed re-import takes only the files the check listed, where it mapped them.
            const exact = session.exact
            const expected = exact?.files.get(path)
            if (exact !== null) {
              if (exact.skip.has(path)) {
                report.count(file.kind, "skipped")
                return result("skipped", "Skipped.")
              }
              if (!exact.listed.has(path) || (expected !== undefined && session.records.get(path)?.binned))
                return yield* refuse(session, user, path, file.kind, false)
            }
            // A file imported before: this run takes its record over, as the record is now.
            const cached = session.records.get(path)
            const parentRecordId =
              part.header?.mainChat == null
                ? undefined
                : session.records.get(stParentPath(file, part.header.mainChat))?.recordId
            // A confirmed re-import's file takes it over only as it writes the file, in one go.
            if (cached !== undefined && !cached.binned && exact === null) {
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
            if (exact !== null) {
              if (!sameRoute(exact, begun, expected)) return yield* refuse(session, user, path, file.kind, false)
              begun.exact = expected ?? null
              begun.claimParent = parentRecordId
              begun.content = content
            }
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
          progress.firstAt ??= part.firstAt
          progress.lastAt = part.lastAt
          if (part.lastAt !== null) progress.lastMessageAt = Math.max(progress.lastMessageAt ?? 0, part.lastAt)
          progress.nextPart = request.part + 1
          report.messages += part.messages

          // A chat of one message, not the user's, is the greeting-only chat ST makes by opening a
          // card (DESIGN §1.4): skipped, whether or not an earlier import has it. Its first
          // message waits until a second one comes or the file ends, however its parts fall.
          const speakers = speakerMap(session, progress.link, progress.header, part.speakers, progress.spoke)
          if (part.userTurns > 0)
            progress.selectedPersona =
              part.lastUserSpeaker === null ? null : (speakers.get(part.lastUserSpeaker) ?? null)
          const exact = progress.exact
          // The bytes the check read, or nothing of the file goes in.
          if (exact !== null && request.last && progress.content?.digest("hex") !== exact.sha256) {
            yield* dropChat(session)
            return yield* refuse(session, user, path, file.kind, progress.staged > 0)
          }
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
          if (exact !== null) {
            for (const held of progress.pending.splice(0))
              yield* stageBatch(session, user, progress, held.batch, held.speakers)
            for (const batch of part.batches) yield* stageBatch(session, user, progress, batch, speakers)
            if (!request.last) return result("continue")
            const outcome = yield* commitChat(session, user, progress, exact).pipe(
              Effect.catchTags({
                StImportPlanChanged: () => Effect.succeed(null),
                ImportLeaseLost: () => Effect.succeed(null),
                NotFound: () => Effect.succeed(null)
              })
            )
            yield* dropChat(session)
            if (outcome === null) return yield* refuse(session, user, path, file.kind, progress.staged > 0)
            report.count(file.kind, outcome)
            return result(outcome)
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

      const fileArrival = (request: ChatRequest, importedAt: number): StArrival => {
        const times = [sourceTime(request.birthAt), sourceTime(request.modifiedAt)].filter(
          (at): at is number => at !== null && at > 0
        )
        return times.length ? { at: Math.min(...times), basis: 2 } : { at: importedAt, basis: 3 }
      }

      const file = (user: User, importId: string, path: string, bytes: Uint8Array, request: ChatRequest) =>
        Effect.gen(function* () {
          const session = yield* sessionOf(user, importId)
          const kind = classifyStPath(path)
          const handler = kind === null ? undefined : handlers.get(kind.kind)
          if (kind === null || kind.kind === "unsupported") {
            return result("failed", "This file isn't one the import reads.")
          }
          if (handler === undefined) {
            const message = `The ${kind.kind} folder import handler is disabled.`
            session.report.issue(path, "error", "st.handler_disabled", message)
            session.report.count(kind.kind, "failed")
            return result("failed", message)
          }
          return yield* handler.run({
            session,
            user,
            importId,
            path,
            file: kind,
            bytes,
            request: {
              ...request,
              modifiedAt: sourceTime(request.modifiedAt) ?? session.importedAt,
              arrival: fileArrival(request, session.importedAt)
            }
          })
        })

      const chatHandler = (kind: "chat" | "group_chat") =>
        on(kind, ({ session, user, path, file, bytes, request }) =>
          Effect.gen(function* () {
            return yield* chatFile(session, user, path, file, bytes, request).pipe(
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
                    session.report.count(file.kind, "skipped")
                    return Effect.succeed(result("skipped", "in the recycle bin"))
                  }
                  if (error.entity === "slot" || error.entity === "import record") {
                    return Effect.succeed(
                      result("restart", "The chat changed meanwhile; send it again from its start.")
                    )
                  }
                  session.report.count(file.kind, "failed")
                  return Effect.succeed(result("failed", "A card it names isn't in your library."))
                }
              })
            )
          })
        )

      // The built-in handlers register the way a plugin's will (PLUGINS §8): its own, under
      // the same kind, replaces one for the scope it is registered in.
      const builtins: ReadonlyArray<StFolderHandler> = [
        on("settings", ({ session, user, importId, path, bytes, request }) =>
          Effect.gen(function* () {
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
            session.settingsModifiedAt = request.modifiedAt ?? session.importedAt
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
            return result("added")
          })
        ),
        on("persona_avatar", ({ session, user, path, file, bytes, request }) =>
          personaFile(
            session,
            user,
            path,
            file.file,
            bytes,
            request.modifiedAt!,
            stIdTime(file.file) === null ? request.arrival! : { at: stIdTime(file.file)!, basis: 0 }
          )
        ),
        on("card", ({ session, user, path, file, bytes, request }) =>
          cardFile(session, user, path, file.file, bytes, request.modifiedAt!, request.arrival!)
        ),
        on("gallery", ({ session, user, file, bytes }) =>
          Effect.gen(function* () {
            const targets = session.galleryCards.get(file.folder) ?? []
            if (targets.length === 0) {
              session.report.count("gallery", "skipped")
              return result("skipped")
            }
            const image = describeImage(bytes)
            if (!image.mime.startsWith("image/")) {
              session.report.count("gallery", "failed")
              return result("failed", "The gallery file is not an image.")
            }
            const sha256 = createHash("sha256").update(bytes).digest("hex")
            yield* holding(
              [sha256],
              Effect.gen(function* () {
                yield* storeMedia(config.dataDir, sha256, bytes)
                for (const refId of targets) {
                  const ref = yield* reader.GetLibraryRef({ userId: user.id, refId })
                  yield* writer.AddCardAsset({
                    userId: user.id,
                    refId,
                    expectedRowVersion: ref.rowVersion,
                    name: stem(file.file).slice(0, 255),
                    media: { role: "asset", uri: "", sha256, byteSize: bytes.byteLength, ...image }
                  })
                }
              })
            )
            session.report.count("gallery", "added")
            return result("added")
          })
        ),
        on("world", ({ session, user, path, file, bytes, request }) =>
          libraryFile(session, user, path, `${file.name}.json`, bytes, "lorebook", file.name, request.modifiedAt!)
        ),
        on("preset", ({ session, user, path, file, bytes, request }) =>
          libraryFile(session, user, path, `${file.name}.json`, bytes, "preset", file.name, request.modifiedAt!)
        ),
        on("group", ({ session, path, file, bytes, request }) =>
          Effect.gen(function* () {
            const parsed = yield* formats.st.group(bytes, file.file)
            session.report.file(path, parsed.report)
            const group = parsed.group
            if (group === null) {
              session.report.count("group", "failed")
              return result("failed")
            }
            const size = [group.name, ...group.members, ...group.disabledMembers, ...group.chats].reduce(
              (sum, text) => sum + text.length + 16,
              0
            )
            if (!hold(session, path, "group", size)) return result("failed", "too much in one import")
            for (const chat of group.chats)
              session.groups.set(chat, {
                ...group,
                arrival: group.stAddedAt == null ? request.arrival! : { at: group.stAddedAt, basis: 0 }
              })
            // A group isn't kept as an entry, only read for its chats' casts: counted as read.
            session.report.count("group", "unchanged")
            return result("added")
          })
        ),
        chatHandler("chat"),
        chatHandler("group_chat")
      ]
      for (const handler of builtins) yield* handlers.register(handler)

      /**
       * Where ST's global World Info books went, measured on each read: attached to the preset
       * ST had selected, in the library unattached, or not in the folder.
       */
      const globalWorldIssues = (session: Session): ReadonlyArray<StIssue> => {
        const names = session.settings?.globalWorlds ?? []
        if (names.length === 0) return []
        const quoted = (books: ReadonlyArray<string>) => books.map((book) => `“${shownText(book)}”`).join(", ")
        const attached = session.globalAttached
        const issues: Array<StIssue> = []
        if (attached !== null)
          issues.push(
            new StIssue({
              path: "settings.json",
              level: "info",
              code: "st.global_worlds_attached",
              message: `Attached ST's global World Info ${attached.books.length === 1 ? "book" : "books"} ${quoted(attached.books)} to the preset “${shownText(attached.preset)}”.`
            })
          )
        const unattached = names.filter((name) => session.worlds.has(name) && !attached?.books.includes(name))
        if (unattached.length > 0) {
          const selected = session.settings?.selectedPreset ?? null
          const why =
            selected === null
              ? "ST had no preset selected"
              : attached?.preset === selected
                ? `${unattached.length === 1 ? "it was" : "they were"} imported after the preset “${shownText(selected)}”`
                : `ST's selected preset “${shownText(selected)}” wasn't imported`
          issues.push(
            new StIssue({
              path: "settings.json",
              level: "warning",
              code: "st.global_worlds_unattached",
              message: `ST applies the World Info ${unattached.length === 1 ? "book" : "books"} ${quoted(unattached)} to every chat; ${unattached.length === 1 ? "it is" : "they are"} in your library but attached to no preset, since ${why}.`
            })
          )
        }
        // A book ST applies to every chat that the folder didn't hold is used nowhere here.
        for (const name of names.filter((name) => !session.worlds.has(name) && !session.missingWorlds.has(name)))
          issues.push(
            new StIssue({
              path: "settings.json",
              level: "warning",
              code: "st.global_world_missing",
              message: `ST applies the lorebook “${shownText(name)}” to every chat, but it wasn't in the folder, so it isn't used here.`
            })
          )
        return issues
      }

      return StImports.of({
        start: (user, unsupported, expect) =>
          start(user, unsupported, expect).pipe(
            Effect.catch((error) =>
              Effect.logError("starting an ST import failed", error).pipe(
                Effect.andThen(Effect.fail(new ServerError({ message: "The import couldn't start." })))
              )
            )
          ),
        report: (user, importId) =>
          Effect.map(sessionOf(user, importId), (session) => session.report.build(globalWorldIssues(session))),
        file: (user, importId, path, bytes, request) =>
          file(user, importId, path, bytes, request).pipe(
            Effect.catch((error): Effect.Effect<never, NotFound | StImportFailed> =>
              error instanceof NotFound
                ? Effect.fail(error)
                : Effect.logError("an ST import failed", error).pipe(Effect.andThen(Effect.fail(new StImportFailed())))
            )
          ),
        unhidden: (user, chatId) => void sessions.get(user.id)?.report.hiddenRuns.delete(chatId),
        exists: (user, importId) => sessions.get(user.id)?.id === importId,
        end: (user, importId) => {
          if (sessions.get(user.id)?.id === importId) sessions.delete(user.id)
        },
        sourcesOf: (user, importId, entityId) => {
          const session = sessions.get(user.id)
          if (session?.id !== importId) return []
          return [...session.library].flatMap(([path, entry]) => (entry.entityId === entityId ? [path] : []))
        },
        handlers
      })
    })
  )
}
