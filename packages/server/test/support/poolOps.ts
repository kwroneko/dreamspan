import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/** The operations of the test reader (poolWorker.ts). */
export const PoolOps = RpcGroup.make(
  /** Counts to `n` in SQLite, blocking the worker like a real query. Returns the worker's thread id. */
  Rpc.make("Count", { payload: { n: Schema.Number }, success: Schema.Number }),
  /** Ends the worker thread, as a crash would. */
  Rpc.make("Crash")
)
