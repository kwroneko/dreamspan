import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

export class WorkshopApi extends RpcGroup.make(
  Rpc.make("CreateWorkshop", {
    payload: { title: Schema.optionalKey(Schema.String) },
    success: Chat,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
