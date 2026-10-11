// The macro parser (DESIGN §5.6). It reproduces how SillyTavern's macro engine tokenizes
// and parses text (public/scripts/macros/engine/MacroLexer.js and MacroParser.js, read at
// SillyTavern 06bde939), as a hand-written scanner instead of ST's Chevrotain grammar:
// - No regular expressions, so nothing can backtrack.
// - A macro start is parsed at most once (memoized by position). A malformed macro leaves
//   its "{{" as text and scanning resumes right after it, so failed starts can't make the
//   scan quadratic.
// - Nesting is bounded: parsing past `maxDepth` nested macros fails the whole parse.
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

export interface Region {
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
export type VarOperator = (typeof VAR_OPERATORS)[number]

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

/** Thrown inside the parser when nesting exceeds the limit; `parse` turns it into a result. */
class DepthExceeded {}

class Parser {
  private readonly memo = new Map<number, Node | null>()
  /** For each index, the next index whose character can end an identifier (built on first use). */
  private stops: Int32Array | undefined

  private readonly text: string
  private readonly maxDepth: number

  constructor(text: string, maxDepth: number) {
    this.text = text
    this.maxDepth = maxDepth
  }

  document(): Array<Node> {
    const t = this.text
    const nodes: Array<Node> = []
    let i = 0
    for (;;) {
      let p = t.indexOf("{{", i)
      if (p < 0) return nodes
      while (t.charCodeAt(p + 2) === LBRACE) p++
      const node = this.macro(p, 1)
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
    while (isSpace(this.text.charCodeAt(i))) i++
    return i
  }

  private macro(start: number, depth: number): Node | null {
    const cached = this.memo.get(start)
    if (cached !== undefined) return cached
    if (depth > this.maxDepth) throw new DepthExceeded()
    const node = this.parseMacro(start, depth)
    this.memo.set(start, node)
    return node
  }

  private parseMacro(start: number, depth: number): Node | null {
    const t = this.text
    let flags = ""
    let i = start + 2
    for (;;) {
      i = this.skipSpace(i)
      const c = t.charCodeAt(i)
      if (this.at(i, RBRACE, RBRACE)) return null
      if (this.at(i, SLASH, SLASH)) return this.args(start, flags, "//", i + 2, depth)
      if (c === DOT || c === DOLLAR) return this.variable(start, c === DOLLAR, i + 1, depth)
      if (i < t.length && FLAGS.includes(t.charAt(i))) {
        flags += t.charAt(i)
        i++
        continue
      }
      if (!isAlpha(c)) return null
      let j = i + 1
      while (isWord(t.charCodeAt(j)) || t.charCodeAt(j) === HYPHEN) j++
      return this.afterIdentifier(start, flags, t.slice(i, j), j, depth)
    }
  }

  private afterIdentifier(start: number, flags: string, name: string, i: number, depth: number): Node | null {
    for (;;) {
      if (this.at(i, RBRACE, RBRACE)) return { kind: "macro", start, end: i + 2, flags, name, args: [] }
      const c = this.text.charCodeAt(i)
      if (isSpace(c) || c === COLON || c === PIPE || c === RBRACE) return this.args(start, flags, name, i, depth)
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
      this.stops = stops
    }
    return this.stops[i]!
  }

  private args(start: number, flags: string, name: string, i: number, depth: number): Node | null {
    i = this.skipSpace(i)
    if (this.at(i, RBRACE, RBRACE)) return { kind: "macro", start, end: i + 2, flags, name, args: [] }
    const args: Array<Region> = []
    if (this.at(i, COLON, COLON)) {
      for (i += 2; ;) {
        const scanned = this.region(i, true, depth)
        if (!scanned) return null
        args.push(scanned.region)
        if (this.at(scanned.stop, RBRACE, RBRACE))
          return { kind: "macro", start, end: scanned.stop + 2, flags, name, args }
        i = scanned.stop + 2
      }
    }
    if (this.text.charCodeAt(i) === COLON) i++
    const scanned = this.region(i, false, depth)
    // A lone colon with nothing after it is a parse error in ST.
    if (!scanned || scanned.region.start === scanned.region.end) return null
    args.push(scanned.region)
    return { kind: "macro", start, end: scanned.stop + 2, flags, name, args }
  }

  private variable(start: number, global: boolean, i: number, depth: number): Node | null {
    const t = this.text
    i = this.skipSpace(i)
    if (!isAlpha(t.charCodeAt(i))) return null
    let j = i + 1
    while (isWord(t.charCodeAt(j)) || t.charCodeAt(j) === HYPHEN) j++
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
    const scanned = this.region(i, false, depth)
    if (!scanned) return null
    return { ...base, end: scanned.stop + 2, operator, value: scanned.region }
  }

  /** Scans raw text with nested macros up to "}}" (or "::" when `separators`). */
  private region(
    start: number,
    separators: boolean,
    depth: number
  ): { readonly region: Region; readonly stop: number } | null {
    const t = this.text
    const nodes: Array<Node> = []
    let i = start
    while (i < t.length) {
      const c = t.charCodeAt(i)
      const next = t.charCodeAt(i + 1)
      if (c === LBRACE && next === LBRACE) {
        const node = this.macro(i, depth + 1)
        if (!node) return null
        nodes.push(node)
        i = node.end
      } else if ((c === RBRACE && next === RBRACE) || (separators && c === COLON && next === COLON)) {
        let s = start
        let e = i
        while (s < e && isSpace(t.charCodeAt(s))) s++
        while (e > s && isSpace(t.charCodeAt(e - 1))) e--
        return { region: { start: s, end: e, nodes }, stop: i }
      } else {
        i++
      }
    }
    return null
  }
}

/**
 * Whether a macro closes a scoped block: `{{/name}}`. ST's lexer reads `{{///}}` as a comment
 * whose argument starts with "/", and treats that as the comment's closer, so this does too.
 */
export const isClosing = (text: string, node: MacroNode) =>
  node.flags.includes("/") ||
  (node.name === "//" && node.args[0] !== undefined && text.charCodeAt(node.args[0].start) === SLASH)

/** Parses the top-level macros of a text, or "depth" if nesting exceeds `maxDepth`. */
export const parse = (text: string, maxDepth: number): ReadonlyArray<Node> | "depth" => {
  try {
    return new Parser(text, maxDepth).document()
  } catch (error) {
    if (error instanceof DepthExceeded) return "depth"
    throw error
  }
}
