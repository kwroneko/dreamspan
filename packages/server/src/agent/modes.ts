// Orchestration modes (spec/AGENTIC.md §6; DESIGN §7.1): who runs on a turn, what it sees and
// how its output is committed, as registered, replaceable entries. A chat picks one with
// `orchestration.mode`; absent is `plain`, today's single provider turn.
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
}

export interface OrchestrationMode {
  readonly id: string
  readonly label: string
  readonly description: string
  /** The plan for the turn being generated, from the chat's state there and the mode's config. */
  readonly plan: (input: { readonly state: ChatState; readonly config: unknown }) => AgentPlan
}

export const PLAIN_MODE = "plain"

export const plainMode: OrchestrationMode = {
  id: PLAIN_MODE,
  label: "Plain",
  description: "The model writes each reply in one go, without tools.",
  plan: () => ({ strategy: "reply", tools: [], contract: "final_text", turnCap: 1 })
}

/** The tools the agent modes offer by default (spec/AGENTIC.md §4.5), as far as they're registered. */
export const NARRATOR_TOOLS: ReadonlyArray<string> = [
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

const agentPlan = ({ state }: { readonly state: ChatState }): AgentPlan => ({
  strategy: "agent",
  tools: NARRATOR_TOOLS,
  contract: state.outputContract ?? "both",
  turnCap: 12
})

/** One agent a turn with every card loaded: reference-harness's way, the most cache-friendly (DESIGN §7.1). */
export const narratorMode: OrchestrationMode = {
  id: "narrator",
  label: "Narrator with tools",
  description: "One model writes every reply with all the cards loaded, and can look things up and keep notes first.",
  plan: agentPlan
}

/** Plans the turn in the chat's mode; an unknown mode is unavailable, never silently plain. */
export const planTurn = (
  modes: { readonly get: (id: string) => OrchestrationMode | undefined },
  state: ChatState
): { readonly mode: string; readonly plan: AgentPlan } | { readonly unavailable: string } => {
  const id = state.orchestration?.mode ?? PLAIN_MODE
  const mode = modes.get(id)
  if (!mode) return { unavailable: id }
  return { mode: id, plan: mode.plan({ state, config: state.orchestration?.config }) }
}
