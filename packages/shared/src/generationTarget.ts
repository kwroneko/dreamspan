// A composer generation has an explicit destination and never invents message ids.
import { Schema } from "effect"
import { ChatId, ForkId, SlotId, VersionId } from "./chat.ts"

export const DraftGenerationTarget = Schema.Struct({
  kind: Schema.Literal("draft"),
  chatId: ChatId,
  forkId: ForkId,
  leafSlotId: Schema.NullOr(SlotId),
  draftId: Schema.String
})
export type DraftGenerationTarget = typeof DraftGenerationTarget.Type

export type GenerationTarget = DraftGenerationTarget | { readonly kind: "version"; readonly versionId: VersionId }
