// Workshop chats in the client (spec/WORKSHOP.md W2), registered as a plugin would: the kind's
// look, its start card on the Chats page, and the capability chip in the composer's strip.
import { chatStartSections } from "../chat/ChatsPage.tsx"
import { composerControls } from "../chat/composerControls.tsx"
import { chatKindLooks, kindShows } from "../chat/kindLooks.ts"
import { CapabilityChip } from "./CapabilityChip.tsx"
import { registerCapabilities } from "./capabilities.ts"
import { CAPABILITY_CHIP, workshopLook } from "./kinds.ts"
import { WorkshopStartCard } from "./StartCard.tsx"

export const register = () => [
  chatKindLooks.register(workshopLook),
  chatStartSections.register({ id: "workshop.start", order: 20, component: WorkshopStartCard }),
  ...registerCapabilities(),
  // After the cache chip, where Next stands in a story chat.
  composerControls.register({
    id: CAPABILITY_CHIP,
    order: 35,
    placement: "strip",
    available: ({ view }) => kindShows(view.chat?.kind, CAPABILITY_CHIP),
    component: CapabilityChip
  })
]
