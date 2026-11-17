import { makeRegistry } from "@rp/shared/registry.ts"

export const rolloutEffectClasses = makeRegistry([
  { id: "read", outsideChat: false },
  { id: "chat_state", outsideChat: false },
  { id: "external", outsideChat: true },
  { id: "library", outsideChat: true },
  { id: "setup", outsideChat: true },
  { id: "outside", outsideChat: true },
  // A call to an MCP server the user enabled here (spec/MCP.md §8.1): what it does is the server's.
  { id: "mcp", outsideChat: true }
])

// Unknown classes are refused in stories too.
export const outsideEffect = (effect: string) => rolloutEffectClasses.get(effect)?.outsideChat !== false
export const UNCERTAIN_EFFECT =
  "The app stopped while this was running. It may already have happened; check before trying it again."
