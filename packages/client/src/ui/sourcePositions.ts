import { decodeString } from "micromark-util-decode-string"

export type SourceChar = readonly [start: number, end: number] | null
export interface SourceMap {
  /** A number encodes a contiguous run; irregular text carries one range per UTF-16 unit. */
  chars: number | ReadonlyArray<SourceChar>
  length: number
  start: number
  end: number
  code?: boolean
  br?: boolean
}
export interface PositionedNode {
  type: string
  tagName?: string
  value?: string
  children?: PositionedNode[]
  properties?: Record<string, unknown>
  data?: { copyAlt?: string; hName?: string }
  position?: {
    start: { offset?: number; line?: number; column?: number }
    end: { offset?: number; line?: number; column?: number }
  }
}

/** Decode parser text, keeping escapes/entities and skipped continuation prefixes whole. */
function textRanges(value: string, raw: string, start: number, literal = false, newlineSpace = false): SourceChar[] {
  if (raw === value) return Array.from({ length: value.length }, (_, i) => [start + i, start + i + 1])
  const result: SourceChar[] = []
  let at = 0
  const tokens = literal
    ? /\r\n|[\s\S]/g
    : /\\[!-/:-@\[-`{-~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);|\r\n|[\s\S]/g
  for (const match of raw.matchAll(tokens)) {
    const newline = /^[\r\n]+$/.test(match[0])
    const decoded = newline ? (newlineSpace ? " " : "\n") : decodeString(match[0])
    if (!value.startsWith(decoded, at)) continue
    for (let i = 0; i < decoded.length; i++)
      result.push(
        decoded === match[0]
          ? [start + match.index + i, start + match.index + i + 1]
          : [start + match.index, start + match.index + match[0].length]
      )
    at += decoded.length
    if (at === value.length) break
  }
  while (result.length < value.length) result.push(null)
  return result
}

/** ST's quote and soft-break splitting must retain parser positions. */
export function sliceText(node: PositionedNode, from: number, to: number, source: string): PositionedNode {
  const value = node.value ?? ""
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  const ranges = start === undefined || end === undefined ? [] : textRanges(value, source.slice(start, end), start)
  const first = ranges[from]
  const last = ranges[to - 1]
  const point = (offset: number) => {
    const prefix = source.slice(start ?? 0, offset)
    const lines = prefix.split("\n")
    return {
      offset,
      line: (node.position?.start.line ?? 1) + lines.length - 1,
      column: lines.length === 1 ? (node.position?.start.column ?? 1) + prefix.length : lines.at(-1)!.length + 1
    }
  }
  return {
    type: "text",
    value: value.slice(from, to),
    ...(first && last ? { position: { start: point(first[0]), end: point(last[1]) } } : {})
  }
}

export function selectedSource(map: SourceMap, from: number, to: number): readonly [number, number] | null {
  from = Math.max(0, from)
  to = Math.min(map.length, to)
  if (from >= to) return null
  if (typeof map.chars === "number")
    return [from === 0 ? map.start : map.chars + from, to === map.length ? map.end : map.chars + to]
  let first = from
  let last = to - 1
  while (first <= last && !map.chars[first]) first++
  while (last >= first && !map.chars[last]) last--
  if (first > last) return null
  const firstStored = map.chars.findIndex((char) => char !== null)
  const lastStored = map.chars.findLastIndex((char) => char !== null)
  return [first === firstStored ? map.start : map.chars[first]![0], last === lastStored ? map.end : map.chars[last]![1]]
}

/** Trusted metadata is attached after sanitizing; source HTML never supplies it. */
export function sourcePositions({ offsets }: { offsets: ReadonlyArray<SourceChar> }) {
  return (tree: PositionedNode, file: { value: unknown }) => {
    const source = String(file.value)
    interface Leaf {
      node: PositionedNode
      chars: SourceChar[]
      start: number
      end: number
      code: boolean
      br: boolean
    }
    const leaves: Leaf[] = []
    const sourceRange = (start: number, end: number): readonly [number, number] | null => {
      let first = start
      let last = end - 1
      while (first <= last && !offsets[first]) first++
      while (last >= first && !offsets[last]) last--
      return first <= last ? [offsets[first]![0], offsets[last]![1]] : null
    }
    const visit = (node: PositionedNode, parent?: PositionedNode) => {
      const before = leaves.length
      const isCode = node.type === "element" && node.tagName === "code"
      const br = node.type === "element" && node.tagName === "br"
      const image = node.tagName === "img" || node.data?.copyAlt !== undefined
      if (node.type === "text" || isCode || image || br) {
        const positioned = isCode || image || br ? node : node.position ? node : undefined
        const start = positioned?.position?.start.offset
        const end = positioned?.position?.end.offset
        if (start === undefined || end === undefined) return
        let raw = source.slice(start, end)
        let at = start
        let value = isCode ? (node.children?.map((child) => child.value ?? "").join("") ?? "") : (node.value ?? "")
        if (br) value = "\n"
        if (image)
          value =
            node.data?.copyAlt === undefined
              ? String(node.properties?.alt ?? "")
              : (node.children?.map((child) => child.value ?? "").join("") ?? "")
        const blockCode = isCode && parent?.tagName === "pre"
        if (isCode) {
          const fence = /^(?: {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(raw)
          const inline = /^`+/.exec(raw)
          if (blockCode && fence) {
            at += fence[0].length
            const closing = new RegExp(`(?:^|\\r?\\n) {0,3}${fence[1]![0]}{${fence[1]!.length},}[\\t ]*$`)
            raw = raw.slice(fence[0].length).replace(closing, "")
          } else if (!blockCode && inline) {
            at += inline[0].length
            raw = raw.slice(inline[0].length, -inline[0].length)
            const normalized = raw.replace(/\r\n|[\r\n]/g, " ")
            if (normalized.startsWith(" ") && normalized.endsWith(" ") && /[^ ]/.test(normalized)) {
              const padding = raw.startsWith("\r\n") ? 2 : 1
              raw = raw.slice(padding, raw.endsWith("\r\n") ? -2 : -1)
              at += padding
            }
          }
        }
        let chars = textRanges(value, raw, at, isCode, isCode && !blockCode).map((range): SourceChar =>
          range ? sourceRange(range[0], range[1]) : null
        )
        if (image) {
          const alt = node.data?.copyAlt ?? value
          const prefix = value.indexOf(alt)
          chars = Array.from({ length: value.length }, () => null)
          if (alt && prefix >= 0) {
            const caption = textRanges(alt, raw.slice(2), at + 2)
            for (let i = 0; i < caption.length; i++) {
              const range = caption[i]
              chars[prefix + i] = range ? sourceRange(range[0], range[1]) : null
            }
          }
        }
        // Code indentation is a parser-removed prefix. Align each literal line at
        // its suffix, so an intentional leading space doesn't map to indentation.
        // Streamdown renders block spans per line, without newline text nodes.
        if (blockCode) {
          chars = []
          const lines = raw.split("\n")
          let cursor = at
          for (const [index, line] of value.split("\n").entries()) {
            const original = lines[index] ?? ""
            const prefix = original.endsWith(line) ? original.length - line.length : 0
            for (const range of textRanges(line, original.slice(prefix), cursor + prefix, true))
              chars.push(range ? sourceRange(range[0], range[1]) : null)
            cursor += original.length + 1
          }
        }
        const range = chars.filter((char) => char !== null)
        // Even wholly generated/empty content needs metadata: copying a language
        // label or a caption without alt text must suppress native plain-text copy.
        leaves.push({ node, chars, start: range[0]?.[0] ?? 0, end: range.at(-1)?.[1] ?? 0, code: blockCode, br })
      } else for (const child of node.children ?? []) visit(child, node)
      if (node.type !== "root" && leaves.length > before) {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        const range = start === undefined || end === undefined ? null : sourceRange(start, end)
        if (range) {
          leaves[before]!.start = Math.min(leaves[before]!.start, range[0])
          leaves.at(-1)!.end = Math.max(leaves.at(-1)!.end, range[1])
        }
      }
    }
    visit(tree)
    for (const leaf of leaves) {
      const first = leaf.chars[0]
      const linear = first && leaf.chars.every((char, i) => char?.[0] === first[0] + i && char[1] === first[0] + i + 1)
      const map: SourceMap = {
        chars: linear ? first[0] : leaf.chars,
        length: leaf.chars.length,
        start: leaf.start,
        end: leaf.end
      }
      if (leaf.code) map.code = true
      if (leaf.br) map.br = true
      const metadata = JSON.stringify(map)
      if (leaf.node.type === "text") {
        const child = { ...leaf.node }
        leaf.node.type = "element"
        leaf.node.tagName = "span"
        leaf.node.properties = { "data-source-map": metadata }
        leaf.node.children = [child]
        delete leaf.node.value
      } else leaf.node.properties = { ...leaf.node.properties, "data-source-map": metadata }
    }
  }
}
