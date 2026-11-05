// The center column's frames and tabs (client features/workbench), kept per account in
// `user_prefs` so a reload, or another device, opens them as the user left them.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ServerError } from "./errors.ts"

/** JSON the client writes and repairs on read, so a layout another version saved still opens. */
export const WorkbenchLayoutJson = Schema.String.check(Schema.isMaxLength(200_000))

/** Served separately to bound RPC handler inference, as the gallery's are. */
export class WorkbenchApi extends RpcGroup.make(
  /** The saved layout; null when none is. */
  Rpc.make("GetWorkbenchLayout", { payload: {}, success: Schema.NullOr(WorkbenchLayoutJson), error: ServerError }),
  /** Saves the layout. Text that isn't a JSON object is ignored. */
  Rpc.make("SetWorkbenchLayout", { payload: { layout: WorkbenchLayoutJson }, success: Schema.Void, error: ServerError })
) {}
