import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/** The operations of the test reader (poolWorker.ts). */
export const PoolOps = RpcGroup.make(
  /** Counts to `n` in SQLite, blocking the worker like a real query. Returns the worker's thread id. */
  Rpc.make("Count", { payload: { n: Schema.Number }, success: Schema.Number }),
  /** Blocks the worker thread, as a query would, until readerPool.test.ts releases it. */
  Rpc.make("Hold"),
  /** Production scheduling names, with held handlers instead of long graph walks. */
  Rpc.make("ListForks"),
  Rpc.make("ShellMaterialize"),
  Rpc.make("GetDisplayPrefs", { success: Schema.Number }),
  Rpc.make("ListStImports", { success: Schema.Number }),
  /** Ends the worker thread, as a crash would. */
  Rpc.make("Crash"),
  /** Ends the first thread that runs it, as a crash would; a later run returns its thread id. */
  Rpc.make("CrashOnce", { success: Schema.Number }),
  /** Blocks like Hold, then ends the worker thread. */
  Rpc.make("HoldThenCrash"),
  /** Sends the pool an answer to a request it isn't running, then answers with its thread id. */
  Rpc.make("StrayExit", { success: Schema.Number }),
  /** The first thread that runs it sends the pool a protocol Defect; a later run returns its thread id. */
  Rpc.make("DefectOnce", { success: Schema.Number })
)
