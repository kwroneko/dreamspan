// The entire historical display is scrubbed on the main thread, with the effective request inventory.
import type { ContextSource, SourceActivation } from "@dreamspan/shared/inspectorApi.ts"
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
      activation.why.kind !== "keys"
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

type Located = Span & { frame?: true; rewritten?: true; also?: Array<number> }

/** A shared fallback box must retain the sources inside blocks it can no longer separate. */
const sourcesIn = (nodes: ReadonlyArray<PartNode>): Array<number> => [
  ...new Set(nodes.flatMap((node) => (node.frame ? [] : [node.source, ...sourcesIn(node.parts ?? [])])))
]

/**
 * Where each source's text sits in a sent message: each piece's scrubbed text, searched in order
 * from the end of the one before, else anywhere it doesn't overlap a part already found; a block's
 * parts are searched only inside the block. Leaves are parts, blocks are groups around them.
 *
 * A piece whose text isn't there verbatim (a provider transform rewrote the message after
 * assembly) takes the text between its neighbours that were found, trimmed, marked `rewritten`;
 * a run of such pieces shares it, the first as `source` and the rest as `also`. A lone rewritten
 * block's parts are searched inside it. Inseparable blocks retain their nested sources; moved
 * anchors leave a shared fallback over the unclaimed text. Wrappers (`frame`) and blank pieces
 * never take text.
 */
export const locate = (
  content: string,
  nodes: ReadonlyArray<PartNode>
): { parts: Array<Located>; groups: Array<Span & { rewritten?: true }> } => {
  const parts: Array<Located> = []
  const groups: Array<Span & { rewritten?: true }> = []
  const walk = (nodes: ReadonlyArray<PartNode>, from: number, to: number) => {
    const siblings: Array<Span> = []
    const free = (start: number, end: number) =>
      end <= to && [...parts, ...siblings].every((p) => end <= p.start || start >= p.end)
    // The pieces that could hold text, with where each was found (null: not verbatim).
    const found: Array<{ node: PartNode; span: Span | null }> = []
    const unlocated: Array<PartNode> = []
    let cursor = from
    for (const node of nodes) {
      // A message goes out without carriage returns (ST's setOpenAIMessages) while its piece
      // keeps the text as stored, CRLF from an imported card's greeting say: that removal
      // isn't a rewrite, so a piece not there as recorded is searched without them.
      const text =
        node.text.includes("\r") && !content.includes(node.text) ? node.text.replace(/\r/g, "") : node.text
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
      if (at === -1) {
        if (!node.frame) found.push({ node, span: null })
        continue
      }
      const span = { start: at, end: at + text.length, source: node.source }
      found.push({ node, span })
      siblings.push(span)
      if (node.parts?.length) {
        groups.push(span)
        walk(node.parts, span.start, span.end)
      } else parts.push(node.frame ? { ...span, frame: true } : span)
      cursor = span.end
    }
    // Each run of pieces not found takes what lies between the found ones around it.
    for (let i = 0; i < found.length; i++) {
      if (found[i]!.span) continue
      let j = i
      while (j + 1 < found.length && !found[j + 1]!.span) j++
      const run = found.slice(i, j + 1).map(({ node }) => node)
      let start = found[i - 1]?.span?.end ?? from
      let end = found[j + 1]?.span?.start ?? to
      i = j
      while (start < end && /\s/.test(content[start]!)) start++
      while (end > start && /\s/.test(content[end - 1]!)) end--
      if (start >= end || !free(start, end)) {
        unlocated.push(...run)
        continue
      }
      const [first, ...rest] = run
      const span = { start, end, source: first!.source }
      siblings.push(span)
      if (rest.length === 0 && first!.parts?.length) {
        groups.push({ ...span, rewritten: true })
        walk(first!.parts, start, end)
      } else {
        const also = sourcesIn(run).filter((source) => source !== span.source)
        parts.push({ ...span, rewritten: true, ...(also.length ? { also } : {}) })
      }
    }
    // A transform may also reorder the anchors. The interval between those anchors no longer
    // locates the rewrite: box the remaining text with all unresolved sources instead of
    // presenting it as assembler framing. Recorded sibling blocks and wrappers stay intact.
    if (unlocated.length) {
      const [source, ...also] = sourcesIn(unlocated)
      let at = from
      for (const span of [...siblings.toSorted((a, b) => a.start - b.start), { start: to, end: to }]) {
        let start = at
        let end = span.start
        while (start < end && /\s/.test(content[start]!)) start++
        while (end > start && /\s/.test(content[end - 1]!)) end--
        if (source !== undefined && start < end && free(start, end))
          parts.push({ start, end, source, rewritten: true, ...(also.length ? { also } : {}) })
        at = span.end
      }
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
  activation: activationOf(source.activation, scrub),
  ...(source.scripts ? { scripts: source.scripts.map((script) => ({ ...script, name: scrub(script.name) })) } : {})
})
