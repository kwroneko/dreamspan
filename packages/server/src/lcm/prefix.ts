import type { ContextSnapshot, Piece } from "../assembler/types.ts"

export interface SummaryPrefix {
  readonly inputs: ContextSnapshot["inputs"]
  readonly frozen: ContextSnapshot["frozen"]
  readonly request: ContextSnapshot["request"]
  readonly pieces: readonly Piece[]
}

const boundary = (snapshot: Pick<ContextSnapshot, "pieces" | "request">) =>
  Math.min(
    snapshot.request.summaryStart ?? Infinity,
    ...snapshot.pieces.filter((p) => p.source.kind === "message").flatMap((p) => p.messages),
    snapshot.request.messages.length
  )

/** Keep the actual prefix decisions, including examples that only just fit. */
export const takeSummaryPrefix = (snapshot: ContextSnapshot): SummaryPrefix => {
  const end = boundary(snapshot)
  return {
    inputs: snapshot.inputs,
    frozen: snapshot.frozen,
    request: {
      ...snapshot.request,
      messages: snapshot.request.messages.slice(0, end),
      breakpoints: end > 0 ? [{ message: end - 1, reason: "prefix" }] : []
    },
    pieces: snapshot.pieces
      .map((p) => ({ id: p.id, source: p.source, text: p.text, messages: p.messages.filter((i) => i < end) }))
      .filter((p) => p.messages.length > 0)
  }
}

export const applySummaryPrefix = (snapshot: ContextSnapshot, prefix?: SummaryPrefix): ContextSnapshot => {
  if (
    !prefix ||
    // A frozen prefix can contain message macros or own-turn notes. It belongs to
    // the view that assembled it, even when the model and preset are the same.
    (prefix.inputs.viewer ?? null) !== (snapshot.inputs.viewer ?? null) ||
    JSON.stringify(prefix.inputs.model) !== JSON.stringify(snapshot.inputs.model) ||
    JSON.stringify(prefix.inputs.preset) !== JSON.stringify(snapshot.inputs.preset)
  )
    return snapshot
  // A frozen reply prefix can hold own-turn notes, even in shared context. Reuse
  // it only while its pieces agree with the summary audience and current definitions.
  if (
    prefix.pieces.some(
      (old) =>
        (snapshot.inputs.viewer || old.source.kind === "note" || old.source.kind === "card") &&
        !snapshot.pieces.some((current) => current.id === old.id && current.text === old.text)
    ) ||
    snapshot.pieces.some(
      (current) =>
        (current.source.kind === "note" || current.source.kind === "card") &&
        current.messages.some((i) => i < boundary(snapshot)) &&
        !prefix.pieces.some((old) => old.id === current.id && old.text === current.text)
    )
  )
    return snapshot
  const end = boundary(snapshot),
    shift = prefix.request.messages.length - end
  const breakpoints = snapshot.request.breakpoints
    .filter((b) => b.message >= end)
    .map((b) => ({ ...b, message: b.message + shift }))
  // A random/clock prefix is volatile during ordinary assembly. Freezing that prefix
  // makes the continuity layer reusable again; do not include condensation material.
  const summaries = snapshot.pieces.filter((p) => p.source.kind === "summary" && p.text !== "")
  const parts = snapshot.summaryJob?.children?.length ?? 0
  const continuity = summaries.slice(0, summaries.length - parts)
  const material = parts ? summaries.slice(-parts) : []
  const summaryEnd = Math.max(-1, ...continuity.flatMap((p) => p.messages))
  const materialStart = Math.min(
    Infinity,
    ...material.flatMap((p) => p.messages),
    ...snapshot.pieces.filter((p) => p.source.kind === "message").flatMap((p) => p.messages)
  )
  if (summaryEnd >= end && summaryEnd < materialStart && !breakpoints.some((b) => b.reason === "summary"))
    breakpoints.push({ message: summaryEnd + shift, reason: "summary" })
  const { pinnedStart: _pinnedStart, ...request } = snapshot.request
  return {
    ...snapshot,
    pieces: [
      ...prefix.pieces,
      ...snapshot.pieces
        .filter((p) => !prefix.pieces.some((old) => old.id === p.id) || p.messages.some((i) => i >= end))
        .map((p) => ({
          id: p.id,
          source: p.source,
          text: p.text,
          messages: p.messages.filter((i) => i >= end).map((i) => i + shift)
        }))
    ],
    request: {
      ...request,
      names: prefix.request.names,
      useSystemPrompt: prefix.request.useSystemPrompt,
      ...(prefix.request.pinnedStart === undefined ? {} : { pinnedStart: prefix.request.pinnedStart }),
      ...(snapshot.request.summaryStart === undefined ? {} : { summaryStart: snapshot.request.summaryStart + shift }),
      messages: [...prefix.request.messages, ...snapshot.request.messages.slice(end)],
      breakpoints: [...prefix.request.breakpoints, ...breakpoints]
    }
  }
}
