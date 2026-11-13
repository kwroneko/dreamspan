import type { RolloutEffectRecord } from "@rp/shared/workshopApi.ts"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
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
  /** The writer, without what only the user may do: grants and approvals (`toolWriter`). */
  readonly writer: ToolWriter
  /** Values a tool works out once per rollout (the path, the summaries), by key. */
  readonly cache: Map<string, unknown>
  /** A one-call approval, checked again in the change's transaction. */
  readonly approvalDigest?: string
  readonly onChanged?: (chatId: ChatId) => void
  /**
   * A side chat's request: where its story tools read the story (spec/WORKSHOP.md §4), as the
   * browser tab the request came from showed it. Absent: nothing says where, so they don't read.
   */
  readonly storyAt?: import("@rp/shared/chat.ts").StoryAt
  /**
   * The run's frozen offer and what of it is loaded at this call (spec/TOOL-LOADING.md), for the
   * loading tools. Absent outside an agent run.
   */
  readonly offer?: {
    readonly kind: string
    readonly tools: ReadonlyArray<FrozenTool>
    readonly loaded: ReadonlySet<string>
    /** The offered skills, registered or card-carried, frozen with the run. */
    readonly cardSkills: ReadonlyArray<import("./toolLoading.ts").Skill>
  }
}

/** What a tool returns to the model: text, or a failure the model can correct. */
export interface ToolOutput {
  /** Non-atomic tools may record their already-applied changes with their result. */
  readonly effects?: ReadonlyArray<RolloutEffectRecord>
  readonly text: string
  readonly isError?: boolean
  /** Deferred tools this call loaded (spec/TOOL-LOADING.md): stored as the result's `details.loaded`. */
  readonly loaded?: ReadonlyArray<string>
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
  /**
   * A capability that applies to this call only, from its arguments and the run's offer: the
   * permit then decides as for a tool with that capability (`load_skill` for a card's own skill).
   */
  readonly capabilityFor?: (context: ToolContext, args: A) => string | undefined
  /** Argument used as the plain step title, frozen with setup-tool metadata. */
  readonly titleField?: string
  readonly effect: EffectClass
  /** False: never one of a story's reply tools (This chat's Tools list leaves it out), only a planner's. */
  readonly replyTool?: false
  /** Model-facing, with its usage guidance: when to call it and when not to. */
  readonly description: string
  readonly parameters: TSchema
  /** The step's one-line title from its arguments: “lighthouse”. */
  readonly summarize?: (args: A) => string
  /**
   * What the call will do, for its approval (spec/WORKSHOP.md §3.4), worked out by the server from
   * the real arguments and the items they name: the target's own name, an edit's fields before
   * and after. Absent: the arguments as they are.
   */
  readonly describe?: (
    context: ToolContext,
    args: A
  ) => Effect.Effect<Pick<ApprovalPrompt, "title" | "rows" | "changes">, unknown>
  readonly execute: (context: ToolContext, args: A) => Effect.Effect<ToolOutput>
}

/**
 * Operations only the user may run (spec/WORKSHOP.md §3.2: the agent can't give itself
 * anything): what the assistant may do, and answers to its requests.
 */
export const USER_ONLY_WRITES = [
  "SetWorkshopGrant",
  "AnswerToolApproval",
  "RequestToolApproval",
  "SettleToolApproval"
] as const
export type ToolWriter = Omit<Writer["Service"], (typeof USER_ONLY_WRITES)[number]>

/** The writer a tool is given: the same client, without the user-only operations. */
export const toolWriter = (writer: Writer["Service"]): ToolWriter => {
  const hidden = new Set<string | symbol>(USER_ONLY_WRITES)
  return new Proxy(writer, {
    get: (target, key, receiver) => (hidden.has(key) ? undefined : Reflect.get(target, key, receiver)),
    has: (target, key) => !hidden.has(key) && Reflect.has(target, key)
  })
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
  /** Declared but not loaded from the start: a loading tool makes it callable (spec/TOOL-LOADING.md). */
  readonly deferred?: true
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

/** A failed server preparation is a tool result, before any approval is requested. */
export class ToolInputRefused extends Error {}
