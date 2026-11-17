// Internal reply planning (CHARACTER-CONTEXT §1): plugins replace or wrap the default
// entry. The built-in planner combines independent chat settings; modes are not chat state.
import { agentInstructions } from "@rp/shared/agentInstructions.ts"
import { type ChatState, DEFAULT_REQUEST_CAP } from "@rp/shared/state.ts"

export type OutputContract = "final_text" | "send_message" | "both" | "several"

/** One agent's turn: the reply strategy it runs, its tools and how its message is taken. */
export interface AgentPlan {
  /** A `replyStrategies` id: `reply` (plain) or `agent` (a pi-agent-core loop). */
  readonly strategy: string
  /** `rolloutTools` ids, in the order offered. */
  readonly tools: ReadonlyArray<string>
  readonly contract: OutputContract
  /** The send tool says who is present for the message (`agent.send_presence`); absent: it doesn't. */
  readonly sendPresence?: "optional" | "required"
  readonly continuity?: "fork" | "resume_previous"
  /**
   * The most model requests one reply makes (`agent.request_cap`); the last is made without
   * tools. Absent: no cap, the run goes on until the model ends it or the user stops it (a
   * workshop's, owner 2026-11-17: "It cannot be limited, much like how claude code wouldn't be").
   */
  readonly turnCap?: number
  /** What the mode changes in the context; absent: the plain reply's. */
  readonly assembly?: {
    /**
     * Told with the end of the request, given the tools actually offered and the capabilities
     * the chat turned off (their labels).
     */
    readonly instructions: (
      offered: ReadonlyArray<string>,
      contract: OutputContract,
      context?: { readonly off: ReadonlyArray<string> }
    ) => string
    /** Card-swap: only the speaking character's card is sent, where the preset puts cards. */
    readonly speakerCardOnly: boolean
    readonly workshop?: boolean
    /** How the turn's reply reserve is sized: "model" takes the model's max output (WORKSHOP-CONTEXT §1.2). */
    readonly response?: "model"
  }
}

export interface OrchestrationMode {
  readonly id: string
  readonly label: string
  readonly description: string
  /** The plan for the turn being generated, from the chat's settings there. */
  readonly plan: (input: { readonly state: ChatState; readonly kind: string }) => AgentPlan
}

/** The tools agent replies offer by default (spec/AGENTIC.md §4.5), as far as they're registered. */
const DEFAULT_TOOLS: ReadonlyArray<string> = [
  "expand_summary",
  "search_summaries",
  "search_chat",
  "read_messages",
  "lookup_lore",
  "list_notes",
  "write_note",
  "edit_note",
  "switch_note",
  "set_presence",
  "edit_card"
]

/**
 * What an agent turn is told with the end of the request: that it has tools, and how to reply.
 * The default of the preset's Agent instructions prompt (`agentInstructionsPrompt`).
 */
export { agentInstructions }

/** One shared context; tools and card rotation are independent settings. */
export const defaultMode: OrchestrationMode = {
  id: "default",
  label: "Default",
  description: "Plans each reply from the chat settings.",
  plan: ({ state }) => {
    if (state.agentEnabled !== true) return { strategy: "reply", tools: [], contract: "final_text", turnCap: 1 }
    const chosen = state.outputContract === "several" ? "both" : (state.outputContract ?? "both")
    // Who is present can only be said through the tool: a chat that requires it asks for the
    // reply through the tool even when the older output preference was final text.
    const sendPresence =
      state.sendPresence === "required" ? "required" : chosen === "final_text" ? undefined : state.sendPresence
    return {
      strategy: "agent",
      tools: state.agentTools ?? DEFAULT_TOOLS,
      contract: sendPresence === "required" ? "send_message" : chosen,
      ...(sendPresence ? { sendPresence } : {}),
      turnCap: state.requestCap ?? DEFAULT_REQUEST_CAP,
      assembly: { instructions: agentInstructions, speakerCardOnly: state.cardsRotation === true }
    }
  }
}

/** A disabled planner fails before sending; plugins can replace or wrap the default entry. */
export const planTurn = (
  modes: { readonly get: (id: string) => OrchestrationMode | undefined },
  state: ChatState,
  kind = "rp",
  planner = "default"
): { readonly mode: string; readonly plan: AgentPlan } | { readonly unavailable: string } => {
  const id = planner
  const mode = modes.get(id)
  if (!mode) return { unavailable: id }
  return { mode: id, plan: mode.plan({ state, kind }) }
}
