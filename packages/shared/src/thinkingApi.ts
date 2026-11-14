// Hiding a version's thinking from the model (SetThinkingHidden), in a group of its own:
// AppCoreApi is at TypeScript's instantiation depth (TS2589).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ForkId, PathEntry, ThinkingPart, VersionId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

export class ThinkingApi extends RpcGroup.make(
  /**
   * Hides a version's thinking from the model in fork `forkId` (absent or null: the fork
   * through its message), or sends it again: the provider's reasoning, or the thinking captured
   * from the reply by the preset's tags. It stays on the message, marked, and isn't sent in any
   * later request. Each version has its own; like any edit it never starts a generation.
   * Returns the message as that fork shows it.
   */
  Rpc.make("SetThinkingHidden", {
    payload: {
      versionId: VersionId,
      part: ThinkingPart,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      hidden: Schema.Boolean
    },
    success: PathEntry,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
