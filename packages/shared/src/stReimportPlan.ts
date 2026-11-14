// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): before an ST folder import
// writes anything, what it would do to the chats already here. Worked out on the server by a
// dry run of the import's own matcher over the folder's chat files, read-only. The import the
// user then confirms is held to it file by file: a file whose chat or bytes changed since is
// not imported, and the report says so (`ST_CHANGED_SINCE_CHECK`).
import { Schema } from "effect"
import { ChatId } from "./chat.ts"

export const StPlanId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/))

/**
 * What the import does with one message of a file, for the messages it changes:
 * - `swipes`: an existing message gains swipes it lacks.
 * - `selected`: the file's chosen swipe becomes the one shown.
 * - `kept`: the file shows another swipe, or hides it differently, and the user's choice
 *   here stays (`kept` says which).
 * - `new`: a new message.
 * - `branch`: a new message beside existing ones, starting a new branch there.
 */
const StPlanChange = Schema.Literals(["swipes", "selected", "kept", "new", "branch"])

export class StPlanMessage extends Schema.Class<StPlanMessage>("StPlanMessage")({
  /** Its position in the file, from 0. */
  index: Schema.Int,
  change: StPlanChange,
  /** Swipes it gains. */
  swipes: Schema.Int,
  /** Why the user's version stays: they chose, edited or hid it here, or deleted it. */
  kept: Schema.NullOr(Schema.Literals(["choice", "hidden", "deleted"])),
  user: Schema.Boolean,
  /** The start of the file's text for it, untrusted: rendered as text. */
  text: Schema.String
}) {}

export const StPlanCounts = Schema.Struct({
  unchanged: Schema.Int,
  newMessages: Schema.Int,
  newSwipes: Schema.Int,
  /** Messages whose shown swipe becomes the file's. */
  selected: Schema.Int,
  /** Messages where the user's own choice stays. */
  kept: Schema.Int,
  /** New branches started beside existing messages. */
  branches: Schema.Int
})
export type StPlanCounts = typeof StPlanCounts.Type

export const emptyPlanCounts: StPlanCounts = {
  unchanged: 0,
  newMessages: 0,
  newSwipes: 0,
  selected: 0,
  kept: 0,
  branches: 0
}

/**
 * Which chat a file goes into, as the import decides it:
 * - `existing`: imported from this file before.
 * - `unfinished`: an earlier import of this file stopped part way; this one finishes it.
 * - `branch`: a branch file whose parent file is already in a chat: a new branch there.
 * - `bin`: its chat is in the recycle bin, so the import skips it.
 * - `greeting`: it holds only a greeting, which no import takes.
 * - `failed`: it couldn't be read.
 */
export const StPlanTarget = Schema.Literals(["existing", "unfinished", "branch", "bin", "greeting", "failed"])
export type StPlanTarget = typeof StPlanTarget.Type

export class StPlanFile extends Schema.Class<StPlanFile>("StPlanFile")({
  path: Schema.String,
  target: StPlanTarget,
  chatId: Schema.NullOr(ChatId),
  /** The chat's title as stored (untrusted). */
  chatTitle: Schema.String,
  /** A branch's parent file. */
  parentPath: Schema.NullOr(Schema.String),
  status: Schema.Literals(["waiting", "checking", "done", "failed"]),
  counts: StPlanCounts,
  /** The user went on in this chat where the file changes: their branch stays where it is. */
  keepsTip: Schema.Boolean,
  /** Changed messages held for the detail list, and how many more there are. */
  messages: Schema.Int,
  moreMessages: Schema.Int,
  error: Schema.NullOr(Schema.String)
}) {}

export class StImportPlan extends Schema.Class<StImportPlan>("StImportPlan")({
  planId: StPlanId,
  status: Schema.Literals(["running", "done", "cancelled", "failed"]),
  filesTotal: Schema.Int,
  filesDone: Schema.Int,
  bytesTotal: Schema.Number,
  bytesDone: Schema.Number,
  currentFile: Schema.NullOr(Schema.String),
  /** The chat files that go into chats already here, in the import's order. */
  files: Schema.Array(StPlanFile),
  /** Chat files that become chats of their own. */
  newChats: Schema.Int,
  error: Schema.NullOr(Schema.String)
}) {}

/**
 * The check can't be held to: it isn't finished, or the folder chosen isn't the one checked,
 * so the import didn't start. In the writer, a file's chat or its messages changed since the
 * check, so nothing of that file was written.
 */
export class StImportPlanChanged extends Schema.TaggedError<StImportPlanChanged>()("StImportPlanChanged", {
  message: Schema.String
}) {}

/**
 * The report's issue code of a file a confirmed import didn't take: its chat or its bytes
 * changed since the check, so what it would do isn't what the check showed.
 */
export const ST_CHANGED_SINCE_CHECK = "st.changed_since_check"

/** Changed messages one file's detail list holds, and one page of it. */
export const PLAN_MESSAGES_HELD = 500
export const PLAN_MESSAGES_PAGE = 50
/** Characters of a message's text a detail row shows. */
export const PLAN_TEXT_CHARS = 160

/** A later file may match writes from any earlier file in the same chat. */
export const stPlanAffectedBySkip = (
  files: ReadonlyArray<Pick<StPlanFile, "path" | "chatId">>,
  skipped: ReadonlySet<string>
): ReadonlySet<string> => {
  const affected = new Set<string>()
  const missing = new Set<string>()
  for (const file of files) {
    if (file.chatId === null) continue
    if (skipped.has(file.path)) missing.add(file.chatId)
    else if (missing.has(file.chatId)) affected.add(file.path)
  }
  return affected
}
