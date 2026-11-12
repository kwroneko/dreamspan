import type { WorkshopCapability } from "@rp/shared/workshopApi.ts"
import { makeRegistry } from "@rp/shared/registry.ts"

// W4 will add grants and choices. Every built-in capability available today is always allowed.
export const workshopCapabilities = makeRegistry<WorkshopCapability>([
  {
    id: "library.read",
    order: 10,
    label: "Read your library",
    explanation: "Looks up your cards, presets and lorebooks.",
    mode: "allow",
    always: true
  },
  {
    id: "library.write",
    order: 20,
    label: "Create and edit library items",
    explanation: "Creates, edits and clones cards in your library.",
    mode: "allow",
    always: true
  },
  {
    id: "chats.setup",
    order: 30,
    label: "Set up chats",
    explanation: "Starts story chats with your cards and greetings.",
    mode: "allow",
    always: true
  }
])
