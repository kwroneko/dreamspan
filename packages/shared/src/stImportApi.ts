// Importing a SillyTavern data folder (DESIGN §1.4, ARCHITECTURE.md §13): the RPCs that
// start an import, read its report and act on the report's offers, merged into AppApi. The
// files themselves go over HTTP (POST /st-import/file), like library uploads.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, SlotId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"
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

export class StImportApi extends RpcGroup.make(
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
