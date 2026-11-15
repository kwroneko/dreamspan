// Composer-target generations keep their streaming handler group bounded.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { DraftGenerationTarget } from "./generationTarget.ts"
import { ChatId, ForkId } from "./chat.ts"
import { RunContext } from "./inspectorApi.ts"
import { NotFound, ServerError } from "./errors.ts"
const Errors = [NotFound, ServerError] as const
export class DraftGenerationApi extends RpcGroup.make(
  Rpc.make("WriteForMe", {
    payload: { target: DraftGenerationTarget },
    success: Schema.Struct({ rolloutId: Schema.String, text: Schema.String }),
    error: Schema.Union([...Errors]),
    stream: true
  }),
  Rpc.make("GetDraftRunContext", {
    payload: { rolloutId: Schema.String },
    success: RunContext,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("GetLastDraftRollout", {
    payload: { chatId: ChatId, forkId: ForkId },
    success: Schema.NullOr(Schema.String),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
