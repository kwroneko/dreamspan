// Cache breakpoints, placed structurally, as deltas from reference-harness's scheme (ARCHITECTURE §15).
import type { Stability } from "./st.ts"
import type { AssembledRequest } from "./types.ts"

export const placeBreakpoints = (
  messages: ReadonlyArray<{ readonly kind: Stability; readonly summary?: boolean }>
): AssembledRequest["breakpoints"] => {
  const firstVolatile = messages.findIndex((m) => m.kind === "volatile")
  const stableEnd = (firstVolatile === -1 ? messages.length : firstVolatile) - 1
  const firstNotPrefix = messages.findIndex((m) => m.kind !== "prefix")
  const prefixEnd = (firstNotPrefix === -1 ? messages.length : firstNotPrefix) - 1
  const breakpoints: Array<AssembledRequest["breakpoints"][number]> = []
  if (stableEnd >= 0 && messages[stableEnd]!.kind === "history")
    breakpoints.push({ message: stableEnd, reason: "history" })
  const summaryEnd = messages.findLastIndex((m) => m.kind === "summary" || m.summary)
  if (summaryEnd >= 0 && !breakpoints.some((b) => b.message === summaryEnd))
    breakpoints.push({ message: summaryEnd, reason: "summary" })
  if (prefixEnd >= 0 && prefixEnd !== breakpoints[0]?.message)
    breakpoints.push({ message: prefixEnd, reason: "prefix" })
  return breakpoints
}
