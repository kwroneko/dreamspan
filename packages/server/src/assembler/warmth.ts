// Whether the next request still matches the last one up to its last cache breakpoint
// (DESIGN §5.5), and if not, what changed first. Pieces keep their ids from one assembly
// to the next (`preset:main`, `card:<entity>:description`, `message:<version>`), so the
// first piece of the first differing message whose text differs says why.
import type { ContextSource } from "@rp/shared/inspectorApi.ts"
import { tokensOf } from "./st.ts"
import { wireImages } from "./imageTokens.ts"
import { wireContext, wireDigest } from "./wire.ts"
import type { ContextSnapshot, Source, WireContext } from "./types.ts"

export type Describe = (source: Source) => Pick<ContextSource, "label">

/** The last request message a cache breakpoint follows; -1 without one. */
export const lastBreakpoint = (snapshot: ContextSnapshot) =>
  Math.max(-1, ...snapshot.request.breakpoints.map((b) => b.message))

/** The estimated tokens of messages `from` to `to`, both included. */
export const tokensBetween = (snapshot: ContextSnapshot, from: number, to: number) =>
  snapshot.request.messages.slice(from, to + 1).reduce((sum, message) => sum + tokensOf(message), 0)

const same = (
  a: Pick<WireContext["messages"][number], "role" | "content" | "name">,
  b: Pick<WireContext["messages"][number], "role" | "content" | "name"> | undefined
) => b !== undefined && a.role === b.role && a.content === b.content && (a.name ?? null) === (b.name ?? null)

const LAYOUT = "The context's layout changed: the cast, the chat's settings or the roles."
const budgetReason = (next: ContextSnapshot) =>
  next.historyMove === "maximum"
    ? "The context reached its maximum; older messages left."
    : next.historyMove === "budget"
      ? "A note grew beyond its reserved allowance; the history budget was recalculated."
      : "The context budget changed where the history starts."

/** Why a message of the path that was sent reads differently, or isn't sent, now. */
const messageReason = (
  last: ContextSnapshot,
  next: ContextSnapshot,
  source: Extract<Source, { kind: "message" }>,
  label: string
) => {
  const sent = next.pieces.find((p) => p.source.kind === "message" && p.source.slot === source.slot)
  if (sent?.source.kind === "message" && sent.messages.length === 0) return budgetReason(next)
  if (sent?.source.kind === "message") {
    if (sent.source.version !== source.version) return `${label} was edited, or another of its versions chosen.`
    const previous = last.pieces.find((p) => p.source.kind === "message" && p.source.slot === source.slot)
    if (sent.text !== previous?.text) return `${label} was amended.`
    // Message offsets can move because notes were inserted or a breakpoint shortened,
    // even when every retained history turn is unchanged.
    const history = (snapshot: ContextSnapshot) =>
      snapshot.pieces
        .filter((p) => p.source.kind === "message" && p.messages.length > 0)
        .map((p) => (p.source.kind === "message" ? p.source.slot : ""))
    const oldHistory = history(last)
    const newHistory = history(next)
    if (oldHistory[0] !== newHistory[0] || oldHistory.some((slot) => !newHistory.includes(slot)))
      return budgetReason(next)
    const notes = (snapshot: ContextSnapshot) =>
      snapshot.pieces
        .filter((p) => p.source.kind === "note" && p.messages.length > 0)
        .map((p) => [p.id, p.text, p.messages])
    return JSON.stringify(notes(last)) !== JSON.stringify(notes(next))
      ? "The notes in the context or their placement changed."
      : "The reusable cache prefix's endpoint or layout changed."
  }
  const read = (next.sources?.history ?? []).flatMap((w) => w.entries)
  const entry = read.find((e) => e.slotId === source.slot)
  if (entry === undefined) {
    const depth = (last.sources?.history ?? []).flatMap((w) => w.entries).find((e) => e.slotId === source.slot)?.depth
    const oldest = Math.min(...read.map((e) => e.depth))
    return depth !== undefined && depth < oldest
      ? budgetReason(next)
      : `The path changed: another branch is shown, or ${label} was deleted.`
  }
  if (entry.versionId !== source.version) return `${label} was edited, or another of its versions chosen.`
  return entry.inContext ? budgetReason(next) : `${label} was hidden.`
}

const reasonAt = (last: ContextSnapshot, next: ContextSnapshot, at: number, describe: Describe) => {
  const now = new Map(next.pieces.map((piece) => [piece.id, piece]))
  const changed = last.pieces.find((piece) => {
    const after = now.get(piece.id)
    return (
      piece.messages.includes(at) &&
      (after?.text !== piece.text || JSON.stringify(after.messages) !== JSON.stringify(piece.messages))
    )
  })
  if (changed === undefined) {
    if (JSON.stringify(last.lcm?.selected) !== JSON.stringify(next.lcm?.selected)) return "The summary layer changed."
    return LAYOUT
  }
  const { source } = changed
  const { label } = describe(source)
  const after = now.get(changed.id)?.source
  const varies = `${label} reads differently: a macro in it gives a new value each time, or what it reads changed.`
  switch (source.kind) {
    case "summary":
      return `Summary of messages ${source.from}–${source.to} replaced.`
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
      if (source.what === "summary placement")
        return "The summary's placement template changed, or a macro in it gives a new value."
      return source.what.startsWith("lorebook") || changed.id.startsWith("lore:")
        ? "The lorebook entries that activated changed, or what they read."
        : LAYOUT
    default:
      return LAYOUT
  }
}

/** Compare the provider-formatted reusable prefix; estimate the next uncached suffix. */
export const prefixChange = (
  last: ContextSnapshot,
  next: ContextSnapshot,
  describe: Describe
): { readonly reason: string; readonly tokens: number } | null => {
  const end = lastBreakpoint(last)
  const nextEnd = lastBreakpoint(next)
  const before = last.inputs.model
  const after = next.inputs.model
  const mapped = (snapshot: ContextSnapshot) =>
    snapshot.wire ??
    (snapshot.inputs.model
      ? wireContext(snapshot.request, snapshot.inputs.model)
      : { messages: snapshot.request.messages.map((m, i) => ({ ...m, inputs: [i] })) })
  // Include unassigned transform insertions between attributed messages in the prefix too.
  const prefix = (messages: WireContext["messages"], end: number) =>
    messages.slice(0, messages.findLastIndex((m) => m.inputs.some((i) => i <= end)) + 1)
  const oldWire = prefix(mapped(last).messages, end)
  const allNext = mapped(next).messages
  const newWire = prefix(allNext, nextEnd)
  // A captured wire is text only: each message's images are the request's, estimated.
  const nextImages = wireImages(allNext, next.request)
  const cost = (m: WireContext["messages"][number], at: number) => tokensOf({ ...m, images: nextImages[at] })
  const suffix = (at: number) => newWire.reduce((sum, m, i) => (i < at ? sum : sum + cost(m, i)), 0)
  if (end < 0 || nextEnd < 0 || oldWire.length === 0 || newWire.length === 0) {
    return {
      reason: "No reusable cache prefix is recorded.",
      tokens: allNext.reduce((sum, m, i) => sum + cost(m, i), 0)
    }
  }
  if (
    before?.connectionId !== after?.connectionId ||
    before?.modelId !== after?.modelId ||
    before?.key !== after?.key ||
    before?.api !== after?.api ||
    before?.kind !== after?.kind
  ) {
    return { reason: "The model changed, and its cache is its own.", tokens: suffix(0) }
  }
  if (before?.connectionRevision !== after?.connectionRevision) {
    return { reason: "The connection's endpoint or route changed.", tokens: suffix(0) }
  }
  if ((last.wire?.mapping ?? before?.mapping)?.revision !== (next.wire?.mapping ?? after?.mapping)?.revision) {
    return { reason: "The model's request-conversion capabilities changed.", tokens: suffix(0) }
  }
  for (let at = 0; at < oldWire.length; at++) {
    const previous = oldWire[at]!
    const upcoming = newWire[at]
    if (!upcoming || (previous.digest ?? wireDigest(previous)) !== (upcoming.digest ?? wireDigest(upcoming))) {
      const inputs = oldWire[at]!.inputs.filter((i) => i <= end)
      const input = inputs.find((i) => !same(last.request.messages[i]!, next.request.messages[i])) ?? inputs[0]!
      const conversion = last.request.useSystemPrompt !== next.request.useSystemPrompt
      return {
        reason: conversion ? "The provider's system-prompt conversion changed." : reasonAt(last, next, input, describe),
        tokens: suffix(at)
      }
    }
  }
  return null
}
