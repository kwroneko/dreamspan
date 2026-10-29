// ST 1.19 public/scripts/power-user.js fixMarkdown(text, true). This is deliberately
// line-based, including its last-character-wins behavior when both checks match a line.
export function fixMarkdown(text: string): string {
  const matches = [...text.matchAll(/([*_]{1,2})([\s\S]*?)\1/gm)]
  let fixed = text
  for (const match of matches.reverse()) {
    const replacement = match[0].replace(
      /(\*|_)([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)|([\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]+)(\*|_)/g,
      "$1$4"
    )
    fixed = fixed.slice(0, match.index) + replacement + fixed.slice(match.index + match[0].length)
  }
  return fixed
    .split("\n")
    .map((line) => {
      let result = line
      for (const char of ["*", '"']) {
        if (line.split(char).length % 2 === 0) result = line.trimEnd() + char
      }
      return result
    })
    .join("\n")
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

export function stFormatting() {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value)
    const raw = (node: Node) => source.slice(node.position?.start.offset, node.position?.end.offset)
    const flat = (node: Node): string =>
      node.type === "inlineCode" ? raw(node) : node.children ? node.children.map(flat).join("") : (node.value ?? "\n")

    const inline = (parent: Node) => {
      const content = parent.children!.map(flat).join("")
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
        const value = node.value!
        const out: Node[] = []
        let cursor = 0
        for (const [index, [start, end]] of ranges.entries()) {
          const from = Math.max(0, start - offset)
          const to = Math.min(length, end - offset)
          if (to <= from) continue
          if (from > cursor) out.push({ type: "text", value: value.slice(cursor, from) })
          out.push(quote([{ type: "text", value: value.slice(from, to) }], index))
          cursor = to
        }
        if (cursor < length) out.push({ type: "text", value: value.slice(cursor) })
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
      // Treat both inline and block HTML as literal prose before formatting it.
      // No HTML parser or new sanitizer permission is involved.
      if (node.type === "html") {
        if (parent && ["root", "blockquote", "listItem"].includes(parent.type)) {
          const value = node.value ?? ""
          node.type = "paragraph"
          delete node.value
          node.children = [{ type: "text", value }]
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
      node.children = node.children.flatMap((child) =>
        child.type === "text" && child.value?.includes("\n")
          ? child.value
              .split("\n")
              .flatMap((value, index) =>
                index ? [{ type: "break" }, { type: "text", value }] : [{ type: "text", value }]
              )
          : [child]
      )
    }
    visit(tree)
  }
}
