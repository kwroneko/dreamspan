// The Files quota (spec/FILES-AND-ENVIRONMENT.md §1.2): how much an account uses of it, for the
// Files panel and the upload UI, and an admin's quota for one account.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { UserId } from "./domain.ts"
import { Forbidden, NotFound, ServerError } from "./errors.ts"

export const FilesUsage = Schema.Struct({
  /** Files, versions, the bin, the home folder and kept command output together: what the quota counts. */
  usedBytes: Schema.Number,
  quotaBytes: Schema.Number,
  filesBytes: Schema.Number,
  versionsBytes: Schema.Number,
  homeBytes: Schema.Number,
  /** Commands' whole output, kept for a day. */
  outputBytes: Schema.Number,
  /** Files and folders in the bin, until it's emptied. */
  binBytes: Schema.Number,
  /** When the folders were last measured (they are again after each command and every 10 minutes). */
  measuredAt: Schema.Number,
  /** The account is over its quota: new writes, uploads and commands are refused. */
  over: Schema.Boolean,
  /** The measurement stopped at its limits, so the real usage is higher. */
  partial: Schema.Boolean,
  /** Bytes the account's commands sent and received over the internet since `networkSince` (not counted in the quota). */
  networkBytes: Schema.Number,
  /** When the count above began: the server's start. */
  networkSince: Schema.Number
})
export type FilesUsage = typeof FilesUsage.Type

/** The home folder can't be reset now (a command of the account is running). */
export class HomeResetRefused extends Schema.TaggedError<HomeResetRefused>()("HomeResetRefused", {
  message: Schema.String
}) {}

export class FilesQuotaApi extends RpcGroup.make(
  /** Your own usage; an admin may name another account. `fresh` measures again now. */
  Rpc.make("GetFilesUsage", {
    payload: { userId: Schema.optionalKey(UserId), fresh: Schema.optionalKey(Schema.Boolean) },
    success: FilesUsage,
    error: Schema.Union([Forbidden, NotFound, ServerError])
  }),
  /** Admin: one account's quota in bytes; null returns it to the instance default. */
  Rpc.make("SetFilesQuota", {
    payload: {
      userId: UserId,
      quotaBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
    },
    success: FilesUsage,
    error: Schema.Union([Forbidden, NotFound, ServerError])
  }),
  /**
   * Empties your own home folder for commands (spec/FILES-AND-ENVIRONMENT.md §3.6 Reset): what
   * commands installed and their settings. Your files stay. Refused while a command runs.
   */
  Rpc.make("ResetCommandHome", {
    payload: {},
    success: FilesUsage,
    error: Schema.Union([HomeResetRefused, ServerError])
  })
) {}
