import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Forbidden } from "./errors.ts"

const AutoUpdateReason = Schema.Literals([
  "not_git",
  "wrong_branch",
  "dirty_worktree",
  "diverged",
  "unsupervised",
  "check_failed",
  "not_checked",
  "up_to_date"
])

export type AutoUpdateReason = typeof AutoUpdateReason.Type

const UpdateStatus = Schema.Struct({
  state: Schema.Literals(["idle", "checking", "updating", "restarting"]),
  automaticChecks: Schema.Boolean,
  currentCommit: Schema.NullOr(Schema.String),
  currentBranch: Schema.NullOr(Schema.String),
  branch: Schema.String,
  remoteCommit: Schema.NullOr(Schema.String),
  behindCount: Schema.Int,
  incoming: Schema.Array(Schema.Struct({ commit: Schema.String, subject: Schema.String })),
  canAutoUpdate: Schema.Boolean,
  autoUpdateReason: Schema.NullOr(AutoUpdateReason),
  lastCheckedAt: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String)
})

export type UpdateStatus = typeof UpdateStatus.Type

export class UpdateRejected extends Schema.TaggedError<UpdateRejected>()("UpdateRejected", {
  message: Schema.String
}) {}

export const UpdateApi = RpcGroup.make(
  Rpc.make("GetUpdateStatus", { success: UpdateStatus, error: Forbidden }),
  Rpc.make("CheckForUpdates", { success: UpdateStatus, error: Forbidden }),
  Rpc.make("ApplyServerUpdate", {
    success: Schema.Struct({ started: Schema.Literal(true), targetCommit: Schema.String }),
    error: Schema.Union([Forbidden, UpdateRejected])
  })
)

export const autoUpdateMessages: Record<AutoUpdateReason, string> = {
  not_git: "This server is running outside a Git checkout.",
  wrong_branch: "The checkout is on a different branch.",
  dirty_worktree: "The checkout has local changes.",
  diverged: "The checkout cannot fast-forward to the update branch.",
  unsupervised: "This server was started without the restart supervisor.",
  check_failed: "Check for updates again before installing.",
  not_checked: "Check for updates before installing.",
  up_to_date: "No update is available."
}
