// The macro engine: evaluates parsed text the way SillyTavern's MacroEngine and
// MacroCstWalker do (public/scripts/macros/engine/, read at SillyTavern 06bde939).
//
// Evaluation order and ST's quirks reproduced here:
// - Each evaluation pre-processes the text (`{{time_UTC+2}}` → `{{time::UTC+2}}`, and the
//   legacy `<USER>`, `<BOT>`, `<CHAR>`, `<GROUP>`, `<CHARIFNOTGROUP>` markers), then
//   evaluates left to right, then post-processes: `\{` and `\}` lose their backslash, and
//   `{{trim}}` is removed together with the newlines around it.
// - Arguments are evaluated inside-out, left to right, before the macro itself, even when
//   the macro then turns out to be unknown or called wrongly; such a macro stays as written,
//   with its nested macros expanded (`{{unknown::{{user}}}}` → `{{unknown::Alice}}`).
// - Scoped blocks (`{{name}}…{{/name}}`) are paired among sibling macros, by name, case-
//   insensitively. The block becomes the last argument, trimmed and dedented unless the
//   opener has the `#` flag. A block only pairs if the extra argument fits the macro's
//   arity; otherwise opener and closer both stay as written, unevaluated. An unknown macro
//   accepts a block, and is then written back as ST writes it: `{{foo}}bar{{/foo}}` →
//   `{{foo}}bar}}`.
// - A macro that delays its arguments (`{{if}}`) gets them raw, and a block untrimmed.
import { isClosing, type MacroNode, type Node, parse } from "./parse.ts"
import type { MacroContext } from "./context.ts"
import type { MacroCall, MacroEntry } from "./registry.ts"

/** What `{{else}}` returns: `{{if}}` splits on it, and any left over is removed at the end. */
const ELSE_MARKER = "\u0000\u001FELSE\u001F\u0000"

const MAX_DEPTH = 32

export interface MacroLookup {
  readonly get: (id: string) => MacroEntry | undefined
}

const preprocess = (text: string) =>
  text
    .replace(/\{\{time_(UTC[+-]\d+)\}\}/gi, "{{time::$1}}")
    .replace(/<USER>/gi, "{{user}}")
    .replace(/<BOT>/gi, "{{char}}")
    .replace(/<CHAR>/gi, "{{char}}")
    .replace(/<GROUP>/gi, "{{group}}")
    .replace(/<CHARIFNOTGROUP>/gi, "{{charIfNotGroup}}")

const LF = 0x0a
const CR = 0x0d

const isTrimAt = (t: string, i: number) => t.startsWith("{{", i) && t.slice(i + 2, i + 8).toLowerCase() === "trim}}"

/**
 * ST's `/(?:\r?\n)*{{trim}}(?:\r?\n)*\/gi` replacement, as a scan: the regex is quadratic on
 * long runs of newlines that aren't followed by `{{trim}}`.
 */
const removeTrimMarkers = (t: string) => {
  let out = ""
  let cursor = 0
  for (let p = t.indexOf("{{"); p >= 0; p = t.indexOf("{{", p + 1)) {
    if (!isTrimAt(t, p)) continue
    let start = p
    while (start > cursor && t.charCodeAt(start - 1) === LF) {
      start--
      if (start > cursor && t.charCodeAt(start - 1) === CR) start--
    }
    let end = p + 8
    for (;;) {
      if (t.charCodeAt(end) === LF) end++
      else if (t.charCodeAt(end) === CR && t.charCodeAt(end + 1) === LF) end += 2
      else break
    }
    out += t.slice(cursor, start)
    cursor = end
    p = end - 1
  }
  return out + t.slice(cursor)
}

const postprocess = (text: string) => removeTrimMarkers(text.replace(/\\([{}])/g, "$1")).replaceAll(ELSE_MARKER, "")

const indentOf = (line: string) => {
  let i = 0
  while (line[i] === " " || line[i] === "\t") i++
  return i
}

/** ST's trimScopedContent: trims, and removes the first non-blank line's indentation from every line. */
const trimScoped = (content: string): string => {
  const lines = content.split("\n")
  const first = lines.find((line) => line.trim() !== "")
  const base = first === undefined ? 0 : indentOf(first)
  if (base === 0) return content.trim()
  return lines
    .map((line) => (indentOf(line) >= base ? line.slice(base) : line.trimStart()))
    .join("\n")
    .trim()
}

/**
 * The macros with one name, for finding where a scoped block closes: openers that accept a
 * block count +1, closers -1, everything else 0. A block closes at the first closer where
 * the running sum after the opener drops below zero. Square-root blocks of running sums make
 * that search sublinear, so many unclosed openers can't make pairing quadratic.
 */
class ScopeGroup {
  readonly indices: Array<number> = []
  private readonly values: Array<number> = []
  private width = 1
  private sums = new Int32Array(0)
  private mins = new Int32Array(0)

  push(index: number, value: number) {
    this.indices.push(index)
    this.values.push(value)
  }

  build() {
    this.width = Math.max(1, Math.ceil(Math.sqrt(this.values.length)))
    const blocks = Math.ceil(this.values.length / this.width)
    this.sums = new Int32Array(blocks)
    this.mins = new Int32Array(blocks)
    for (let b = 0; b < blocks; b++) this.refresh(b)
  }

  private refresh(block: number) {
    let sum = 0
    let min = 0
    const end = Math.min(this.values.length, (block + 1) * this.width)
    for (let x = block * this.width; x < end; x++) {
      sum += this.values[x]!
      if (sum < min) min = sum
    }
    this.sums[block] = sum
    this.mins[block] = min
  }

  /** The slot of the closer for the opener in `slot`, or -1. */
  findClose(slot: number): number {
    const n = this.values.length
    let running = 0
    let block = Math.floor(slot / this.width)
    for (let x = slot + 1; x < Math.min(n, (block + 1) * this.width); x++) {
      running += this.values[x]!
      if (running < 0) return x
    }
    for (block++; block < this.sums.length; block++) {
      if (running + this.mins[block]! < 0) {
        for (let x = block * this.width; ; x++) {
          running += this.values[x]!
          if (running < 0) return x
        }
      }
      running += this.sums[block]!
    }
    return -1
  }

  /** Takes a matched closer out of later searches. */
  clear(slot: number) {
    this.values[slot] = 0
    this.refresh(Math.floor(slot / this.width))
  }
}

interface Item {
  readonly index: number
  readonly keepRaw: boolean
  /** For an opener paired with a block, the index of its closer. */
  readonly close: number | undefined
}

/** ST's #processScopedMacros over the sibling nodes `from` to `to`. */
const pairScopes = (
  text: string,
  nodes: ReadonlyArray<Node>,
  from: number,
  to: number,
  accepts: (node: MacroNode) => boolean
): Array<Item> => {
  const groups = new Map<string, ScopeGroup>()
  const openers: Array<{ index: number; group: ScopeGroup; slot: number; accepts: boolean }> = []
  const closers: Array<number> = []
  for (let k = from; k < to; k++) {
    const node = nodes[k]!
    if (node.kind !== "macro") continue
    const key = node.name.toLowerCase()
    let group = groups.get(key)
    if (!group) groups.set(key, (group = new ScopeGroup()))
    const slot = group.indices.length
    if (isClosing(text, node)) {
      group.push(k, -1)
      closers.push(k)
    } else {
      const ok = accepts(node)
      group.push(k, ok ? 1 : 0)
      openers.push({ index: k, group, slot, accepts: ok })
    }
  }
  for (const group of groups.values()) group.build()

  const keepRaw = new Set<number>()
  const matched = new Set<number>()
  const closeOf = new Map<number, number>()
  let insideUntil = -1
  for (const opener of openers) {
    if (opener.index < insideUntil) continue
    const slot = opener.group.findClose(opener.slot)
    if (slot < 0) continue
    const close = opener.group.indices[slot]!
    opener.group.clear(slot)
    matched.add(close)
    if (opener.accepts) {
      closeOf.set(opener.index, close)
      insideUntil = close
    } else {
      keepRaw.add(opener.index)
      keepRaw.add(close)
    }
  }
  for (const close of closers) if (!matched.has(close)) keepRaw.add(close)

  const items: Array<Item> = []
  for (let k = from; k < to; k++) {
    const close = closeOf.get(k)
    items.push({ index: k, keepRaw: keepRaw.has(k), close })
    if (close !== undefined) k = close
  }
  return items
}

const isTrue = (value: string) => ["on", "true", "1"].includes(value.trim().toLowerCase())
const isFalse = (value: string) => ["off", "false", "0"].includes(value.trim().toLowerCase())

const isOfType = (value: string, type: string) => {
  const trimmed = value.trim()
  switch (type) {
    case "integer":
      return /^-?\d+$/.test(trimmed)
    case "number":
      return Number.isFinite(Number(trimmed))
    case "boolean":
      return isTrue(trimmed) || isFalse(trimmed)
    default:
      return true
  }
}

const arityOk = (entry: MacroEntry, count: number) => {
  if (!entry.list) return count >= entry.minArgs && count <= entry.maxArgs
  const { min, max } = entry.list === true ? { min: 0, max: undefined } : entry.list
  return count >= entry.minArgs + min && (max === undefined || Math.max(0, count - entry.maxArgs) <= max)
}

const typesOk = (entry: MacroEntry, args: ReadonlyArray<string>) =>
  args.every((value, i) => {
    const type = entry.args?.[i]?.type ?? "string"
    return (typeof type === "string" ? [type] : type).some((t) => isOfType(value, t))
  })

interface Block {
  /** The block's text, between the opener and the closer. */
  readonly start: number
  readonly end: number
  /** Its sibling nodes. */
  readonly from: number
  readonly to: number
  readonly nodes: ReadonlyArray<Node>
}

class Expansion {
  private readonly registry: MacroLookup
  private readonly context: MacroContext

  constructor(registry: MacroLookup, context: MacroContext) {
    this.registry = registry
    this.context = context
  }

  /** ST's MacroEngine.evaluate. `base` is the offset of the text in the outermost one. */
  evaluate(input: string, base: number): string {
    if (!input) return ""
    const text = preprocess(input)
    const nodes = parse(text, MAX_DEPTH)
    if (nodes === "depth") return input
    return postprocess(this.level(text, nodes, 0, nodes.length, 0, text.length, base))
  }

  private entry(name: string) {
    return this.registry.get(name.toLowerCase())
  }

  private acceptsBlock(node: MacroNode) {
    const entry = this.entry(node.name)
    if (!entry) return true
    if (entry.list) return false
    const count = node.args.length + 1
    return count >= entry.minArgs && count <= entry.maxArgs
  }

  /** Evaluates the text from `start` to `end` whose macros are `nodes[from..to)`. */
  private level(
    text: string,
    nodes: ReadonlyArray<Node>,
    from: number,
    to: number,
    start: number,
    end: number,
    base: number
  ): string {
    let out = ""
    let cursor = start
    for (const item of pairScopes(text, nodes, from, to, (node) => this.acceptsBlock(node))) {
      const node = nodes[item.index]!
      out += text.slice(cursor, node.start)
      if (item.keepRaw) {
        out += text.slice(node.start, node.end)
        cursor = node.end
      } else if (item.close === undefined || node.kind !== "macro") {
        out += node.kind === "macro" ? this.macro(text, node, base, undefined) : text.slice(node.start, node.end)
        cursor = node.end
      } else {
        const close = nodes[item.close]!
        const block = { start: node.end, end: close.start, from: item.index + 1, to: item.close, nodes }
        out += this.macro(text, node, base, block)
        cursor = close.end
      }
    }
    return out + text.slice(cursor, end)
  }

  private macro(text: string, node: MacroNode, base: number, block: Block | undefined): string {
    const entry = this.entry(node.name)
    const delay = entry?.delayArgResolution === true
    const args: Array<string> = []
    const values: Array<{ readonly start: number; readonly end: number; readonly value: string }> = []
    for (const region of node.args) {
      const value = delay
        ? text.slice(region.start, region.end)
        : this.level(text, region.nodes, 0, region.nodes.length, region.start, region.end, base)
      args.push(value)
      values.push({ start: region.start, end: region.end, value })
    }
    if (block && block.start >= block.end) args.push("")
    else if (block) {
      let value = delay
        ? text.slice(block.start, block.end)
        : this.level(text, block.nodes, block.from, block.to, block.start, block.end, base)
      if (!delay && !node.flags.includes("#")) value = trimScoped(value)
      args.push(value)
      values.push({ start: block.start, end: block.end, value })
    }

    // The macro as written, with its arguments expanded. For a block this runs past the
    // opener's braces, exactly as ST's rawInner does.
    let inner = ""
    let cursor = node.start + 2
    for (const { start, end, value } of values) {
      if (start > cursor) inner += text.slice(cursor, start)
      inner += value
      cursor = end
    }
    if (cursor < node.end - 2) inner += text.slice(cursor, node.end - 2)
    const asWritten = `{{${inner}}}`

    if (!entry) return asWritten
    const strict = entry.strictArgs !== false
    if (strict && !arityOk(entry, args.length)) return asWritten
    const positional = args.slice(0, entry.maxArgs)
    if (strict && !typesOk(entry, positional)) return asWritten
    const offset = base + node.start
    const call: MacroCall = {
      name: node.name,
      args: positional,
      list: entry.list ? args.slice(entry.maxArgs) : [],
      flags: node.flags,
      isScoped: block !== undefined,
      offset,
      context: this.context,
      resolve: (t) => this.evaluate(t, offset)
    }
    try {
      return entry.handler(call)
    } catch {
      // ST leaves a macro whose handler fails as written.
      return asWritten
    }
  }
}

export interface EvaluateOptions {
  readonly registry: MacroLookup
  readonly context: MacroContext
}

export const evaluateMacros = (text: string, options: EvaluateOptions): string =>
  new Expansion(options.registry, options.context).evaluate(text, 0)
