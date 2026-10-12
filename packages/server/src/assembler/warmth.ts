// Whether the next request still matches the last one up to its last cache breakpoint
// (DESIGN §5.5), and if not, what changed first. Pieces keep their ids from one assembly
// to the next (`preset:main`, `card:<entity>:description`, `message:<version>`), so the
// first piece of the first differing message whose text differs says why.
import type { ContextSource } from "@rp/shared/inspectorApi.ts"
import { tokensOf } from "./st.ts"
import type { ContextSnapshot, RequestMessage, Source } from "./types.ts"

export type Describe = (source: Source) => ContextSource

/** The last request message a cache breakpoint follows; -1 without one. */
export const lastBreakpoint = (snapshot: ContextSnapshot) =>
  Math.max(-1, ...snapshot.request.breakpoints.map((b) => b.message))

/** The estimated tokens of messages `from` to `to`, both included. */
export const tokensBetween = (snapshot: ContextSnapshot, from: number, to: number) =>
  snapshot.request.messages.slice(from, to + 1).reduce((sum, message) => sum + tokensOf(message), 0)

const same = (a: RequestMessage, b: RequestMessage | undefined) =>
  b !== undefined && a.role === b.role && a.content === b.content && (a.name ?? null) === (b.name ?? null)

const LAYOUT = "The context's layout changed: the cast, the chat's settings or the roles."
const BUDGET = "The budget dropped the oldest messages, so where the history starts moves with every message."

/** Why a message of the path that was sent reads differently, or isn't sent, now. */
const messageReason = (
  last: ContextSnapshot,
  next: ContextSnapshot,
  source: Extract<Source, { kind: "message" }>,
  label: string
) => {
  const sent = next.pieces.find((p) => p.source.kind === "message" && p.source.slot === source.slot)
  if (sent?.source.kind === "message") {
    return sent.source.version === source.version
      ? `${label} was amended.`
      : `${label} was edited, or another of its versions chosen.`
  }
  const read = (next.sources?.history ?? []).flatMap((w) => w.entries)
  const entry = read.find((e) => e.slotId === source.slot)
  if (entry === undefined) {
    const depth = (last.sources?.history ?? []).flatMap((w) => w.entries).find((e) => e.slotId === source.slot)?.depth
    const oldest = Math.min(...read.map((e) => e.depth))
    return depth !== undefined && depth < oldest
      ? BUDGET
      : `The path changed: another branch is shown, or ${label} was deleted.`
  }
  if (entry.versionId !== source.version) return `${label} was edited, or another of its versions chosen.`
  return entry.inContext ? BUDGET : `${label} was hidden.`
}

const reasonAt = (last: ContextSnapshot, next: ContextSnapshot, at: number, describe: Describe) => {
  const now = new Map(next.pieces.map((piece) => [piece.id, piece]))
  const changed = last.pieces.find((piece) => piece.messages.includes(at) && now.get(piece.id)?.text !== piece.text)
  if (changed === undefined) return LAYOUT
  const { source } = changed
  const { label } = describe(source)
  const after = now.get(changed.id)?.source
  const varies = `${label} reads differently: a macro in it gives a new value each time, or what it reads changed.`
  switch (source.kind) {
    case "message":
      return messageReason(last, next, source, label)
    case "preset":
      return last.inputs.preset.revision !== next.inputs.preset.revision ? "The preset changed." : varies
    case "card":
    case "note":
      if (after === undefined) return `${label} isn't in the context any more.`
      return (after.kind === "card" || after.kind === "note") && after.revision !== source.revision
        ? `${label} changed.`
        : varies
    case "lorebook":
      return after === undefined
        ? `${label} isn't in the context any more.`
        : `The lorebook entries that activated changed: ${label} reads differently or another entry took its place.`
    case "assembler":
      return source.what.startsWith("lorebook") || changed.id.startsWith("lore:")
        ? "The lorebook entries that activated changed, or what they read."
        : LAYOUT
    default:
      return LAYOUT
  }
}

/**
 * What the next request changes before the last one's last breakpoint, with the tokens
 * of the last one from there to it: what the provider would write again. Null when the
 * prefix holds.
 */
export const prefixChange = (
  last: ContextSnapshot,
  next: ContextSnapshot,
  describe: Describe
): { readonly reason: string; readonly tokens: number } | null => {
  const end = lastBreakpoint(last)
  const before = last.inputs.model
  const after = next.inputs.model
  if (before?.connectionId !== after?.connectionId || before?.modelId !== after?.modelId) {
    return { reason: "The model changed, and its cache is its own.", tokens: tokensBetween(last, 0, end) }
  }
  const messages = last.request.messages
  for (let at = 0; at <= end; at++) {
    if (!same(messages[at]!, next.request.messages[at])) {
      return { reason: reasonAt(last, next, at, describe), tokens: tokensBetween(last, at, end) }
    }
  }
  return null
}
