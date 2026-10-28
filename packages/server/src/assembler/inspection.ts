// The entire historical display is scrubbed on the main thread, with the effective request inventory.
import type { ContextSource, SourceActivation } from "@rp/shared/inspectorApi.ts"
import type { AssembledRequest, InspectionInputs, InspectionNode, WireContext } from "./types.ts"

const activationOf = (
  activation: SourceActivation | null,
  scrub: (text: string) => string
): SourceActivation | null => {
  if (!activation) return activation
  if (activation.kind === "note")
    return activation.condition === undefined ? activation : { ...activation, condition: scrub(activation.condition) }
  if (activation.status === "skipped") return { ...activation, reason: scrub(activation.reason) }
  return {
    ...activation,
    why:
      activation.why.kind === "constant" || activation.why.kind === "pinned"
        ? activation.why
        : {
            ...activation.why,
            primaryKey: scrub(activation.why.primaryKey),
            secondaryKeys: activation.why.secondaryKeys.map(scrub),
            ...(activation.why.notes ? { notes: activation.why.notes.map(scrub) } : {})
          }
  }
}

type Span = { start: number; end: number; source: number }

/** A piece's text and, for a labelled block, the pieces it holds; `source` indexes the message's sources. */
export interface PartNode {
  readonly source: number
  readonly text: string
  /** A wrapper the block's owner added around its parts, such as a card join prefix. */
  readonly frame?: boolean
  readonly parts?: ReadonlyArray<PartNode>
}

/**
 * Where each source's text sits in a sent message: each piece's scrubbed text, searched in order
 * from the end of the one before, else anywhere it doesn't overlap a part already found; a block's
 * parts are searched only inside the block. Leaves are parts, blocks are groups around them. A
 * piece whose text isn't there verbatim (a regex script changed it) gets no part.
 */
export const locate = (
  content: string,
  nodes: ReadonlyArray<PartNode>
): { parts: Array<Span & { frame?: true }>; groups: Array<Span> } => {
  const parts: Array<Span & { frame?: true }> = []
  const groups: Array<Span> = []
  const walk = (nodes: ReadonlyArray<PartNode>, from: number, to: number) => {
    const siblings: Array<Span> = []
    const free = (start: number, end: number) =>
      end <= to && [...parts, ...siblings].every((p) => end <= p.start || start >= p.end)
    let cursor = from
    for (const node of nodes) {
      const { text } = node
      if (text.trim() === "") continue
      let at = content.indexOf(text, cursor)
      if (at === -1 || !free(at, at + text.length)) {
        at = -1
        for (let i = content.indexOf(text, from); i !== -1; i = content.indexOf(text, i + 1))
          if (free(i, i + text.length)) {
            at = i
            break
          }
      }
      if (at === -1) continue
      const span = { start: at, end: at + text.length, source: node.source }
      siblings.push(span)
      if (node.parts?.length) {
        groups.push(span)
        walk(node.parts, span.start, span.end)
      } else parts.push(node.frame ? { ...span, frame: true } : span)
      cursor = span.end
    }
  }
  walk(nodes, 0, content.length)
  return {
    parts: parts.toSorted((a, b) => a.start - b.start),
    groups: groups.toSorted((a, b) => a.start - b.start || b.end - a.end)
  }
}

/** The leaves of `locate`, for a flat list of pieces. */
export const partsOf = (content: string, texts: ReadonlyArray<PartNode>): Array<Span> => locate(content, texts).parts

export const inspectWire = (
  wire: WireContext,
  request: AssembledRequest,
  input: InspectionInputs,
  scrub: (text: string) => string
): WireContext => {
  const breakpoints = new Map(request.breakpoints.map((b) => [b.message, b.reason]))
  const prefill: ContextSource = { id: "prefill", kind: "preset", label: "Prefill", slotId: null, activation: null }
  return {
    ...wire,
    display: {
      model: input.model && {
        ...input.model,
        connection: scrub(input.model.connection),
        model: scrub(input.model.model),
        kind: scrub(input.model.kind)
      },
      preset: {
        ...input.preset,
        label: input.preset.label === null ? null : scrub(input.preset.label),
        scope: scrub(input.preset.scope)
      },
      issues: input.issues.map((issue) => ({ ...issue, message: scrub(issue.message) })),
      ...(input.notSent ? { notSent: input.notSent.map((source) => sourceOf(source, scrub)) } : {})
    },
    messages: wire.messages.map((message) => {
      const sources = message.inputs
        .flatMap((i) => input.sources[i] ?? [prefill])
        .filter((source, i, all) => all.findIndex((s) => s.id === source.id) === i)
        .map((source) => sourceOf(source, scrub))
      // A node whose source isn't among the message's sources stands aside for its parts.
      const nodesOf = (nodes: ReadonlyArray<InspectionNode>): Array<PartNode> =>
        nodes.flatMap((node) => {
          const source = sources.findIndex((s) => s.id === node.source)
          const parts = node.parts ? nodesOf(node.parts) : undefined
          if (source === -1) return parts ?? []
          return [
            {
              source,
              text: scrub(node.text),
              ...(node.frame ? { frame: true } : {}),
              ...(parts?.length ? { parts } : {})
            }
          ]
        })
      const located = input.texts
        ? locate(message.content, nodesOf(message.inputs.flatMap((i) => input.texts![i] ?? [])))
        : null
      return {
        ...message,
        sources,
        ...(located ? { parts: located.parts, ...(located.groups.length ? { groups: located.groups } : {}) } : {}),
        breakpoint: message.inputs.map((i) => breakpoints.get(i)).findLast((b) => b !== undefined) ?? null
      }
    })
  }
}

const sourceOf = (source: ContextSource, scrub: (text: string) => string): ContextSource => ({
  ...source,
  label: scrub(source.label),
  activation: activationOf(source.activation, scrub)
})
