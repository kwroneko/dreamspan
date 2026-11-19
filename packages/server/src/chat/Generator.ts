// What produces a version's text. The real one will be the context assembler in front of
// the provider layer (PLAN phase 2); until it exists, only tests, the development server
// and the performance harness have one: the fake (fakeGenerator.ts).
import type { ChatId, ForkId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import type { ReplySections } from "@dreamspan/shared/replySections.ts"
import type { RolloutStep } from "@dreamspan/shared/agent.ts"
import { Context, Layer, Option, Schema, type Stream } from "effect"

/** Transient authorization inherited by decision calls and tool rounds of this reply. */
export const AutoRequestGuard = Context.Reference<string | null>("rp/chat/AutoRequestGuard", {
  defaultValue: () => null
})

/** A position in a chat to generate at: a new version of `slotId`, on the path through it. */
export interface GenerationRequest {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  /**
   * The fork it's generated in, whose choices the context is read with. Absent: the fork
   * through the slot when it's read (the current one if its path holds the slot).
   */
  readonly forkId?: ForkId
  /** "Retry with…": generates with this model instead of the chat's. */
  readonly model?: { readonly connection: ConnectionId; readonly model: ModelId }
  /** An approved workshop send permits this reply only, without auxiliary provider workflows. */
  readonly autoGuard?: string
  readonly outputBudget?: { remaining: number }
  readonly replyOnly?: boolean
  /**
   * A side chat's request (spec/WORKSHOP.md §4): where its story tools read the story, as the
   * browser tab it was sent from showed it. Absent: the story can't be read for this reply.
   */
  readonly storyAt?: import("@dreamspan/shared/chat.ts").StoryAt
  readonly onNotice?: (message: string) => void
  readonly onWaitingCache?: (waiting: boolean) => void
  /**
   * Continue: the version starts with this text and reasoning (the version it continues),
   * and what's generated is appended. The generator itself reads what it continues from the
   * version (its source), as the context assembler does.
   */
  readonly initial?: {
    readonly text: string
    readonly reasoning: string
    /** Its reply sections: one left open (a cutoff inside it) is where the text goes on. */
    readonly sections?: ReplySections
  }
  /**
   * An agent reply carried on (spec/AGENTIC.md §4.2): its rollout is made already
   * (`StartResumedVersion`), with the stopped one's frozen snapshot; the run goes on from the
   * kept transcript (pi-agent-core messages), the cut-off text first when there's one.
   */
  readonly resume?: {
    readonly rolloutId: string
    readonly snapshot: string
    readonly transcript: ReadonlyArray<unknown>
    readonly continuation?: string
  }
}

/**
 * What a generator streams: text as plain strings, the model's reasoning ("thinking") apart
 * from it, kept on the version and never sent back (DESIGN §7.4), and the reply sections.
 */
export type GenerationChunk =
  | string
  | { readonly several: true }
  /** The replying character passed (`no_reply`, spec/REPLY-CONTRACT.md §3.1): the version is the silent line. */
  | { readonly silent: true }
  /** Finish this message through the ordinary parse/rewrite pipeline before the tool returns. */
  | {
      readonly post: {
        readonly rolloutId: string
        readonly toolCallId: string
        readonly resolve: (next: {
          readonly slotId: SlotId
          readonly versionId: VersionId
          readonly postedVersionId: VersionId
        }) => void
        readonly reject: (error: unknown) => void
      }
    }
  | { readonly reasoning: string }
  /**
   * The reply's leading tagged sections as parsed so far (a reply parser's, replySections.ts),
   * and the text this adds to their panel.
   */
  | { readonly sections: ReplySections; readonly text: string }
  /**
   * The text a reply parser holds back for now (a tag may be starting), where it goes if
   * the reply ends here: a stop, a crash or a failure keeps it. Replaces the last one held.
   */
  | { readonly held: string; readonly into: "body" | "section" }
  /**
   * What streamed so far wasn't the reply: the text, reasoning and sections start over from
   * where the generation began (an agent turn's text that turned out to precede a tool call,
   * spec/AGENTIC.md §2).
   */
  | { readonly restart: true }
  /** An agent reply's steps so far, all of them (spec/AGENTIC.md §5.1). */
  | { readonly steps: ReadonlyArray<RolloutStep>; readonly versionId?: VersionId }

/** Why a generation failed, as its failed version records it (DESIGN §3.1). */
export class GenerationFailed extends Schema.TaggedError<GenerationFailed>()("GenerationFailed", {
  class: Schema.String,
  message: Schema.String,
  /** A context-length error's stated limit and the model it applies to (`VersionError.contextLimit`). */
  contextLimit: Schema.optionalKey(Schema.Struct({ tokens: Schema.Int, modelId: Schema.String })),
  /**
   * A reply that was never sent (class `contract`): the text the model wrote instead, for the
   * ending check (spec/REPLY-CONTRACT.md §3.6). Never stored with the version.
   */
  unsent: Schema.optionalKey(Schema.String)
}) {}

export interface GeneratorShape {
  /** Provider-backed generation needs a model; local or plugin generators may not. */
  readonly requiresModel?: boolean

  /** Non-sensitive runtime identity for the production image smoke check. */
  readonly kind?: "provider" | "fake"

  /** The text as it's produced. Interrupting the stream stops the generation. */
  readonly generate: (request: GenerationRequest) => Stream.Stream<GenerationChunk, GenerationFailed>
}

/** The generator, if this server has one. Without one, generating is refused up front. */
export class Generator extends Context.Service<Generator, Option.Option<GeneratorShape>>()("rp/chat/Generator") {
  static readonly none = Layer.succeed(Generator)(Option.none())
}
