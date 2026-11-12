// Internal reply planning (CHARACTER-CONTEXT §1): plugins replace or wrap the default
// entry. The built-in planner combines independent chat settings; modes are not chat state.
import type { ChatState } from "@rp/shared/state.ts"

export type OutputContract = "final_text" | "send_message" | "both"

/** One agent's turn: the reply strategy it runs, its tools and how its message is taken. */
export interface AgentPlan {
  /** A `replyStrategies` id: `reply` (plain) or `agent` (a pi-agent-core loop). */
  readonly strategy: string
  /** `rolloutTools` ids, in the order offered. */
  readonly tools: ReadonlyArray<string>
  readonly contract: OutputContract
  /** Most provider requests one reply makes; the last is made without tools. */
  readonly turnCap: number
  /** What the mode changes in the context; absent: the plain reply's. */
  readonly assembly?: {
    /** Told with the end of the request, given the tools actually offered. */
    readonly instructions: (offered: ReadonlyArray<string>, contract: OutputContract) => string
    /** Card-swap: only the speaking character's card is sent, where the preset puts cards. */
    readonly speakerCardOnly: boolean
    readonly workshop?: boolean
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

/** What an agent turn is told with the end of the request: that it has tools, and how to reply. */
export const agentInstructions = (offered: ReadonlyArray<string>, contract: OutputContract) =>
  [
    offered.length > 0
      ? "Before you write, you can use your tools to check earlier events, summaries, lore and notes, and to keep notes. Use them only when they help."
      : "",
    contract === "final_text"
      ? "When you're ready, write the reply as your answer, and nothing else."
      : contract === "send_message"
        ? "When you're ready, send the reply with send_message."
        : "When you're ready, send the reply with send_message, or write it as your answer."
  ]
    .filter(Boolean)
    .join(" ")

/** One shared context; tools and card rotation are independent settings. */
export const defaultMode: OrchestrationMode = {
  id: "default",
  label: "Default",
  description: "Plans each reply from the chat settings.",
  plan: ({ state }) => {
    if (state.agentEnabled !== true) return { strategy: "reply", tools: [], contract: "final_text", turnCap: 1 }
    return {
      strategy: "agent",
      tools: state.agentTools ?? DEFAULT_TOOLS,
      contract: state.outputContract ?? "both",
      turnCap: 12,
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
