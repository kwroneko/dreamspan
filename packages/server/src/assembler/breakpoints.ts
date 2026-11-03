// Structural boundaries; provider matching rules are capabilities, not wire-API guesses.
import { createHash } from "node:crypto"
import type { CacheLayout } from "@rp/shared/providers.ts"
import type { Stability } from "./st.ts"
import type { AssembledRequest, RequestMessage, Piece } from "./types.ts"

type Breakpoint = AssembledRequest["breakpoints"][number]

/** Hash complete prefixes, including framing and image identity; never retain prompt text. */
export const cachePrefixDigests = (messages: ReadonlyArray<RequestMessage>): ReadonlyArray<string> => {
  const hash = createHash("sha256")
  return messages.map((m) => {
    hash.update(JSON.stringify([m.role, m.name ?? null, m.content, m.images ?? []]) + "\n")
    return hash.copy().digest("hex")
  })
}

/** Summary wrappers retain provenance in nested pieces after composition. */
export const summaryLevelOf = (pieces: ReadonlyArray<Piece>, indices: ReadonlyArray<number>): number =>
  Math.max(
    0,
    ...indices.map((i) => {
      const piece = pieces[i]!
      return piece.source.kind === "summary" ? piece.source.level : summaryLevelOf(pieces, piece.parts ?? [])
    })
  )

/** Priority order, before the provider subtracts SDK/tool markers from its actual budget. */
export const placeBreakpoints = (
  messages: ReadonlyArray<{
    readonly kind: Stability
    readonly summary?: boolean
    readonly summaryLevel?: number
    readonly role?: string
  }>,
  moved = false,
  options: CacheLayout & { readonly previousHistory?: number; readonly inputOnly?: boolean } = {}
): AssembledRequest["breakpoints"] => {
  const firstVolatile = messages.findIndex((m) => m.kind === "volatile")
  const stableEnd = (firstVolatile === -1 ? messages.length : firstVolatile) - 1
  const firstNotPrefix = messages.findIndex((m) => m.kind !== "prefix")
  const prefixEnd = (firstNotPrefix === -1 ? messages.length : firstNotPrefix) - 1
  const summaryEnd = messages.findLastIndex((m, i) => i <= stableEnd && (m.kind === "summary" || m.summary))
  // Only the leading older tier qualifies: a later high-level summary cannot skip a leaf.
  let olderEnd = -1
  let olderLevel = 0
  for (let i = 0; i <= summaryEnd; i++) {
    const level = messages[i]!.summaryLevel ?? 0
    if (level === 0) continue
    if (olderLevel === 0) olderLevel = level
    if (level <= 1 || level < olderLevel) break
    olderEnd = i
  }
  const at = (message: number, reason: Breakpoint["reason"]): Breakpoint | null =>
    message >= 0 ? { message, reason } : null
  let historyEnd = stableEnd
  while (options.inputOnly && messages[historyEnd]?.kind === "history" && messages[historyEnd]?.role === "assistant")
    historyEnd--
  const history = messages[historyEnd]?.kind === "history" ? at(historyEnd, "history") : null
  const prefix = at(prefixEnd, "prefix")
  const summary = at(summaryEnd, "summary")
  const split = options.summarySplit ? at(olderEnd, "summary") : null
  const previous = options.previousHistory ?? -1
  const repeat =
    options.lookback === false && previous <= stableEnd && messages[previous]?.kind === "history"
      ? at(previous, "history")
      : null
  const ordered = moved
    ? [prefix, split, history, repeat, summary]
    : options.lookback === false
      ? [history, repeat, split, prefix, summary]
      : [history, prefix, split, summary]
  const breakpoints: Array<Breakpoint> = []
  for (const breakpoint of ordered)
    if (breakpoint && !breakpoints.some((b) => b.message === breakpoint.message)) breakpoints.push(breakpoint)
  return breakpoints
}
