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
import { isClosing, type MacroNode, type Node, parse, type VarNode } from "./parse.ts"
import type { MacroContext } from "./context.ts"
import { stringHash } from "./hash.ts"
import type { MacroCall, MacroEntry, MacroInfo } from "./registry.ts"
import { normalize, type VariableEffect, VariableScope, type VarScope, type VarValue } from "./variables.ts"

/** What `{{else}}` returns: `{{if}}` splits on it, and any left over is removed at the end. */
export const ELSE_MARKER = "\u0000\u001FELSE\u001F\u0000"

/**
 * Bounds on one expansion. Imported card text is untrusted, and macros can nest, repeat and
 * grow values (macro bombs).
 */
export interface MacroLimits {
  /** Macros evaluated inside one another: arguments, blocks, `{{if}}` branches, card fields. */
  readonly maxDepth: number
  /** Macros evaluated in all. */
  readonly maxExpansions: number
  /**
   * Work in all, which bounds the output and the time taken: about one unit per character
   * produced by a macro, read from or written to a variable, or looked at by the parser, per
   * entry looked at when pairing blocks (a block's content is paired again at each level, as
   * in ST), and per die rolled.
   */
  readonly maxWork: number
}

const DEFAULT_MACRO_LIMITS: MacroLimits = { maxDepth: 32, maxExpansions: 10_000, maxWork: 4_000_000 }

export type MacroLimit = "depth" | "expansions" | "work"

/** Thrown through the evaluation when a limit is reached; the expansion then fails as a whole. */
class LimitReached {
  readonly limit: MacroLimit
  constructor(limit: MacroLimit) {
    this.limit = limit
  }
}

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
 * ST removes `{{trim}}` and the newlines around it with a regex, which is quadratic on long
 * runs of newlines not followed by `{{trim}}`. This is the same replacement as a scan.
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
export const trimScoped = (content: string): string => {
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
  /** Entries looked at, for the work charge. */
  steps = 0
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
      this.steps++
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
      this.steps++
      running += this.values[x]!
      if (running < 0) return x
    }
    for (block++; block < this.sums.length; block++) {
      if (running + this.mins[block]! < 0) {
        for (let x = block * this.width; ; x++) {
          this.steps++
          running += this.values[x]!
          if (running < 0) return x
        }
      }
      this.steps++
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
  accepts: (node: MacroNode) => boolean,
  charge: (steps: number) => void
): ReadonlyArray<Item> => {
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
  for (const group of groups.values()) {
    group.build()
    charge(group.steps)
  }

  const keepRaw = new Set<number>()
  const matched = new Set<number>()
  const closeOf = new Map<number, number>()
  let insideUntil = -1
  for (const opener of openers) {
    if (opener.index < insideUntil) continue
    const before = opener.group.steps
    const slot = opener.group.findClose(opener.slot)
    if (slot >= 0) opener.group.clear(slot)
    charge(opener.group.steps - before)
    if (slot < 0) continue
    const close = opener.group.indices[slot]!
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
/** ST's isFalseBoolean. */
export const isFalse = (value: string) => ["off", "false", "0"].includes(value.trim().toLowerCase())

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

/** State shared by every evaluation in one expansion, nested ones included. */
/** Non-deterministic values by where they were drawn (DESIGN §5.6). */
export type FrozenValues = Readonly<Record<string, string>>

interface Run {
  readonly registry: MacroLookup
  readonly random: () => number
  readonly frozen: FrozenValues
  /** Every frozen value used, reused or new. */
  readonly drawn: Map<string, string>
  /** How often each draw site has been evaluated, so repeats get their own values. */
  readonly sites: Map<string, number>
  readonly seen: Set<string>
  /** Expanded card fields by scope: ST expands each once per evaluation. */
  readonly templates: Map<string, string>
  readonly variables: { readonly local: VariableScope; readonly global: VariableScope }
  readonly limits: MacroLimits
  depth: number
  expansions: number
  work: number
}

const charge = (run: Run, size: number) => {
  run.work += Math.max(0, size)
  if (run.work > run.limits.maxWork) throw new LimitReached("work")
}

const parseCharged = (run: Run, text: string) => {
  const { nodes, steps } = parse(text)
  charge(run, steps)
  return nodes
}

const macroInfo = (text: string, node: Node): MacroInfo | undefined =>
  node.kind === "macro"
    ? {
        name: node.name,
        closing: isClosing(text, node),
        argCount: node.args.length,
        start: node.start,
        end: node.end
      }
    : undefined

class Expansion {
  private readonly run: Run
  private readonly context: MacroContext
  private readonly contentHash: number
  /** Which text this is: "" for the one being expanded, else the card field's scope. */
  private readonly scope: string

  constructor(run: Run, context: MacroContext, content: string, scope: string) {
    this.run = run
    this.context = context
    this.contentHash = stringHash(content)
    this.scope = scope
  }

  /** ST's MacroEngine.evaluate. `base` is the offset of the text in the outermost one. */
  evaluate(input: string, base: number): string {
    if (!input) return ""
    const text = preprocess(input)
    const nodes = parseCharged(this.run, text)
    return postprocess(this.level(text, nodes, 0, nodes.length, 0, text.length, base))
  }

  private entry(name: string) {
    return this.run.registry.get(name.toLowerCase())
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
    const accepts = (node: MacroNode) => this.acceptsBlock(node)
    for (const item of pairScopes(text, nodes, from, to, accepts, (steps) => charge(this.run, steps))) {
      const node = nodes[item.index]!
      out += text.slice(cursor, node.start)
      if (item.keepRaw) {
        out += text.slice(node.start, node.end)
        cursor = node.end
      } else if (item.close === undefined || node.kind !== "macro") {
        out += this.node(text, node, base)
        cursor = node.end
      } else {
        const close = nodes[item.close]!
        const block = { start: node.end, end: close.start, from: item.index + 1, to: item.close, nodes }
        out += this.node(text, node, base, block)
        cursor = close.end
      }
    }
    return out + text.slice(cursor, end)
  }

  private node(text: string, node: Node, base: number, block?: Block): string {
    const run = this.run
    if (++run.expansions > run.limits.maxExpansions) throw new LimitReached("expansions")
    if (++run.depth > run.limits.maxDepth) throw new LimitReached("depth")
    try {
      const out = node.kind === "macro" ? this.macro(text, node, base, block) : this.shorthand(text, node, base)
      charge(run, out.length)
      return out
    } finally {
      run.depth--
    }
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
      contentHash: this.contentHash,
      resolve: (t) => this.evaluate(t, offset),
      expandTemplate: (t, scope) => this.template(t, scope),
      lookup: (name) => this.entry(name.trim()),
      macrosIn: (t) => parseCharged(this.run, t).flatMap((n) => macroInfo(t, n) ?? []),
      random: this.run.random,
      once: (key) => {
        if (this.run.seen.has(key)) return false
        this.run.seen.add(key)
        return true
      },
      variables: this.run.variables,
      charge: (size) => charge(this.run, size)
    }
    const key = entry.volatile ? this.drawKey(entry, offset, args) : undefined
    const frozen = key !== undefined && Object.hasOwn(this.run.frozen, key) ? this.run.frozen[key] : undefined
    let value: string
    try {
      value = typeof frozen === "string" ? frozen : entry.handler(call)
    } catch (error) {
      if (error instanceof LimitReached) throw error
      // ST leaves a macro whose handler fails as written.
      return asWritten
    }
    if (key !== undefined) this.run.drawn.set(key, value)
    return value
  }

  /**
   * Where a non-deterministic macro was drawn: the text, the offset, the macro and its
   * arguments, and how many times that site has been evaluated in this expansion. Changed
   * arguments make a new draw, as does text that moved.
   */
  private drawKey(entry: MacroEntry, offset: number, args: ReadonlyArray<string>) {
    const site = `${this.scope}@${offset}:${entry.id}:${stringHash(args.join("\u0000"))}`
    const n = this.run.sites.get(site) ?? 0
    this.run.sites.set(site, n + 1)
    return n === 0 ? site : `${site}#${n}`
  }

  /**
   * ST's variable shorthands (MacroCstWalker#executeVariableOperation): `{{.name}}` reads a
   * chat variable, `{{$name}}` a global one, and the operators write or compare. The value
   * after an operator is only expanded when it's needed, then trimmed, and its macros are
   * evaluated one by one: scoped blocks don't pair inside it.
   */
  private variable(text: string, node: VarNode, base: number): string {
    const vars = this.run.variables[node.global ? "global" : "local"]
    let expanded: string | undefined
    const value = () => (expanded ??= this.varValue(text, node, base))
    // Comparing or testing a value scans it, so each use costs its length.
    const current = () => {
      const v = vars.get(node.name)
      if (typeof v === "string") charge(this.run, v.length)
      return v
    }
    const number = (a: unknown, b: string, test: (x: number, y: number) => boolean) => {
      const x = Number(a)
      const y = Number(b)
      return String(!Number.isNaN(x) && !Number.isNaN(y) && test(x, y))
    }
    const falsy = (v: unknown) => !v || isFalse(normalize(v))
    switch (node.operator) {
      case undefined:
        return normalize(current())
      case "=":
        vars.set(node.name, value())
        return ""
      case "++":
        return vars.add(node.name, 1)
      case "--":
        return vars.add(node.name, -1)
      case "+=":
        vars.add(node.name, value())
        return ""
      case "-=": {
        const n = Number(value())
        if (!Number.isNaN(n)) vars.add(node.name, -n)
        return ""
      }
      case "||":
        return falsy(current()) ? value() : normalize(current())
      case "??":
        return vars.has(node.name) ? normalize(current()) : value()
      case "||=":
        if (!falsy(current())) return normalize(current())
        vars.set(node.name, value())
        return value()
      case "??=":
        if (vars.has(node.name)) return normalize(current())
        vars.set(node.name, value())
        return value()
      case "==":
        return String(normalize(current()) === value())
      case "!=":
        return String(normalize(current()) !== value())
      case ">":
        return number(current(), value(), (x, y) => x > y)
      case ">=":
        return number(current(), value(), (x, y) => x >= y)
      case "<":
        return number(current(), value(), (x, y) => x < y)
      case "<=":
        return number(current(), value(), (x, y) => x <= y)
    }
  }

  /** A shorthand whose operation fails (deeply nested JSON, say) stays as written, like a macro. */
  private shorthand(text: string, node: VarNode, base: number): string {
    try {
      return this.variable(text, node, base)
    } catch (error) {
      if (error instanceof LimitReached) throw error
      return text.slice(node.start, node.end)
    }
  }

  private varValue(text: string, node: VarNode, base: number): string {
    const region = node.value
    if (!region) return ""
    let out = ""
    let cursor = region.start
    for (const nested of region.nodes) {
      out += text.slice(cursor, nested.start) + this.node(text, nested, base)
      cursor = nested.end
    }
    return (out + text.slice(cursor, region.end)).trim()
  }

  /** ST's baseChatReplace: a separate evaluation of card text, without card fields. */
  private template(text: string, scope: string): string {
    const cached = this.run.templates.get(scope)
    if (cached !== undefined) return cached
    const { card: _card, original: _original, ...context } = this.context
    const result = new Expansion(this.run, context, text, scope).evaluate(text, 0)
    this.run.templates.set(scope, result)
    return result
  }
}

interface EvaluateOptions {
  readonly registry: MacroLookup
  readonly context: MacroContext
  readonly random: () => number
  readonly frozen?: FrozenValues
  readonly limits?: Partial<MacroLimits>
}

interface Evaluated {
  readonly text: string
  readonly frozen: FrozenValues
  readonly effects: ReadonlyArray<VariableEffect>
  readonly variables: {
    readonly local: Readonly<Record<string, VarValue>>
    readonly global: Readonly<Record<string, VarValue>>
  }
}

export const evaluateMacros = (text: string, options: EvaluateOptions): Evaluated | MacroLimit => {
  const effects: Array<VariableEffect> = []
  const { local, global } = options.context.variables ?? {}
  const vars = (initial: Readonly<Record<string, unknown>> | undefined, scope: VarScope) =>
    new VariableScope(initial, scope, effects, (size) => charge(run, size))
  const run: Run = {
    registry: options.registry,
    random: options.random,
    frozen: options.frozen ?? {},
    drawn: new Map(),
    sites: new Map(),
    seen: new Set(),
    templates: new Map(),
    variables: { local: vars(local, "local"), global: vars(global, "global") },
    limits: { ...DEFAULT_MACRO_LIMITS, ...options.limits },
    depth: 0,
    expansions: 0,
    work: 0
  }
  let result: string
  try {
    result = new Expansion(run, options.context, text, "").evaluate(text, 0)
  } catch (error) {
    if (error instanceof LimitReached) return error.limit
    throw error
  }
  return {
    text: result,
    frozen: Object.fromEntries(run.drawn),
    effects,
    variables: { local: run.variables.local.snapshot(), global: run.variables.global.snapshot() }
  }
}
