import type { RolloutEffectRecord } from "@rp/shared/workshopApi.ts"
// The tools a rollout may offer (spec/AGENTIC.md §4.1): a registered catalog, each tool with
// its effect class (DESIGN §7.3). Tools run on the main thread and reach storage only through
// the reader and writer operations, owner-scoped and causal: nothing at or after the slot
// being generated is visible to them.
import { Type, type TSchema } from "@earendil-works/pi-ai"
import type { ChatId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Effect } from "effect"
import type { Reader, Writer } from "../db/Database.ts"

/**
 * `read`: lookups, freely re-run. `chat_state`: state events attached to the generating
 * version, so a swipe reverses them. `external`: the library, settings, plugins, which an RP
 * turn never offers (DESIGN §7.3).
 */
type EffectClass = "read" | "chat_state" | "external" | "library" | "setup" | "outside"

export interface ToolContext {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly forkId: ForkId | null
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly rolloutId: string
  readonly toolCallId: string
  /** The message before the one being generated: nothing after it is visible. */
  readonly leafSlotId: SlotId | null
  /**
   * A separate context's viewer as its identities: the card, and those it replaced on this fork
   * (`card.swap`; spec/CHARACTER-CONTEXT.md §9.2 C5). The read tools leave out what it wasn't
   * present for; null: nothing left out.
   */
  readonly viewers: ReadonlyArray<string> | null
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  /** Values a tool works out once per rollout (the path, the summaries), by key. */
  readonly cache: Map<string, unknown>
}

/** What a tool returns to the model: text, or a failure the model can correct. */
export interface ToolOutput {
  /** Non-atomic tools may record their already-applied changes with their result. */
  readonly effects?: ReadonlyArray<RolloutEffectRecord>
  readonly text: string
  readonly isError?: boolean
}

export interface RolloutTool<A = never> {
  /** Kinds that must resolve this name through kindTools, including a disabled variant. */
  readonly kindOverrides?: ReadonlyArray<string>
  /** The name the model sees. */
  readonly id: string
  /** Short and user-facing, for the step's row: "Searched the chat". */
  readonly label: string
  /** User-facing, the chat settings' tools list: what it lets the model do, as a checkbox label. */
  readonly explanation?: string
  readonly capability?: string
  /** Argument used as the plain step title, frozen with setup-tool metadata. */
  readonly titleField?: string
  readonly effect: EffectClass
  /** Model-facing, with its usage guidance: when to call it and when not to. */
  readonly description: string
  readonly parameters: TSchema
  /** The step's one-line title from its arguments: “lighthouse”. */
  readonly summarize?: (args: A) => string
  readonly execute: (context: ToolContext, args: A) => Effect.Effect<ToolOutput>
}

/** The definition frozen into a rollout's snapshot: exactly what the model was offered. */
export interface FrozenTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly capability?: string
  readonly titleField?: string
  readonly effect: EffectClass
  readonly label: string
}

export const frozenTool = (tool: RolloutTool<never>): FrozenTool => ({
  name: tool.id,
  description: tool.description,
  parameters: tool.parameters,
  effect: tool.effect,
  ...(tool.capability ? { capability: tool.capability } : {}),
  ...(tool.titleField ? { titleField: tool.titleField } : {}),
  label: tool.label
})

/** The output contract is part of the offered toolset and its frozen snapshot too. */
export const sendMessageDefinition = {
  name: "send_message",
  label: "Sent the message",
  description:
    "Sends your reply: the next message of the story, written as it should appear. Call it once, when the reply is ready; it ends your turn.",
  parameters: Type.Object({ message: Type.String({ description: "The message, exactly as it should appear." }) }),
  effect: "read"
} satisfies FrozenTool

/** Several-message contracts share the tool shape, with instructions matching their loop. */
export const severalMessageDefinition: FrozenTool = {
  ...sendMessageDefinition,
  description:
    "Posts a message exactly as it should appear, then carries on working. You may call it several times. End the turn with a plain-text answer, which is posted as the last message."
}

/** Per-result cap on what a tool sends back, with the marker telling the model to narrow it. */
const RESULT_CHARS = 16_000
export const budgetResult = (text: string, limit = RESULT_CHARS) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Result cut at ${limit} characters: ask for less, or narrow the search.]`
