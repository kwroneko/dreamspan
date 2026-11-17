// The workshop's look (spec/WORKSHOP.md §2.1, §2.5): what tells a workshop from a story wherever it
// shows. Its behaviour is the shared `workshop` profile (`@rp/shared/chatKinds.ts`).
import type { ChatKindLook } from "../chat/kindLooks.ts"
import { FILES_TAB } from "../files/ids.ts"

const WORKSHOP_KIND = "workshop"
export const CAPABILITY_CHIP = "workshop.capabilities"

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
  // Files tab (spec/FILES-AND-ENVIRONMENT.md §8.1).
  shows: [CAPABILITY_CHIP, "workshop.changes", FILES_TAB]
}
