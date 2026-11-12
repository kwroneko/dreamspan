// The workshop's look (spec/WORKSHOP.md §2.1, §2.5): what tells a workshop from a story wherever it
// shows. Its behaviour is the shared `workshop` profile (`@rp/shared/chatKinds.ts`).
import type { ChatKindLook } from "../chat/kindLooks.ts"

const WORKSHOP_KIND = "workshop"
export const CAPABILITY_CHIP = "workshop.capabilities"

export const workshopLook: ChatKindLook = {
  id: WORKSHOP_KIND,
  badge: { label: "Workshop", hint: "A workshop: the assistant works on your app, not in a story." },
  accent: "--accent-workshop",
  hides: [
    // Who replies next: the assistant always does (§2.5).
    "composer.next",
    "composer.reply-now",
    // Workshop capabilities replace story tools and their write permissions.
    // Who replies only links to the hidden Next picker.
    "settings.tools",
    "settings.agent-permissions",
    "settings.who-replies"
  ],
  shows: [CAPABILITY_CHIP]
}
