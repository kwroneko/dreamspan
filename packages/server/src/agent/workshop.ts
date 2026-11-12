import type { OrchestrationMode } from "./modes.ts"
import { STORY_TOOLS } from "./tools/history.ts"

// What a capability turned off in this workshop is (spec/WORKSHOP.md §3.4) is named in the instructions.
const workshopInstructions = (off: ReadonlyArray<string>) =>
  `Use the tools to look things up and to make changes. Before a long piece of work, tell {{user}} in a short message (send_message) what you'll do. Everything you change can be undone by {{user}}. Some tools ask {{user}} first: call them anyway; if {{user}} declines, say so and carry on. Turned off in this workshop: ${off.length > 0 ? off.join("; ") : "nothing"}.`

/** A side chat beside a story (§4) says so, while its story tools are offered. */
const SIDE_CHAT =
  " You're beside one of {{user}}'s stories, to talk about it out of character. You can't see the story itself: read it with the story tools, which read the branch {{user}} last wrote in, up to its newest message. Nothing said here reaches the story."

export const workshopMode: OrchestrationMode = {
  id: "workshop",
  label: "Workshop",
  description: "Work with an assistant on the app outside a story.",
  plan: ({ state }) => ({
    strategy: "agent",
    // Story tool preferences aren't workshop capabilities. The registered planner owns
    // this toolset until capability grants are implemented.
    tools: [
      "list_library",
      "read_card",
      "read_preset",
      "read_lorebook",
      "create_card",
      "edit_card",
      "edit_preset",
      "edit_lorebook",
      "clone_card",
      "start_chat",
      // A side chat reads its story (§4); nothing else offers these.
      ...(state.workshopAttached === undefined ? [] : STORY_TOOLS)
    ],
    contract: state.outputContract ?? "several",
    continuity: state.rolloutContinuity ?? "resume_previous",
    turnCap: 40,
    assembly: {
      instructions: (offered, _contract, context) =>
        workshopInstructions(context?.off ?? []) +
        (STORY_TOOLS.some((tool) => offered.includes(tool)) ? SIDE_CHAT : ""),
      speakerCardOnly: false,
      workshop: true
    }
  })
}
