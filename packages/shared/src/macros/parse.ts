// The macro parser (DESIGN §5.6). It reproduces how SillyTavern's macro engine tokenizes
// and parses text (public/scripts/macros/engine/MacroLexer.js and MacroParser.js, read at
// SillyTavern 06bde939), as a hand-written scanner instead of ST's Chevrotain grammar:
// - No regular expressions, so nothing can backtrack.
// - A macro start is parsed at most once (memoized by position). A malformed macro leaves
//   its "{{" as text and scanning resumes right after it, so failed starts can't make the
//   scan quadratic.
// - Nested macros are parsed with an explicit stack, not recursion, so nesting can't
//   overflow the call stack. A macro that's never closed stays text however deep it goes;
//   evaluation bounds the depth of what did parse.
// - It counts its steps and charges them as work every 64K steps, so a budget that runs out
//   stops it partway.
//
// ST's quirks reproduced here:
// - `{{a::b}}`, `{{a:b}}` and `{{a b}}` all take arguments. Only the `::` form splits them;
//   after a single colon or whitespace the rest is one argument, `::` included.
// - Arguments are trimmed of whitespace (ST's lexer skips it).
// - In a run of braces, the macro starts at the last two: `{{{x}}` is "{" then `{{x}}`.
// - Characters after an identifier that can't follow it are dropped up to the next
//   whitespace, ":", "|" or "}" (Chevrotain's lexer recovery): `{{char's}}` is `{{char}}`.
// - `{{a ++ }}`-style variable shorthands follow ST's operator set and precedence.
//
// Where ST's parser recovers from a malformed macro in other ways (a bad nested macro, an
// operator in the wrong place), the macro stays literal here; ST's recovery varies with
// the input and can swallow text after it.

interface Region {
  /** Trimmed bounds of the raw text, end exclusive. */
  readonly start: number
  readonly end: number
  /** Macros nested in the region. */
  readonly nodes: ReadonlyArray<Node>
}

export interface MacroNode {
  readonly kind: "macro"
  /** Bounds including the braces, end exclusive. */
  readonly start: number
  readonly end: number
  /** Flag symbols in order (`!`, `?`, `~`, `#`, `/`, `>`). */
  readonly flags: string
  /** The identifier as written, or "//" for a comment. */
  readonly name: string
  readonly args: ReadonlyArray<Region>
}

const VAR_OPERATORS = ["++", "--", "??=", "??", "||=", "||", "-=", "==", "!=", ">=", ">", "<=", "<", "+=", "="] as const
type VarOperator = (typeof VAR_OPERATORS)[number]

/** A variable shorthand: `{{.name}}` (chat) or `{{$name}}` (global), with an optional operator. */
export interface VarNode {
  readonly kind: "var"
  readonly start: number
  readonly end: number
  readonly global: boolean
  readonly name: string
  readonly operator: VarOperator | undefined
  readonly value: Region | undefined
}

export type Node = MacroNode | VarNode

const LBRACE = 0x7b
const RBRACE = 0x7d
const COLON = 0x3a
const SLASH = 0x2f
const DOT = 0x2e
const DOLLAR = 0x24
const PIPE = 0x7c
const HYPHEN = 0x2d
const FLAGS = "!?~#/>"

/** JavaScript's `\s`, which is what ST's lexer skips. */
const isSpace = (c: number) =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff

const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const isWord = (c: number) => isAlpha(c) || (c >= 0x30 && c <= 0x39) || c === 0x5f

/** A macro whose raw text, with nested macros, is still being scanned up to "}}". */
interface Scan {
  readonly kind: "scan"
  readonly start: number
  /** Whether "::" separates arguments (`{{a::b::c}}`) rather than being part of one. */
  readonly separators: boolean
  /** What the raw text is for: a macro's arguments, or a variable shorthand's value. */
  readonly head:
    | { readonly kind: "macro"; readonly flags: string; readonly name: string }
    | { readonly kind: "var"; readonly global: boolean; readonly name: string; readonly operator: VarOperator }
  /** Allocated when needed: most scans in hostile text never finish. */
  regions: Array<Region> | undefined
  regionStart: number
  cursor: number
  nodes: Array<Node> | undefined
}

const NO_NODES: ReadonlyArray<Node> = []

/** The macro a finished scan makes, or null: a lone colon with nothing after it is a parse error in ST. */
const finish = (scan: Scan, regions: ReadonlyArray<Region>, end: number): Node | null => {
  const { head, start } = scan
  if (head.kind === "var") return { ...head, start, end, value: regions[0] }
  if (!scan.separators && regions[0]!.start === regions[0]!.end) return null
  return { kind: "macro", start, end, flags: head.flags, name: head.name, args: regions }
}

interface Done {
  readonly kind: "done"
  readonly start: number
  readonly node: Node | null
}

interface Nested {
  readonly kind: "nested"
  readonly start: number
}

const done = (start: number, node: Node | null): Done => ({ kind: "done", start, node })

class Parser {
  private readonly memo = new Map<number, Node | null>()
  /** For each index, the next index whose character can end an identifier (built on first use). */
  private stops: Int32Array | undefined
  private readonly text: string
  private readonly charge: (steps: number) => void
  private steps = 0
  private charged = 0

  constructor(text: string, charge: (steps: number) => void) {
    this.text = text
    this.charge = charge
  }

  private count(n: number) {
    this.steps += n
    if (this.steps - this.charged >= 0x10000) this.flush()
  }

  flush() {
    this.charge(this.steps - this.charged)
    this.charged = this.steps
  }

  document(from = 0): Array<Node> {
    const t = this.text
    const nodes: Array<Node> = []
    let i = from
    for (;;) {
      let p = t.indexOf("{{", i)
      this.count((p < 0 ? t.length : p) - i + 1)
      if (p < 0) return nodes
      while (t.charCodeAt(p + 2) === LBRACE) {
        this.count(1)
        p++
      }
      const node = this.macro(p)
      if (node) {
        nodes.push(node)
        i = node.end
      } else {
        i = p + 2
      }
    }
  }

  private at(i: number, a: number, b: number) {
    return this.text.charCodeAt(i) === a && this.text.charCodeAt(i + 1) === b
  }

  private skipSpace(i: number) {
    while (isSpace(this.text.charCodeAt(i))) {
      this.count(1)
      i++
    }
    return i
  }

  /** Parses the macro starting at `start`, and the macros nested in it, with an explicit stack. */
  private macro(start: number): Node | null {
    const stack: Array<Scan> = []
    let step: Scan | Done | Nested = this.begin(start)
    for (;;) {
      if (step.kind === "scan") {
        stack.push(step)
        step = this.advance(step)
      } else if (step.kind === "nested") {
        step = this.begin(step.start)
      } else {
        // Only nested macros can be tried again, after an enclosing one fails.
        if (step.start !== start) this.memo.set(step.start, step.node)
        if (stack.at(-1)?.start === step.start) stack.pop()
        const parent = stack.at(-1)
        if (!parent) return step.node
        if (step.node === null) {
          // A macro whose nested macro fails fails too, as in ST's parser.
          step = done(parent.start, null)
        } else {
          ;(parent.nodes ??= []).push(step.node)
          parent.cursor = step.node.end
          step = this.advance(parent)
        }
      }
    }
  }

  private begin(start: number): Scan | Done {
    const cached = this.memo.get(start)
    if (cached !== undefined) return done(start, cached)
    const header = this.header(start)
    return header !== null && header.kind === "scan" ? header : done(start, header)
  }

  /** Scans a macro's raw text from its cursor, until a nested macro or the closing "}}". */
  private advance(scan: Scan): Done | Nested {
    const t = this.text
    let i = scan.cursor
    while (i < t.length) {
      this.count(1)
      const c = t.charCodeAt(i)
      const next = t.charCodeAt(i + 1)
      if (c === LBRACE && next === LBRACE) {
        scan.cursor = i
        return { kind: "nested", start: i }
      }
      if ((c === RBRACE && next === RBRACE) || (scan.separators && c === COLON && next === COLON)) {
        let s = scan.regionStart
        let e = i
        while (s < e && isSpace(t.charCodeAt(s))) s++
        while (e > s && isSpace(t.charCodeAt(e - 1))) e--
        const regions = (scan.regions ??= [])
        regions.push({ start: s, end: e, nodes: scan.nodes ?? NO_NODES })
        if (c === RBRACE) return done(scan.start, finish(scan, regions, i + 2))
        scan.regionStart = i + 2
        scan.nodes = undefined
        i += 2
      } else {
        i++
      }
    }
    return done(scan.start, null)
  }

  private scan(start: number, from: number, separators: boolean, head: Scan["head"]): Scan {
    return {
      kind: "scan",
      start,
      separators,
      head,
      regions: undefined,
      regionStart: from,
      cursor: from,
      nodes: undefined
    }
  }

  /** Everything before a macro's raw text: flags, then a name or a variable shorthand. */
  private header(start: number): Node | Scan | null {
    const t = this.text
    let flags = ""
    let i = start + 2
    for (;;) {
      i = this.skipSpace(i)
      const c = t.charCodeAt(i)
      if (this.at(i, RBRACE, RBRACE)) return null
      if (this.at(i, SLASH, SLASH)) return this.args(start, flags, "//", i + 2)
      if (c === DOT || c === DOLLAR) return this.variable(start, c === DOLLAR, i + 1)
      if (i < t.length && FLAGS.includes(t.charAt(i))) {
        flags += t.charAt(i)
        i++
        continue
      }
      if (!isAlpha(c)) return null
      let j = i + 1
      while (isWord(t.charCodeAt(j)) || t.charCodeAt(j) === HYPHEN) {
        this.count(1)
        j++
      }
      return this.afterIdentifier(start, flags, t.slice(i, j), j)
    }
  }

  private afterIdentifier(start: number, flags: string, name: string, i: number): Node | Scan | null {
    for (;;) {
      if (this.at(i, RBRACE, RBRACE)) return { kind: "macro", start, end: i + 2, flags, name, args: [] }
      const c = this.text.charCodeAt(i)
      if (isSpace(c) || c === COLON || c === PIPE || c === RBRACE) return this.args(start, flags, name, i)
      if (i >= this.text.length) return null
      i = this.nextStop(i)
      if (i < 0) return null
    }
  }

  private nextStop(i: number): number {
    if (!this.stops) {
      const t = this.text
      const stops = new Int32Array(t.length + 1)
      stops[t.length] = -1
      for (let k = t.length - 1; k >= 0; k--) {
        const c = t.charCodeAt(k)
        stops[k] = isSpace(c) || c === COLON || c === PIPE || c === RBRACE ? k : stops[k + 1]!
      }
      this.count(t.length)
      this.stops = stops
    }
    return this.stops[i]!
  }

  private args(start: number, flags: string, name: string, i: number): Node | Scan | null {
    i = this.skipSpace(i)
    if (this.at(i, RBRACE, RBRACE)) return { kind: "macro", start, end: i + 2, flags, name, args: [] }
    const head = { kind: "macro", flags, name } as const
    if (this.at(i, COLON, COLON)) return this.scan(start, i + 2, true, head)
    if (this.text.charCodeAt(i) === COLON) i++
    return this.scan(start, i, false, head)
  }

  private variable(start: number, global: boolean, i: number): Node | Scan | null {
    const t = this.text
    i = this.skipSpace(i)
    if (!isAlpha(t.charCodeAt(i))) return null
    let j = i + 1
    while (isWord(t.charCodeAt(j)) || t.charCodeAt(j) === HYPHEN) {
      this.count(1)
      j++
    }
    // A variable name can't end with a hyphen, so `{{.x--}}` is `x` decremented.
    while (t.charCodeAt(j - 1) === HYPHEN) j--
    const name = t.slice(i, j)
    i = this.skipSpace(j)
    const base = { kind: "var", start, global, name } as const
    if (this.at(i, RBRACE, RBRACE)) return { ...base, end: i + 2, operator: undefined, value: undefined }
    const operator = VAR_OPERATORS.find((op) => t.startsWith(op, i))
    if (!operator) return null
    i += operator.length
    if (operator === "++" || operator === "--") {
      i = this.skipSpace(i)
      return this.at(i, RBRACE, RBRACE) ? { ...base, end: i + 2, operator, value: undefined } : null
    }
    return this.scan(start, i, false, { kind: "var", global, name, operator })
  }
}

/**
 * Whether a macro closes a scoped block: `{{/name}}`. ST's lexer reads `{{///}}` as a comment
 * whose argument starts with "/", and treats that as the comment's closer, so this does too.
 */
export const isClosing = (text: string, node: MacroNode) =>
  node.flags.includes("/") ||
  (node.name === "//" && node.args[0] !== undefined && text.charCodeAt(node.args[0].start) === SLASH)

/** Parses the top-level macros of a text, charging each character looked at as work. */
export const parse = (text: string, charge: (steps: number) => void = () => {}, from = 0): ReadonlyArray<Node> => {
  const parser = new Parser(text, charge)
  const nodes = parser.document(from)
  parser.flush()
  return nodes
}
