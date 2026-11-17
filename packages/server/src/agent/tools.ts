import type { RolloutEffectRecord } from "@rp/shared/workshopApi.ts"
import type { ApprovalPrompt, SubagentRow } from "@rp/shared/agent.ts"
// The tools a rollout may offer (spec/AGENTIC.md §4.1): a registered catalog, each tool with
// its effect class (DESIGN §7.3). Tools run on the main thread and reach storage only through
// the reader and writer operations, owner-scoped and causal: nothing at or after the slot
// being generated is visible to them.
import { Type, type TSchema } from "@earendil-works/pi-ai"
import type { ChatId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { Reader, Writer } from "../db/Database.ts"

/**
 * `read`: lookups, freely re-run. `chat_state`: state events attached to the generating
 * version, so a swipe reverses them. `external`: the library, settings, plugins, which an RP
 * turn never offers (DESIGN §7.3).
 */
type EffectClass = "read" | "chat_state" | "external" | "library" | "setup" | "outside" | "mcp"

export interface ToolContext {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly forkId: ForkId | null
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly rolloutId: string
  readonly toolCallId: string
  /** The current run only, for recovering compacted steps. */
  readonly transcript?: () => ReadonlyArray<import("@earendil-works/pi-agent-core").AgentMessage>
  /** The message before the one being generated: nothing after it is visible. */
  readonly leafSlotId: SlotId | null
  /**
   * A separate context's viewer as its identities: the card, and those it replaced on this fork
   * (`card.swap`; spec/CHARACTER-CONTEXT.md §9.2 C5). The read tools leave out what it wasn't
   * present for; null: nothing left out.
   */
  readonly viewers: ReadonlyArray<string> | null
  /** Own-turn notes follow the speaker even in shared history. */
  readonly speaker?: string | null
  readonly reader: Reader["Service"]
  /** The run's model accepts images. */
  readonly vision?: boolean
  /** The writer, without what only the user may do: grants and approvals (`toolWriter`). */
  readonly writer: ToolWriter
  /** Values a tool works out once per rollout (the path, the summaries), by key. */
  readonly cache: Map<string, unknown>
  /** A one-call approval, checked again in the change's transaction. */
  readonly approvalDigest?: string
  /** New workshop results only; receipt producers use this before saving their final text. */
  readonly formatResult?: (text: string, frame?: string) => string
  readonly onChanged?: (chatId: ChatId) => void
  /**
   * A side chat's request: where its story tools read the story (spec/WORKSHOP.md §4), as the
   * browser tab the request came from showed it. Absent: nothing says where, so they don't read.
   */
  /** Workshop replay consults the live catalog without freezing metadata into model definitions. */
  readonly storyReadOf?: (id: string) => WorkshopStoryRead | undefined
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
  /** The run a subagent would be a child of (spec/SUBAGENTS.md); absent in a subagent's own run. */
  readonly subagentHost?: SubagentHost
}

/** What the `agent` tool needs of the run whose call starts a subagent (agent/subagents.ts). */
interface SubagentHost {
  readonly input: import("./session.ts").AgentStrategyInput
  readonly run: import("./session.ts").AgentRun
  /** The definitions the run was offered, as frozen: a child never gets more. */
  readonly offered: ReadonlyArray<FrozenTool>
  /** Shows the child in the call's step as it runs; null takes it out. */
  readonly show: (row: SubagentRow | null) => void
}

/** What a tool returns to the model: text, or a failure the model can correct. */
export interface ToolOutput {
  /** App-owned assertion from a result builder, never inferred from returned text. */
  readonly dataOnly?: true
  /** Mechanical metadata prepared by a structured result builder. */
  readonly frame?: string
  /** Already committed bytes: do not reformat on replay. */
  readonly replayed?: true
  /** Display metadata only, kept in the transcript but never sent to a model. */
  readonly presentation?: NonNullable<ApprovalPrompt["presentation"]>
  /** Non-atomic tools may record their already-applied changes with their result. */
  readonly effects?: ReadonlyArray<RolloutEffectRecord>
  readonly text: string
  readonly isError?: boolean
  /** Deferred tools this call loaded (spec/TOOL-LOADING.md): stored as the result's `details.loaded`. */
  readonly loaded?: ReadonlyArray<string>
  /** Images for a model that accepts them, after the text (an MCP server's, spec/MCP.md §9). */
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>
  /** The subagent an `agent` call started: kept with the result as `details.subagent`, never sent. */
  readonly subagent?: SubagentRow
}

export type WorkshopStoryRead = "positioned" | "conversation" | "library" | "account" | "refused"

export interface RolloutTool<A = never> {
  /** Shipped implementation, used only by the authenticated editable-copy catalog. */
  readonly source?: string
  /** Declares how a workshop tool reads story facts; deliberately not sent to the model. */
  readonly storyRead?: WorkshopStoryRead
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
  /**
   * What exactly this call would let in, as a digest, where "Allow in this workshop" must mean
   * that content and nothing else (a card's own skill, as written now). The answer is then
   * remembered for this digest only: changed content asks again. Absent: the capability's standing.
   */
  readonly approvalTarget?: (context: ToolContext, args: A) => string | undefined
  /** Argument used as the plain step title, frozen with setup-tool metadata. */
  readonly titleField?: string
  readonly effect: EffectClass
  /** Mandatory consent, or a separately validated reversible rollback. Off still refuses. */
  readonly approval?: "always" | "rollback"
  readonly adminOnly?: true
  /** A tool of an MCP server (spec/MCP.md §4.2): which, frozen with the offer. */
  readonly mcp?: McpToolRef
  /** False: never one of a story's reply tools (This chat's Tools list leaves it out), only a planner's. */
  readonly replyTool?: false
  /** Model-facing, with its usage guidance: when to call it and when not to. */
  readonly description: string
  readonly parameters: TSchema
  /** The step's one-line title from its arguments: “lighthouse”. */
  readonly summarize?: (args: A) => string
  /** Optional state frozen before a result is returned; shared keys prepare once per run.
   * The generator persists it in the existing snapshot and the session restores it on Resume/step edit.
   * undefined means this tool needs no frozen state for this view. */
  readonly snapshot?: {
    readonly key: string
    /** The state, or (Resume, step edit, replay) what `freeze` kept of it, made ready for this run. */
    readonly prepare: (context: ToolContext, frozen: unknown) => Effect.Effect<unknown, unknown>
    /** What the snapshot stores of a prepared state (absent: the state itself). */
    readonly freeze?: (state: unknown) => unknown
  }
  /**
   * What the call will do, for its approval (spec/WORKSHOP.md §3.4), worked out by the server from
   * the real arguments and the items they name: the target's own name, an edit's fields before
   * and after. Absent: the arguments as they are. `storyAt`: the call reads or changes the story
   * at the request's position, so only a tab still showing it may allow it.
   */
  readonly describe?: (
    context: ToolContext,
    args: A
  ) => Effect.Effect<
    Pick<ApprovalPrompt, "title" | "rows" | "changes" | "storyAt" | "storyScope" | "plugin" | "presentation" | "rerun">,
    unknown
  >
  readonly execute: (context: ToolContext, args: A) => Effect.Effect<ToolOutput>
}

/**
 * Prepare registered projections before StartRollout freezes its snapshot: `state` for this
 * run, `frozen` (each hook's `freeze` of it) for the snapshot.
 */
export const prepareToolSnapshots = (tools: ReadonlyArray<RolloutTool<never>>, context: ToolContext) =>
  Effect.gen(function* () {
    const state: Record<string, unknown> = {}
    const frozen: Record<string, unknown> = {}
    const seen = new Set<string>()
    for (const tool of tools) {
      const hook = tool.snapshot
      if (!hook || seen.has(hook.key)) continue
      seen.add(hook.key)
      const value = yield* hook.prepare(context, undefined)
      if (value === undefined) continue
      state[hook.key] = value
      const kept = hook.freeze ? hook.freeze(value) : value
      if (kept !== undefined) frozen[hook.key] = kept
    }
    return { state, frozen }
  })

/**
 * Operations only the user may run (spec/WORKSHOP.md §3.2: the agent can't give itself
 * anything): what the assistant may do, and answers to its requests.
 */
export const USER_ONLY_WRITES = [
  "SetPluginPins",
  "CompletePluginUndo",
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
  /** An MCP server's tool: app metadata, never part of the definition the model is sent. */
  readonly mcp?: McpToolRef
}

/** Which server and tool an offered MCP tool is (spec/MCP.md §4.2). */
export interface McpToolRef {
  readonly connection: string
  /** The server's name for the connection, when the run was planned. */
  readonly connectionName: string
  readonly host: string
  /** The key its tools are offered under: `mcp_<key>_<tool>`. */
  readonly key: string
  readonly catalogRevision: number
  /** The server's own name for the tool, sent in `tools/call`. */
  readonly tool: string
}

export const frozenTool = (tool: RolloutTool<never>): FrozenTool => ({
  name: tool.id,
  description: tool.description,
  parameters: tool.parameters,
  effect: tool.effect,
  ...(tool.capability ? { capability: tool.capability } : {}),
  ...(tool.titleField ? { titleField: tool.titleField } : {}),
  label: tool.label,
  ...(tool.mcp ? { mcp: tool.mcp } : {})
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

/** What `present` tells the model: the argument's whole contract, since nothing else explains it. */
const PRESENT_DESCRIPTION =
  "The names of the characters who are in the scene for this message, yours included. Leave out anyone who isn't there: they don't hear this message, and aren't picked to reply until they're back."

/**
 * The send tool of a chat whose replies say who is present (`agent.send_presence`; DESIGN §3.5
 * [D]: "by a required `send_message` argument"). The names aren't listed in the schema, so the
 * definition is the same for every cast and stays cached.
 */
export const sendMessageWithPresence = (mode: "optional" | "required"): FrozenTool => {
  const present = Type.Array(Type.String(), { description: PRESENT_DESCRIPTION })
  return {
    ...sendMessageDefinition,
    description: `${sendMessageDefinition.description} Say who is in the scene in \`present\`.`,
    parameters: Type.Object({
      message: Type.String({ description: "The message, exactly as it should appear." }),
      present: mode === "required" ? present : Type.Optional(present)
    })
  }
}

/** Whether a frozen send tool takes `present`, and whether it must: read from what was offered. */
export const sendPresenceOf = (definition: Pick<FrozenTool, "parameters">): "optional" | "required" | null => {
  const schema = definition.parameters as {
    readonly properties?: Readonly<Record<string, unknown>>
    readonly required?: ReadonlyArray<string>
  } | null
  if (!schema?.properties || !("present" in schema.properties)) return null
  return schema.required?.includes("present") ? "required" : "optional"
}

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
