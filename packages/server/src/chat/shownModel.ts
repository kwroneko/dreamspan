// The model the composer shows at a reply (spec/AGENTIC.md §12.3): the chat's binding as it
// stands after the reply, so a model chosen while a stopped or failed reply is the last one
// applies when that reply is resumed, continued or given a new version. A generation's own
// assembly reads the state before the reply, which leaves such a choice out.
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { type FoldableEvent, foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { GenerationDefaults } from "@rp/shared/generation.ts"

export interface ShownModel {
  readonly connection: ConnectionId
  readonly model: ModelId
}

/** Resolve the default here too: assembly at the parent must not recover a removed binding. */
export const shownModel = <E>(
  reader: {
    readonly GetGenerationDefaults: (payload: { readonly userId: UserId }) => Effect.Effect<GenerationDefaults, E>
    readonly StateEventsAt: (payload: {
      readonly userId: UserId
      readonly chatId: ChatId
      readonly slotId: SlotId | null
      readonly forkId: ForkId | null
      readonly displayEnd: boolean
    }) => Effect.Effect<ReadonlyArray<FoldableEvent>, E>
  },
  at: { readonly userId: UserId; readonly chatId: ChatId; readonly slotId: SlotId; readonly forkId: ForkId | null }
): Effect.Effect<ShownModel | null, E> =>
  Effect.gen(function* () {
    const events = yield* reader.StateEventsAt({ ...at, displayEnd: true })
    const binding = foldState(events).modelBindings[""]
    return binding
      ? { connection: binding.connection as ConnectionId, model: binding.model as ModelId }
      : (yield* reader.GetGenerationDefaults({ userId: at.userId })).model
  })
