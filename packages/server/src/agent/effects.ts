import { makeRegistry } from "@rp/shared/registry.ts"

/** WORKSHOP §10 question 1: one provisional default, consumed by W4's capabilities. */
const WORKSHOP_REVERSIBLE_DEFAULT = "allow" as const

export const rolloutEffectClasses = makeRegistry([
  { id: "read", outsideChat: false, defaultMode: "allow" },
  { id: "chat_state", outsideChat: false, defaultMode: "allow" },
  { id: "external", outsideChat: true, defaultMode: "ask" },
  { id: "library", outsideChat: true, defaultMode: WORKSHOP_REVERSIBLE_DEFAULT },
  { id: "setup", outsideChat: true, defaultMode: WORKSHOP_REVERSIBLE_DEFAULT },
  { id: "outside", outsideChat: true, defaultMode: "ask" }
])

// Unknown classes are refused in stories too.
export const outsideEffect = (effect: string) => rolloutEffectClasses.get(effect)?.outsideChat !== false
export const UNCERTAIN_EFFECT =
  "The app stopped while this was running. It may already have happened; check before trying it again."
