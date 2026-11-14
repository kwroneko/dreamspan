// Importing a SillyTavern data folder (DESIGN §1.4, ARCHITECTURE.md §13): the RPCs that
// start an import, read the folder from its path, read the report and act on the report's
// offers, merged into AppApi. Files picked in a browser on another machine go over HTTP
// instead (POST /st-import/file), like library uploads.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, SlotId } from "./chat.ts"
import { Forbidden, NotFound, ServerError } from "./errors.ts"
import { ImportIssueLevel } from "./importReport.ts"
import { StImportPlan, StImportPlanChanged, StPlanId, StPlanMessage } from "./stReimportPlan.ts"

export const StImportId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/))

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

/**
 * One thing the report asks the user to look at, for one file. The same `code` and `message` on
 * many files is one entry in the report, listing the files; `detail` is what's particular to this
 * file, and `chatId` the chat it went into, when it did.
 */
export class StIssue extends Schema.Class<StIssue>("StIssue")({
  path: Schema.String,
  level: ImportIssueLevel,
  code: Schema.String,
  message: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  chatId: Schema.optionalKey(ChatId)
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

/** A chat file of a folder picked in a browser, for the re-import preview: its path in the ST user's folder. */
const StPlanEntryInput = Schema.Struct({
  path: FolderPath,
  size: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  modifiedMs: Schema.NullOr(Schema.Number),
  mainChat: Schema.NullOr(FolderPath)
})

/**
 * The re-import preview the user confirmed, and the chat files they chose to skip. The import
 * starts only if the chats the preview read haven't changed since (`StImportPlanChanged`).
 */
export const StPlanChoice = Schema.Struct({
  planId: StPlanId,
  skip: Schema.Array(FolderPath).check(Schema.isMaxLength(50_000))
})
export type StPlanChoice = typeof StPlanChoice.Type

/**
 * Where an import job is (ARCHITECTURE.md §13): `interrupted` when the server stopped
 * during it, or an upload's files stopped arriving; importing the folder again goes on.
 */
export const StImportStatus = Schema.Literals(["running", "complete", "failed", "cancelled", "interrupted"])
export type StImportStatus = typeof StImportStatus.Type

/** A file of the import that didn't go in: refused, unreadable, or not sent. */
export class StNotSent extends Schema.Class<StNotSent>("StNotSent")({
  path: Schema.String,
  message: Schema.String
}) {}

/** One import of an ST folder, as the import page lists it. */
export class StImportJob extends Schema.Class<StImportJob>("StImportJob")({
  id: StImportId,
  /** `path`: the server reads the folder; `upload`: a browser sends its files. */
  mode: Schema.Literals(["path", "upload"]),
  /** The folder: its path on the server, or the name of the folder the browser picked. */
  source: Schema.String,
  status: StImportStatus,
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
  filesTotal: Schema.Int,
  filesDone: Schema.Int,
  bytesTotal: Schema.Number,
  bytesDone: Schema.Number,
  currentFile: Schema.NullOr(Schema.String),
  /** What was imported, by kind, as the report counts it. */
  counts: Schema.Record(Schema.String, StCount),
  /** How many things it asks the user to act on: issues, chats to link, hidden runs, files not sent. */
  attention: Schema.Int,
  /** Why it failed or stopped. */
  error: Schema.NullOr(Schema.String),
  /** The user has opened it since it finished. */
  seen: Schema.Boolean
}) {}

/** Arrival evidence: 0 metadata, 1 chat, 2 file, 3 import; ties keep the earliest date. */
export const StArrival = Schema.Struct({ at: Schema.Number, basis: Schema.Literals([0, 1, 2, 3]) })
export type StArrival = typeof StArrival.Type

/** A chat an ST import made, for the report's "Continue your latest chat". */
export class StImportedChat extends Schema.Class<StImportedChat>("StImportedChat")({
  chatId: ChatId,
  title: Schema.String,
  /** When it started (its first message), which its name's date is, never ST's file name's. */
  createdAt: Schema.optionalKey(Schema.Number),
  /** Its characters' names, which name it when its title doesn't. */
  names: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

/** A job with its report (null until it has one) and the files that didn't go in. */
export class StImportJobDetail extends Schema.Class<StImportJobDetail>("StImportJobDetail")({
  job: StImportJob,
  report: Schema.NullOr(StImportReport),
  notSent: Schema.Array(StNotSent),
  /** The user's imported chat with the latest message, not in the bin: any import's, so a re-run that added nothing has one. */
  latestChat: Schema.NullOr(StImportedChat)
}) {}

/** Another import of the user's is running: one at a time, since a new one stops the old one writing. */
export class StImportBusy extends Schema.TaggedError<StImportBusy>()("StImportBusy", {
  message: Schema.String
}) {}

/** The user's answer to a link choice: one of their cards, or `none`. */
const CardChoice = Schema.Union([EntityId, Schema.Literal("none")])

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
   * Which of these paths of an ST user's folder (as `stPlan` gives them) the caller's earlier
   * imports already hold, for the preview's "already here": library files recorded by their
   * path, and chats whose import finished. A file is read again when it's imported, so one
   * that changed since still goes in; an unfinished chat isn't here yet. With `folder` (one
   * named by its path: ScanStFolder's root and the ST user's prefix; admin only, as reading
   * it is), files are also read: a library file whose bytes an earlier import holds under
   * another path is known, and `skipped` lists the chats holding only a greeting, which no
   * import takes.
   */
  Rpc.make("StImportPreview", {
    payload: {
      paths: Schema.Array(FolderPath).check(Schema.isMaxLength(50_000)),
      folder: Schema.optionalKey(Schema.Struct({ root: FolderPath, prefix: FolderPath }))
    },
    success: Schema.Struct({ known: Schema.Array(Schema.String), skipped: Schema.Array(Schema.String) }),
    error: Schema.Union([Forbidden, StFolderUnreadable, ServerError])
  }),
  /**
   * Starts an upload import for the caller, ending any earlier upload of theirs (a running
   * path import refuses it). `unsupported` lists the paths of files the client found and
   * won't send, for the report.
   */
  Rpc.make("StartStImport", {
    payload: {
      unsupported: Schema.Array(Schema.String).check(Schema.isMaxLength(20_000)),
      /** For the job's row: the folder's name, and how many files and bytes the browser will send. */
      source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
      files: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      bytes: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
      plan: Schema.optionalKey(StPlanChoice)
    },
    success: Schema.Struct({ importId: StImportId }),
    error: Schema.Union([StImportBusy, StImportPlanChanged, ServerError])
  }),
  /**
   * Imports the ST user's folder `prefix` (one of `findStRoots`) of the folder at `path` on
   * the server, as a job that runs there until it's done, whatever the browser does. Admin only.
   */
  Rpc.make("StartStPathImport", {
    payload: { path: FolderPath, prefix: FolderPath, plan: Schema.optionalKey(StPlanChoice) },
    success: Schema.Struct({ importId: StImportId }),
    error: Schema.Union([Forbidden, StFolderUnreadable, StImportBusy, StImportPlanChanged, ServerError])
  }),
  /** The browser has sent every file of an upload: the job is complete, with the files it couldn't send. */
  Rpc.make("FinishStImport", {
    payload: { importId: StImportId, notSent: Schema.Array(StNotSent).check(Schema.isMaxLength(2_000)) },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** The caller's imports, newest first. */
  Rpc.make("ListStImports", {
    success: Schema.Array(StImportJob),
    error: ServerError
  }),
  Rpc.make("GetStImport", {
    payload: { importId: StImportId },
    success: StImportJobDetail,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Marks a finished import opened, so the app shell stops saying it finished. */
  Rpc.make("SeenStImport", {
    payload: { importId: StImportId },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Stops a running import after the file it's on. */
  Rpc.make("CancelStImport", {
    payload: { importId: StImportId },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Forgets one finished import, or (null) every finished one. Nothing it imported changes. */
  Rpc.make("ClearStImports", {
    payload: { importId: Schema.NullOr(StImportId) },
    success: Schema.Struct({ cleared: Schema.Int }),
    error: ServerError
  }),
  /**
   * Imports a chat of a path import's report with the card the user chose, read again from
   * the folder. Admin only, as reading the folder is; refused while another import runs.
   */
  Rpc.make("LinkStImportChat", {
    payload: { importId: StImportId, path: FolderPath, card: CardChoice },
    success: StFileResult,
    error: Schema.Union([Forbidden, NotFound, StFolderUnreadable, StImportBusy, ServerError])
  }),
  Rpc.make("GetStImportReport", {
    payload: { importId: StImportId },
    success: StImportReport,
    error: NotFound
  }),
  /** Un-hides an imported chat's messages from its first to `throughSlotId`, on its path. */
  Rpc.make("UnhideImportedRun", {
    /** `importId`: the import whose report offered it, which stops offering it. */
    payload: { chatId: ChatId, throughSlotId: SlotId, importId: Schema.optionalKey(StImportId) },
    success: Schema.Struct({ unhidden: Schema.Int }),
    error: Schema.Union([NotFound, ServerError])
  })
) {}

/**
 * The re-import preview (ARCHITECTURE.md §13), a group of its own: one handler layer over
 * all of AppCoreApi exceeds TypeScript's instantiation depth.
 */
export class StImportPlanApi extends RpcGroup.make(
  /**
   * Works out the re-import preview (ARCHITECTURE.md §13): for the chat files that go into
   * chats already here, what the import would do, with nothing written. `folder`: one named
   * by its path, read on the server (admin only, as reading it is). `files`: a folder picked in
   * the browser, its chat files in the import's order; `wanted` names those to send to
   * `POST /st-import/plan-file`. Ends the caller's earlier preview.
   */
  Rpc.make("StartStImportPlan", {
    payload: {
      folder: Schema.optionalKey(Schema.Struct({ root: FolderPath, prefix: FolderPath })),
      files: Schema.optionalKey(Schema.Array(StPlanEntryInput).check(Schema.isMaxLength(50_000)))
    },
    success: Schema.Struct({ plan: StImportPlan, wanted: Schema.Array(Schema.String) }),
    error: Schema.Union([Forbidden, StFolderUnreadable, ServerError])
  }),
  Rpc.make("GetStImportPlan", {
    payload: { planId: StPlanId },
    success: StImportPlan,
    error: NotFound
  }),
  /** A page of one file's changed messages. */
  Rpc.make("GetStImportPlanMessages", {
    payload: { planId: StPlanId, path: FolderPath, offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
    success: Schema.Struct({ messages: Schema.Array(StPlanMessage), total: Schema.Int }),
    error: NotFound
  }),
  /** Stops working out the preview; what it found so far stays readable. */
  Rpc.make("CancelStImportPlan", {
    payload: { planId: StPlanId },
    success: Schema.Void,
    error: NotFound
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
