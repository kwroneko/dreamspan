import type { OrchestrationMode } from "./modes.ts"

const workshopInstructions =
  "Use the tools to look things up and to make changes. Before a long piece of work, tell {{user}} in a short message (send_message) what you'll do. Everything you change can be undone by {{user}}. Some tools ask {{user}} first: call them anyway; if {{user}} declines, say so and carry on. Turned off in this workshop: nothing."

export const workshopMode: OrchestrationMode = {
  id: "workshop",
  label: "Workshop",
  description: "Work with an assistant on the app outside a story.",
  plan: ({ state }) => ({
    strategy: "agent",
    // Story tool preferences aren't workshop capabilities. The registered planner owns
    // this toolset until capability grants are implemented.
    tools: ["list_library", "read_card", "read_preset", "read_lorebook"],
    contract: state.outputContract ?? "several",
    continuity: state.rolloutContinuity ?? "resume_previous",
    turnCap: 40,
    assembly: { instructions: () => workshopInstructions, speakerCardOnly: false, workshop: true }
  })
}
