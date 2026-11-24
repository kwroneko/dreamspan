import { pairScopes, type MacroLookup } from "./expand.ts"
import { type MacroNode, type Node, parse } from "./parse.ts"

export interface MacroToken {
  readonly from: number
  readonly to: number
  readonly kind: "value" | "directive" | "comment"
}

// Keep the top-level marks, but cap the work of re-pairing nodes inside scopes and arguments.
const NESTED_PAIRING_BUDGET = 100_000

/** Parser spans; comments suppress inner marks, and unknown children retain plain text. */
export const highlightMacros = (
  text: string,
  registry: MacroLookup,
  parsed = parse(text)
): ReadonlyArray<MacroToken> => {
  const tokens: Array<MacroToken> = []
  const mark = (node: Node, kind: MacroToken["kind"]) => {
    const children = node.kind === "macro" ? node.args.flatMap((arg) => arg.nodes) : (node.value?.nodes ?? [])
    let from = node.start
    for (const child of children) {
      if (from < child.start) tokens.push({ from, to: child.start, kind })
      from = child.end
    }
    if (from < node.end) tokens.push({ from, to: node.end, kind })
  }
  const tasks: Array<{ nodes: ReadonlyArray<Node>; from: number; to: number }> = []
  const push = (nodes: ReadonlyArray<Node>, from = 0, to = nodes.length) => {
    if (from < to) tasks.push({ nodes, from, to })
  }
  push(parsed)
  const exhausted = Symbol()
  let remaining = NESTED_PAIRING_BUDGET
  const charge = (steps: number) => {
    remaining -= steps
    if (remaining < 0) throw exhausted
  }
  const accepts = (node: MacroNode) => {
    const entry = registry.get(node.name.toLowerCase())
    return !entry || (!entry.list && node.args.length + 1 >= entry.minArgs && node.args.length + 1 <= entry.maxArgs)
  }
  while (tasks.length) {
    const { nodes, from, to } = tasks.pop()!
    const work = nodes === parsed && from === 0 && to === parsed.length ? () => {} : charge
    let items: ReturnType<typeof pairScopes>
    try {
      work(to - from)
      items = pairScopes(text, nodes, from, to, accepts, work)
    } catch (error) {
      if (error !== exhausted) throw error
      break
    }
    for (const item of items) {
      if (item.keepRaw) continue
      const node = nodes[item.index]!
      const entry = node.kind === "macro" ? registry.get(node.name.toLowerCase()) : undefined
      const close = item.close === undefined ? undefined : nodes[item.close]!
      if (entry?.name === "//") {
        tokens.push({ from: node.start, to: close?.end ?? node.end, kind: "comment" })
        continue
      }
      if (node.kind === "var") {
        // Shorthands are parser syntax; route their classification through the equivalent entry.
        const writer =
          node.operator !== undefined && ["=", "+=", "-=", "++", "--", "??=", "||="].includes(node.operator)
        const equivalent = registry.get(`${writer ? "set" : "get"}${node.global ? "global" : ""}var`)
        if (equivalent) mark(node, equivalent.kind)
        if (node.value) push(node.value.nodes)
      } else {
        if (entry) {
          mark(node, close ? "directive" : entry.kind)
          if (close) tokens.push({ from: close.start, to: close.end, kind: "directive" })
        }
        for (const arg of node.args) push(arg.nodes)
      }
      if (item.close !== undefined) push(nodes, item.index + 1, item.close)
    }
  }
  return tokens.sort((a, b) => a.from - b.from || b.to - a.to)
}
