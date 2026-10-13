// Importing a SillyTavern data folder (DESIGN §1.4, ARCHITECTURE.md §13): the RPCs that
// start an import, read the folder from its path, read the report and act on the report's
// offers, merged into AppApi. Files picked in a browser on another machine go over HTTP
// instead (POST /st-import/file), like library uploads.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, SlotId } from "./chat.ts"
import { Forbidden, NotFound, ServerError } from "./errors.ts"
import { ImportIssueLevel } from "./importReport.ts"

const StImportId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/))

/** What happened to the files of one kind. */
export class StCount extends Schema.Class<StCount>("StCount")({
  added: Schema.Int,
  /** An earlier import's entry or chat took the file's changes. */
  updated: Schema.Int,
  /** Already imported as it is. */
  unchanged: Schema.Int,
  skipped: Schema.Int,
  failed: Schema.Int
}) {}

/**
 * Messages hidden from message 0 on, ST's manual-summary pattern (DESIGN §1.4, §8.1): the
 * report offers to un-hide them. `summaryCovers` says whether the chat's imported summary
 * was made at or after the last of them, and is null without a summary.
 */
export class StHiddenRun extends Schema.Class<StHiddenRun>("StHiddenRun")({
  chatId: ChatId,
  title: Schema.String,
  hidden: Schema.Int,
  throughSlotId: SlotId,
  summaryCovers: Schema.NullOr(Schema.Boolean)
}) {}

/** A chat the importer couldn't link to a card on its own, for the user to choose. */
export class StLinkChoice extends Schema.Class<StLinkChoice>("StLinkChoice")({
  path: Schema.String,
  title: Schema.String,
  reason: Schema.String,
  candidates: Schema.Array(Schema.Struct({ entityId: EntityId, label: Schema.String }))
}) {}

export class StIssue extends Schema.Class<StIssue>("StIssue")({
  path: Schema.String,
  level: ImportIssueLevel,
  code: Schema.String,
  message: Schema.String
}) {}

export class StImportReport extends Schema.Class<StImportReport>("StImportReport")({
  /** By kind: `card`, `persona`, `lorebook`, `preset`, `chat`, `group_chat`. */
  counts: Schema.Record(Schema.String, StCount),
  messages: Schema.Int,
  summaries: Schema.Int,
  /** Chats of one message, not the user's: only a greeting, skipped (DESIGN §1.4). */
  greetingOnly: Schema.Int,
  /** Files ST has that this app doesn't read, by what they are (DESIGN §1.2). */
  unsupported: Schema.Array(Schema.Struct({ what: Schema.String, count: Schema.Int })),
  hiddenRuns: Schema.Array(StHiddenRun),
  links: Schema.Array(StLinkChoice),
  issues: Schema.Array(StIssue),
  /** Issues, offers or choices beyond what the report holds. */
  dropped: Schema.Int
}) {}

/** The answer to one uploaded file (or one part of a chat file). */
export class StFileResult extends Schema.Class<StFileResult>("StFileResult")({
  outcome: Schema.Literals([
    /** A part of a chat taken; send the next. */
    "continue",
    "added",
    "updated",
    "unchanged",
    "skipped",
    /** A branch whose parent chat isn't in yet: send it again after the others. */
    "deferred",
    /** The chat's card couldn't be told; the report lists the choices. */
    "needs_link",
    /** The server lost the earlier parts of this chat: send it again from the start. */
    "restart",
    "failed"
  ]),
  message: Schema.String
}) {}

/** A file in a folder named by its path, that the import reads or lists. */
export class StFolderEntry extends Schema.Class<StFolderEntry>("StFolderEntry")({
  /** Relative to the folder, `/`-separated. */
  path: Schema.String,
  size: Schema.Number,
  /** When it last changed: a file that changes during its import is refused, not mixed. */
  modifiedMs: Schema.Number,
  /** The parent a branch chat names (`main_chat`), so parents are imported first. */
  mainChat: Schema.NullOr(Schema.String)
}) {}

/** The folder or one of its files can't be read: missing, not a folder, or too large. */
export class StFolderUnreadable extends Schema.TaggedError<StFolderUnreadable>()("StFolderUnreadable", {
  message: Schema.String
}) {}

const FolderPath = Schema.String.check(Schema.isMaxLength(4096))

/** A folder in the import page's folder browser. */
export class FolderListing extends Schema.Class<FolderListing>("FolderListing")({
  path: Schema.String,
  /** Null at the top of the file system. */
  parent: Schema.NullOr(Schema.String),
  /** Subfolders, those that look like ST's (an install, its data, or one user's folder) marked. */
  folders: Schema.Array(Schema.Struct({ name: Schema.String, st: Schema.Boolean })),
  /** More subfolders than are listed. */
  truncated: Schema.Boolean
}) {}

export class StImportApi extends RpcGroup.make(
  /** A folder's subfolders for the folder browser, from the home folder when `path` is null. Admin only. */
  Rpc.make("ListFolder", {
    payload: { path: Schema.NullOr(FolderPath) },
    success: FolderListing,
    error: Schema.Union([Forbidden, StFolderUnreadable])
  }),
  /**
   * Lists the files of an ST folder at a path on the machine the app runs on (DESIGN §1.4).
   * Admin only: on an instance with several users, anyone else could read any user's files.
   */
  Rpc.make("ScanStFolder", {
    payload: { path: FolderPath },
    success: Schema.Struct({ root: Schema.String, files: Schema.Array(StFolderEntry) }),
    error: Schema.Union([Forbidden, StFolderUnreadable])
  }),
  /**
   * Imports one file of a scanned folder, or the part of a chat file from byte `start`:
   * `next` is where the next part starts, and `last` says the file is done.
   */
  Rpc.make("ImportStFolderFile", {
    payload: {
      importId: StImportId,
      /** The ST user's folder: the scanned root joined with the chosen user's prefix. */
      root: FolderPath,
      path: FolderPath,
      /** The file as the scan saw it: if it has changed since, it's refused. */
      size: Schema.Number,
      modifiedMs: Schema.Number,
      start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      part: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      /** The user's answer to a link choice: one of their cards, or `none`. */
      card: Schema.NullOr(Schema.Union([EntityId, Schema.Literal("none")])),
      orphan: Schema.Boolean
    },
    success: Schema.Struct({ result: StFileResult, next: Schema.Number, last: Schema.Boolean }),
    error: Schema.Union([Forbidden, NotFound, StFolderUnreadable, ServerError])
  }),
  /**
   * Starts an import for the caller, ending any earlier one of theirs. `unsupported` lists
   * the paths of files the client found and won't send, for the report.
   */
  Rpc.make("StartStImport", {
    payload: { unsupported: Schema.Array(Schema.String).check(Schema.isMaxLength(20_000)) },
    success: Schema.Struct({ importId: StImportId }),
    error: ServerError
  }),
  Rpc.make("GetStImportReport", {
    payload: { importId: StImportId },
    success: StImportReport,
    error: NotFound
  }),
  /** Un-hides an imported chat's messages from its first to `throughSlotId`, on its path. */
  Rpc.make("UnhideImportedRun", {
    payload: { chatId: ChatId, throughSlotId: SlotId },
    success: Schema.Struct({ unhidden: Schema.Int }),
    error: Schema.Union([NotFound, ServerError])
  })
) {}

const UNFINISHED = " (import unfinished)"

/** How a chat whose import hasn't finished is titled, so it says so anywhere it's named. [P] */
export const unfinishedTitle = (title: string) => `${title}${UNFINISHED}`

/** A chat's title without the unfinished-import marker, and whether it had it, for a badge instead. */
export const importState = (title: string) =>
  title.endsWith(UNFINISHED)
    ? { title: title.slice(0, -UNFINISHED.length), unfinished: true }
    : { title, unfinished: false }
