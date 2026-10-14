// What produces a version's text. The real one will be the context assembler in front of
// the provider layer (PLAN phase 2); until it exists, only tests, the development server
// and the performance harness have one: the fake (fakeGenerator.ts).
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Context, Layer, Option, Schema, type Stream } from "effect"

/** A position in a chat to generate at: a new version of `slotId`, on the path through it. */
export interface GenerationRequest {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  /** "Retry with…": generates with this model instead of the chat's. */
  readonly model?: { readonly connection: ConnectionId; readonly model: ModelId }
  readonly onWaitingCache?: (waiting: boolean) => void
  /**
   * Continue: the version starts with this text and reasoning (the version it continues),
   * and what's generated is appended. The generator itself reads what it continues from the
   * version (its source), as the context assembler does.
   */
  readonly initial?: { readonly text: string; readonly reasoning: string }
}

/**
 * What a generator streams: text as plain strings, and the model's reasoning ("thinking")
 * apart from it, kept on the version and never sent back (DESIGN §7.4).
 */
export type GenerationChunk = string | { readonly reasoning: string }

/** Why a generation failed, as its failed version records it (DESIGN §3.1). */
export class GenerationFailed extends Schema.TaggedError<GenerationFailed>()("GenerationFailed", {
  class: Schema.String,
  message: Schema.String
}) {}

export interface GeneratorShape {
  /** The text as it's produced. Interrupting the stream stops the generation. */
  readonly generate: (request: GenerationRequest) => Stream.Stream<GenerationChunk, GenerationFailed>
}

/** The generator, if this server has one. Without one, generating is refused up front. */
export class Generator extends Context.Service<Generator, Option.Option<GeneratorShape>>()("rp/chat/Generator") {
  static readonly none = Layer.succeed(Generator)(Option.none())
}
