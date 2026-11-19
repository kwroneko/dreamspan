// The persona locked to a character (DESIGN §2.2, owner 2026-11-18): its own small group, kept
// outside the core handler group's type-size bound.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CastCard, EntityId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

export class PersonaLockApi extends RpcGroup.make(
  /**
   * The persona locked to a character of the user's: its new single chats start with it. Null
   * when none is locked, or the locked card is no longer a live persona.
   */
  Rpc.make("GetPersonaLock", {
    payload: { entityId: EntityId },
    success: Schema.NullOr(CastCard),
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Locks a persona to a character, or clears the lock (null). Chats already started keep theirs. */
  Rpc.make("SetPersonaLock", {
    payload: { entityId: EntityId, persona: Schema.NullOr(EntityId) },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
