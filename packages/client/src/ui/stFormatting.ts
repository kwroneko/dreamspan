import { sliceText, type SourceRun } from "./sourcePositions.ts"

// ST 1.19 public/scripts/power-user.js fixMarkdown(text, true). This is deliberately
// line-based, including its last-character-wins behavior when both checks match a line.
export function fixMarkdown(text: string): string {
  return fixMarkdownRuns(text).text
}

/** Original UTF-16 offsets; display-only closing marks have no source. */
export function fixMarkdownMapped(text: string): { text: string; offsets: Array<number | null> } {
  const fixed = fixMarkdownRuns(text)
  return {
    text: fixed.text,
    offsets: fixed.runs.flatMap((run) =>
      Array.from({ length: run.to - run.from }, (_, i) => (run.source === null ? null : run.source + i))
    )
  }
}

/** Formatting's copy map as contiguous runs, without allocating an offset for every character. */
export function fixMarkdownRuns(text: string): { text: string; runs: Array<SourceRun> } {
  const matches = [...text.matchAll(/([*_]{1,2})([\s\S]*?)\1/gm)]
  let fixed = text
  const removed = new Set<number>()
  for (const match of matches.reverse()) {
    const replacement = match[0].replace(
      /(\*|_)([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)|([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)(\*|_)/g,
      (whole: string, left: string | undefined, _a: string, _b: string, right: string | undefined, at: number) => {
        for (let i = 0; i < whole.length; i++)
          if (i !== (left ? 0 : whole.length - 1)) removed.add(match.index + at + i)
        return left ?? right ?? ""
      }
    )
    if (replacement !== match[0])
      fixed = fixed.slice(0, match.index) + replacement + fixed.slice(match.index + match[0].length)
  }
  const original: SourceRun[] = []
  let source = 0
  let at = 0
  for (const offset of [...removed].sort((a, b) => a - b)) {
    if (offset > source) original.push({ from: at, to: at + offset - source, source })
    at += offset - source
    source = offset + 1
  }
  if (source < text.length) original.push({ from: at, to: at + text.length - source, source })
  const runs: SourceRun[] = []
  let length = 0
  const append = (count: number, source: number | null) => {
    if (!count) return
    const last = runs.at(-1)
    if (
      last &&
      (source === null ? last.source === null : last.source !== null && last.source + last.to - last.from === source)
    )
      runs[runs.length - 1] = { ...last, to: length + count }
    else runs.push({ from: length, to: length + count, source })
    length += count
  }
  let runAt = 0
  const copy = (from: number, to: number) => {
    while (runAt < original.length && original[runAt]!.to <= from) runAt++
    while (from < to && runAt < original.length) {
      const run = original[runAt]!
      const end = Math.min(to, run.to)
      append(end - from, run.source! + from - run.from)
      from = end
      if (from >= run.to) runAt++
    }
  }
  let cursor = 0
  const result = fixed
    .split("\n")
    .map((line, index) => {
      let result = line
      for (const char of ["*", '"']) {
        if (line.split(char).length % 2 === 0) result = line.trimEnd() + char
      }
      const closed = result !== line
      const length = closed ? line.trimEnd().length : line.length
      if (index) copy(cursor - 1, cursor)
      copy(cursor, cursor + length)
      if (closed) append(1, null)
      cursor += line.length + 1
      return result
    })
    .join("\n")
  return { text: result, runs }
}

// A small structural AST contract avoids coupling the replaceable formatter to a
// parser's type package. All output is ordinary mdast and passes the existing sanitizer.
interface Node {
  type: string
  quoteRange?: number
  value?: string
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hName?: string }
}
const quote = (children: Node[], quoteRange: number): Node => ({
  type: "stQuote",
  quoteRange,
  data: { hName: "q" },
  children
})

// The exact quote/exclusion regex in ST 1.19 public/script.js messageFormatting.
const quotes =
  /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim

/** `html`: raw HTML stays HTML for rehype-raw (ui/html); without it, HTML is literal prose. */
export function stFormatting(options?: { readonly html?: boolean }) {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value)
    const raw = (node: Node) => source.slice(node.position?.start.offset, node.position?.end.offset)
    const flat = (node: Node): string =>
      node.type === "inlineCode" ? raw(node) : node.children ? node.children.map(flat).join("") : (node.value ?? "\n")

    const inline = (parent: Node) => {
      // ST's default encode_tags=false shields straight quotes inside <...> before
      // matching dialogue. Mask only the matching view so offsets and literal text
      // survive unchanged; no sentinel is ever emitted into the rendered message.
      const content = parent
        .children!.map(flat)
        .join("")
        .replace(/<([^>]+)>/g, (tag) => tag.replaceAll('"', "\ufffe"))
      const ranges = [...content.matchAll(quotes)]
        .filter((match) => match.slice(1).some(Boolean))
        .map((match) => [match.index, match.index + match[0].length] as const)
      // Merge neighboring fragments so q contains emphasis, as ST's q em CSS expects.
      const merge = (nodes: Node[]) =>
        nodes.reduce<Node[]>((out, node) => {
          const last = out.at(-1)
          if (last?.type === "stQuote" && node.type === "stQuote" && last.quoteRange === node.quoteRange)
            last.children!.push(...node.children!)
          else out.push(node)
          return out
        }, [])
      const decorate = (node: Node, offset: number): Node[] => {
        const length = flat(node).length
        if (node.type === "inlineCode" || node.type === "html") return [node]
        const covering = ranges.findIndex(([start, end]) => start <= offset && end >= offset + length)
        if (covering !== -1) return [quote([node], covering)]
        if (node.children) {
          let cursor = offset
          return [
            {
              ...node,
              children: merge(
                node.children.flatMap((child) => {
                  const result = decorate(child, cursor)
                  cursor += flat(child).length
                  return result
                })
              )
            }
          ]
        }
        if (node.type !== "text") return [node]
        const out: Node[] = []
        let cursor = 0
        for (const [index, [start, end]] of ranges.entries()) {
          const from = Math.max(0, start - offset)
          const to = Math.min(length, end - offset)
          if (to <= from) continue
          if (from > cursor) out.push(sliceText(node, cursor, from, source))
          out.push(quote([sliceText(node, from, to, source)], index))
          cursor = to
        }
        if (cursor < length) out.push(sliceText(node, cursor, length, source))
        return out
      }
      let offset = 0
      parent.children = merge(
        parent.children!.flatMap((child) => {
          const result = decorate(child, offset)
          offset += flat(child).length
          return result
        })
      )
    }
    const visit = (node: Node, parent?: Node) => {
      // With HTML shown as text, treat both inline and block HTML as literal prose before
      // formatting it: no HTML parser or new sanitizer permission is involved.
      if (node.type === "html" && !options?.html) {
        if (parent && ["root", "blockquote", "listItem"].includes(parent.type)) {
          const value = node.value ?? ""
          node.type = "paragraph"
          delete node.value
          node.children = [{ type: "text", value, ...(node.position ? { position: node.position } : {}) }]
        } else node.type = "text"
      }
      // Showdown's underline option consumes triple underscores as underline too.
      if (
        node.type === "emphasis" &&
        raw(node).startsWith("___") &&
        node.children?.length === 1 &&
        node.children[0]?.type === "strong"
      ) {
        node.type = "strong"
        node.children = node.children[0].children ?? []
      }
      if (node.type === "strong" && raw(node).startsWith("__")) node.data = { ...node.data, hName: "ins" }
      if (!node.children) return
      for (const child of node.children) visit(child, node)
      if (["paragraph", "heading", "tableCell"].includes(node.type)) inline(node)
      // Showdown simpleLineBreaks: every soft break in prose becomes a real break.
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value?.includes("\n")) return [child]
        let cursor = 0
        return child.value.split("\n").flatMap((value, index) => {
          const text = sliceText(child, cursor, cursor + value.length, source)
          const newline = sliceText(child, cursor - 1, cursor, source)
          cursor += value.length + 1
          return index ? [{ type: "break", ...(newline.position ? { position: newline.position } : {}) }, text] : [text]
        })
      })
    }
    visit(tree)
  }
}
