// The Files quota (spec/FILES-AND-ENVIRONMENT.md §1.2): how much an account uses of it, for the
// Files panel and the upload UI, and an admin's quota for one account.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { UserId } from "./domain.ts"
import { Forbidden, NotFound, ServerError } from "./errors.ts"

export const FilesUsage = Schema.Struct({
  /** Files, versions and the home folder together: what the quota counts. */
  usedBytes: Schema.Number,
  quotaBytes: Schema.Number,
  filesBytes: Schema.Number,
  versionsBytes: Schema.Number,
  homeBytes: Schema.Number,
  /** When the folders were last measured (they are again after each command and every 10 minutes). */
  measuredAt: Schema.Number,
  /** The account is over its quota: new writes, uploads and commands are refused. */
  over: Schema.Boolean,
  /** The measurement stopped at its limits, so the real usage is higher. */
  partial: Schema.Boolean
})
export type FilesUsage = typeof FilesUsage.Type

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
  })
) {}
