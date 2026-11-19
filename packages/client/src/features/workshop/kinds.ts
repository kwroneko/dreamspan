// The workshop's look (spec/WORKSHOP.md §2.1, §2.5): what tells a workshop from a story wherever it
// shows. Its behaviour is the shared `workshop` profile (`@dreamspan/shared/chatKinds.ts`).
import type { ChatKindLook } from "../chat/kindLooks.ts"
import { FILES_TAB, FOLDER_CHIP } from "../files/ids.ts"

const WORKSHOP_KIND = "workshop"
export const CAPABILITY_CHIP = "workshop.capabilities"
/** The subagent model chip beside the model chip (spec/SUBAGENTS.md §5.1a). */
export const SUBAGENT_MODELS_CHIP = "workshop.subagent-models"
/** The same chip in a story, while This chat → Tools allows the story helper (spec/SUBAGENTS.md §9). */
export const STORY_SUBAGENT_MODELS_CHIP = "story.subagent-models"

export const workshopLook: ChatKindLook = {
  id: WORKSHOP_KIND,
  badge: { label: "Workshop", hint: "A workshop: the assistant works on your app, not in a story." },
  accent: "--accent-workshop",
  hides: [
    // Who replies next: the assistant always does (§2.5).
    "composer.next",
    // Workshop capabilities replace story tools and their write permissions.
    // Who replies only links to the hidden Next picker.
    "settings.tools",
    "settings.agent-permissions",
    "settings.who-replies",
    // A workshop's cast is its assistant, so there is no cast to start a story chat with.
    "chat.new-with-cast"
  ],
  // The capability chip, the Changes tab and the step rows’ Undo and Open (§2.5, §3.6), and the
  // Files tab and the working-folder chip (spec/FILES-AND-ENVIRONMENT.md §8.1, §2.2), and the subagent model chip (spec/SUBAGENTS.md §5.1a).
  shows: [CAPABILITY_CHIP, SUBAGENT_MODELS_CHIP, "workshop.changes", FILES_TAB, FOLDER_CHIP]
}
