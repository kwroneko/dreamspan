// The center column's frames and tabs (client features/workbench), kept per account and
// device in `user_prefs` so a reload opens them as the user left them on that device: a phone
// and a desktop each keep their own.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ServerError } from "./errors.ts"

/** JSON the client writes and repairs on read, so a layout another version saved still opens. */
export const WorkbenchLayoutJson = Schema.String.check(Schema.isMaxLength(200_000))

/**
 * A browser's own id (client features/workbench/device.ts), kept in its storage. Browsers that
 * can't keep one share the id `shared`.
 */
export const WorkbenchDevice = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))

/** Served separately to bound RPC handler inference, as the gallery's are. */
export class WorkbenchApi extends RpcGroup.make(
  /** The layout saved on this device; null when none is. */
  Rpc.make("GetWorkbenchLayout", {
    payload: { device: WorkbenchDevice },
    success: Schema.NullOr(WorkbenchLayoutJson),
    error: ServerError
  }),
  /** Saves this device's layout. Text that isn't a JSON object is ignored. */
  Rpc.make("SetWorkbenchLayout", {
    payload: { device: WorkbenchDevice, layout: WorkbenchLayoutJson },
    success: Schema.Void,
    error: ServerError
  }),
  /** Forgets every device's layout, so each opens at one tab. */
  Rpc.make("ForgetWorkbenchLayouts", { payload: {}, success: Schema.Void, error: ServerError })
) {}
