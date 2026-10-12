// Cache breakpoints (DESIGN §5.5), placed structurally, as deltas from reference-harness's scheme
// (its src/agent/cache-breakpoints.ts):
// - reference-harness's (a), the system prompt: here `prefix`, the last message of the leading run
//   of the preset's and cards' prompts, which only changes when they do. When the provider
//   takes them as its system parameter, its own marker there covers it.
// - reference-harness's (b), the conversation summary: comes with LCM's summary layer (DESIGN §8).
// - reference-harness's (c), the last timeline item reproduced verbatim by the next session: here
//   `history`, the last message before the first one that changes next turn. In-chat
//   prompts and notes keep their depth as the chat grows, so the deepest of them is where
//   the next request starts to differ; with none, it's the last message of the chat.
//   reference-harness finds its tail by searching the wire text for `<system>`; here every message
//   knows what it's made of (`Stability`), through squashing and post-processing.
// - reference-harness's (d) and (e), every request's end and the previous one's: pi-ai already
//   marks the last message, and Anthropic reads back up to about 20 blocks before a marker.
// The breakpoints are always recorded; the provider request sends them only for models
// whose cache breakpoints are `explicit`, as reference-harness sends them only when configured.
import type { Stability } from "./st.ts"
import type { AssembledRequest } from "./types.ts"

export const placeBreakpoints = (
  messages: ReadonlyArray<{ readonly kind: Stability }>
): AssembledRequest["breakpoints"] => {
  const firstVolatile = messages.findIndex((m) => m.kind === "volatile")
  const stableEnd = (firstVolatile === -1 ? messages.length : firstVolatile) - 1
  const firstNotPrefix = messages.findIndex((m) => m.kind !== "prefix")
  const prefixEnd = (firstNotPrefix === -1 ? messages.length : firstNotPrefix) - 1
  const breakpoints: Array<AssembledRequest["breakpoints"][number]> = []
  if (stableEnd >= 0 && messages[stableEnd]!.kind === "history")
    breakpoints.push({ message: stableEnd, reason: "history" })
  if (prefixEnd >= 0 && prefixEnd !== breakpoints[0]?.message)
    breakpoints.push({ message: prefixEnd, reason: "prefix" })
  return breakpoints
}
