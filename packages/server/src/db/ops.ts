// Storage operations, executed inside the database worker threads (see ARCHITECTURE.md
// "Database"). Each write operation runs as one synchronous transaction inside the
// writer worker, so a transaction can never span an await or a network call.
import { User } from "@rp/shared/domain.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const StorageErrorReason = Schema.Literals(["busy", "constraint", "corrupt", "other"])

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  reason: StorageErrorReason,
  operation: Schema.String,
  message: Schema.String
}) {}

export class WriteOps extends RpcGroup.make(
  /** Answers once the writer has opened the database and run migrations. */
  Rpc.make("Ready"),
  Rpc.make("EnsureUser", {
    payload: { handle: Schema.String, displayName: Schema.String },
    success: User,
    error: StorageError
  })
) {}

export class ReadOps extends RpcGroup.make(
  Rpc.make("FindUserByHandle", {
    payload: { handle: Schema.String },
    success: Schema.NullOr(User),
    error: StorageError
  }),
  /** Diagnostic: a CPU-bound query of `n` steps that touches no table. Used by tests. */
  Rpc.make("CountTo", {
    payload: { n: Schema.Int },
    success: Schema.Int,
    error: StorageError
  })
) {}
