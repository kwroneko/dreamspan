// A message's CSS (spec/HTML-MESSAGES.md §3.2, as ST's decodeStyleTags): its `<style>`s for the
// chat's constructed stylesheet, its style attributes and its SVG presentation attributes.
//
// Safe by construction, not by finding bad patterns:
// - Parsed by a CSS Syntax Level 3 tokenizer and component-value parser (@csstools), the
//   algorithm the browser runs, so escapes, comments, strings, bad strings and brackets split
//   where the browser splits them. Any tokenizer or parser error refuses the whole input.
// - Size and nesting are bounded on the flat token list before anything recursive walks it.
// - Output is written token by token from the parsed tree: only allowlisted token kinds, at-rules,
//   value functions and selector parts; identifiers and strings re-escaped; comments dropped.
// - The written text is tokenized again and must give exactly the tokens that were meant, or
//   nothing is returned. So whatever the browser reads is the structure built here: no rule can
//   end early, and no string, comment or escape can carry text out of its place.
// - Selectors are scoped twice: by a prefix written into each selector, and, where the browser
//   has it, inside `@scope (.message-html)`, which the browser enforces: a rule there styles
//   nothing outside a message body whatever its selector says.
// - Nothing loads unless it's a `data:` or in-document `#` address, or an http(s) address with
//   media consent, which becomes a proxy address built here (media.ts). Every other loading
//   form (image(), image-set(), cross-fade(), element(), paint(), src(), @import, a bare string
//   where an image is expected) is outside the allowlist. Message-defined custom properties
//   pass the same value policy; inherited app variables are not isolated (currently colors,
//   dimensions and font names). Accepted media is queued independently of selector matches.
import {
  type CSSToken,
  HashType,
  type TokenAtKeyword,
  type TokenDimension,
  type TokenFunction,
  type TokenHash,
  type TokenIdent,
  type TokenString,
  type TokenURL,
  TokenType,
  tokenize
} from "@csstools/css-tokenizer"
import {
  type ComponentValue,
  type FunctionNode,
  isCommentNode,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhitespaceNode,
  parseListOfComponentValues,
  type SimpleBlockNode
} from "@csstools/css-parser-algorithms"
import { proxyMediaUrl } from "./media.ts"

/** The class every message body carries, which the card's styles are scoped to. */
export const MESSAGE_SCOPE = "message-html"
/** At most this much CSS from one style (or attribute); past it, nothing of it is kept. */
const MAX_MESSAGE_CSS = 200_000
/** At most this many nested blocks and functions. */
const MAX_DEPTH = 64
// Proposed resource limits, measured with synthetic fonts (ARCHITECTURE §12).
const MAX_FONT_BYTES = 96 * 1024
const MAX_MESSAGE_FONT_BYTES = 192 * 1024
const MAX_FONT_EXPANDED = 2 * 1024 * 1024
const MAX_MESSAGE_FONT_EXPANDED = 4 * 1024 * 1024

/** A reserved class: markup classes are renamed, so they cannot impersonate this root. */
export const messageFontClass = (key: string) =>
  `rpfont-${Array.from(key, (char) => char.codePointAt(0)!.toString(16)).join("-")}`
const fontName = (name: string, policy: Policy) =>
  policy.messageClass ? `${policy.messageClass}-${name.toLowerCase()}` : renameClass(name)

/** MIME and decoded signature must agree. This is a bounded envelope check, not OTS. */
function dataFont(address: string, policy: Policy): string | null {
  if (!policy.messageClass) return null
  const match = /^data:(font\/(?:woff2?|ttf|otf));base64,([a-zA-Z0-9+/]*={0,2})$/i.exec(address)
  if (!match || match[2]!.length > Math.ceil(MAX_FONT_BYTES / 3) * 4 || match[2]!.length % 4) return null
  let bytes: string
  try {
    bytes = atob(match[2]!)
  } catch {
    return null
  }
  if (bytes.length > MAX_FONT_BYTES || bytes.length < 12) return null
  const signature = bytes.slice(0, 4)
  const type =
    signature === "wOF2"
      ? "woff2"
      : signature === "wOFF"
        ? "woff"
        : signature === "OTTO"
          ? "otf"
          : signature === "\x00\x01\x00\x00"
            ? "ttf"
            : null
  if (!type || match[1]!.toLowerCase() !== `font/${type}`) return null
  let expanded = bytes.length
  if (type === "woff" || type === "woff2") {
    if (bytes.length < (type === "woff" ? 44 : 48)) return null
    const uint32 = (at: number) =>
      bytes.charCodeAt(at) * 0x1000000 +
      bytes.charCodeAt(at + 1) * 0x10000 +
      bytes.charCodeAt(at + 2) * 0x100 +
      bytes.charCodeAt(at + 3)
    if (uint32(8) !== bytes.length) return null
    expanded = uint32(16)
    if (expanded < 12) return null
  }
  if (
    expanded > MAX_FONT_EXPANDED ||
    policy.fontBytes + bytes.length > MAX_MESSAGE_FONT_BYTES ||
    policy.fontExpanded + expanded > MAX_MESSAGE_FONT_EXPANDED
  )
    return null
  policy.fontBytes += bytes.length
  policy.fontExpanded += expanded
  return `data:font/${type};base64,${match[2]}`
}

/** Font Awesome's, ST's note and monospace classes keep their names, as in ST. */
export const renameClass = (name: string) =>
  name.startsWith("fa-") || name.startsWith("note-") || name === "monospace" ? name : `custom-${name}`
/** Ids and names in parsed HTML, so they can't clobber the app's own or its globals (fix 3). */
export const renameId = (name: string) => `user-content-${name}`

/**
 * How top-level selectors are kept inside message bodies: `scope` wraps them in
 * `@scope (.message-html)` and prefixes `:scope`, `prefix` prefixes `.message-html` (same
 * specificity). `scope` where the browser supports it.
 */
export type ScopeMode = "scope" | "prefix"
const defaultScopeMode = (): ScopeMode => ("CSSScopeRule" in globalThis ? "scope" : "prefix")

// ---------------------------------------------------------------------------------------------
// Parsing

/** The component values of a CSS text, or null when it is too large, too deep or malformed. */
function parse(css: string): ComponentValue[] | null {
  if (css.length > MAX_MESSAGE_CSS) return null
  let failed = false
  const fail = () => {
    failed = true
  }
  const tokens = tokenize({ css }, { onParseError: fail })
  if (failed) return null
  let depth = 0
  for (const token of tokens) {
    const type = token[0]
    if (
      type === TokenType.Function ||
      type === TokenType.OpenParen ||
      type === TokenType.OpenSquare ||
      type === TokenType.OpenCurly
    ) {
      if (++depth > MAX_DEPTH) return null
    } else if (type === TokenType.CloseParen || type === TokenType.CloseSquare || type === TokenType.CloseCurly) {
      if (--depth < 0) return null
    }
  }
  if (depth !== 0) return null
  const values = parseListOfComponentValues(tokens, { onParseError: fail })
  return failed ? null : values
}

type Item =
  | {
      readonly kind: "decl"
      readonly name: string
      /** The property name as written: an escaped name is refused. */
      readonly raw: string
      readonly value: ReadonlyArray<ComponentValue>
      readonly important: boolean
    }
  | {
      readonly kind: "rule"
      readonly prelude: ReadonlyArray<ComponentValue>
      readonly body: ReadonlyArray<ComponentValue>
    }
  | {
      readonly kind: "at"
      readonly name: string
      readonly prelude: ReadonlyArray<ComponentValue>
      readonly body: ReadonlyArray<ComponentValue> | null
    }

const tokenOf = (value: ComponentValue | undefined): CSSToken | null =>
  value && isTokenNode(value) ? value.value : null
const isToken = (value: ComponentValue | undefined, type: TokenType) => tokenOf(value)?.[0] === type
const isCurly = (value: ComponentValue | undefined): value is SimpleBlockNode =>
  value !== undefined && isSimpleBlockNode(value) && value.startToken[0] === TokenType.OpenCurly
const isBlank = (value: ComponentValue) => isWhitespaceNode(value) || isCommentNode(value)
const trim = (values: ReadonlyArray<ComponentValue>) => {
  let start = 0
  let end = values.length
  while (start < end && isBlank(values[start]!)) start++
  while (end > start && isBlank(values[end - 1]!)) end--
  return values.slice(start, end)
}

/** An at-rule from its at-keyword: its prelude, and its block or none (a statement). */
function atRule(values: ReadonlyArray<ComponentValue>, at: number, items: Item[]): number {
  const keyword = tokenOf(values[at]) as TokenAtKeyword
  let end = at + 1
  while (end < values.length && !isCurly(values[end]) && !isToken(values[end], TokenType.Semicolon)) end++
  const block = values[end]
  items.push({
    kind: "at",
    name: keyword[4].value.toLowerCase(),
    prelude: values.slice(at + 1, end),
    body: isCurly(block) ? block.value : null
  })
  return end + 1
}

/** A stylesheet's (or a grouping rule's) rules: CSS Syntax's "consume a stylesheet's contents". */
function ruleItems(values: ReadonlyArray<ComponentValue>): Item[] {
  const items: Item[] = []
  let at = 0
  while (at < values.length) {
    const value = values[at]!
    const type = tokenOf(value)?.[0]
    if (isBlank(value) || type === TokenType.CDO || type === TokenType.CDC || type === TokenType.EOF) at++
    else if (type === TokenType.AtKeyword) at = atRule(values, at, items)
    else {
      let end = at
      while (end < values.length && !isCurly(values[end])) end++
      // A prelude without a block is dropped, as the browser drops it.
      if (end >= values.length) break
      items.push({ kind: "rule", prelude: values.slice(at, end), body: (values[end] as SimpleBlockNode).value })
      at = end + 1
    }
  }
  return items
}

/** A block's declarations, nested rules and at-rules: "consume a block's contents". */
function blockItems(values: ReadonlyArray<ComponentValue>): Item[] {
  const items: Item[] = []
  let at = 0
  while (at < values.length) {
    const value = values[at]!
    const type = tokenOf(value)?.[0]
    if (isBlank(value) || type === TokenType.Semicolon || type === TokenType.EOF) {
      at++
      continue
    }
    if (type === TokenType.AtKeyword) {
      at = atRule(values, at, items)
      continue
    }
    let end = at
    // A curly block already makes this a nested rule under our policy (declarationOf
    // refuses curly values). Stop there: scanning to a later semicolon for every sibling
    // rule makes a flat list of nested rules quadratic.
    while (end < values.length && !isToken(values[end], TokenType.Semicolon) && !isCurly(values[end])) end++
    const block = values[end]
    if (isCurly(block)) items.push({ kind: "rule", prelude: values.slice(at, end), body: block.value })
    else {
      const declaration = declarationOf(values.slice(at, end))
      if (declaration) items.push(declaration)
    }
    at = end + 1
  }
  return items
}

function declarationOf(values: ReadonlyArray<ComponentValue>): Item | null {
  let at = 0
  while (at < values.length && isBlank(values[at]!)) at++
  const name = tokenOf(values[at])
  if (name?.[0] !== TokenType.Ident) return null
  at++
  while (at < values.length && isBlank(values[at]!)) at++
  if (!isToken(values[at], TokenType.Colon)) return null
  let value = trim(values.slice(at + 1))
  if (value.some(isCurly)) return null
  let important = false
  const last = tokenOf(value[value.length - 1])
  if (last?.[0] === TokenType.Ident && (last as TokenIdent)[4].value.toLowerCase() === "important") {
    const rest = trim(value.slice(0, -1))
    const bang = tokenOf(rest[rest.length - 1])
    if (bang?.[0] === TokenType.Delim && bang[4].value === "!") {
      important = true
      value = trim(rest.slice(0, -1))
    }
  }
  return { kind: "decl", name: (name as TokenIdent)[4].value, raw: name[1], value, important }
}

// ---------------------------------------------------------------------------------------------
// Writing: every output token is meant, and checked again after writing

interface Out {
  readonly text: string
  /** What the token is, as the tokenizer reports it; compared after writing. */
  readonly key: string
  readonly type: TokenType
  readonly delim?: string
  readonly media?: string
}

const keyOf = (token: CSSToken): string => {
  switch (token[0]) {
    case TokenType.Ident:
    case TokenType.Function:
    case TokenType.AtKeyword:
    case TokenType.String:
    case TokenType.URL:
    case TokenType.Delim:
      return `${token[0]}:${(token[4] as { value: string }).value}`
    case TokenType.Hash:
      return `${token[0]}:${(token as TokenHash)[4].value}`
    case TokenType.Number:
    case TokenType.Percentage:
    case TokenType.Dimension:
      return `${token[0]}:${token[1]}`
    default:
      return token[0]
  }
}

const NAME = /^[-\w]$/
const isNameChar = (char: string) => NAME.test(char) || char.codePointAt(0)! >= 0x80
const hex = (char: string) => `\\${char.codePointAt(0)!.toString(16)} `

/** CSSOM's "serialize an identifier". */
function serializeIdent(value: string): string {
  let out = ""
  const chars = [...value]
  chars.forEach((char, index) => {
    const code = char.codePointAt(0)!
    if (code === 0) out += "�"
    else if (code < 0x20 || code === 0x7f) out += hex(char)
    else if ((index === 0 || (index === 1 && chars[0] === "-")) && code >= 0x30 && code <= 0x39) out += hex(char)
    else if (index === 0 && char === "-" && chars.length === 1) out += "\\-"
    else if (isNameChar(char)) out += char
    else out += `\\${char}`
  })
  return out
}
const serializeName = (value: string) =>
  [...value]
    .map((char) => {
      const code = char.codePointAt(0)!
      if (code === 0) return "�"
      if (code < 0x20 || code === 0x7f) return hex(char)
      return isNameChar(char) ? char : `\\${char}`
    })
    .join("")
/** CSSOM's "serialize a string", with every control escaped. */
const serializeString = (value: string) =>
  `"${[...value]
    .map((char) => {
      const code = char.codePointAt(0)!
      if (code === 0) return "�"
      if (code < 0x20 || code === 0x7f) return hex(char)
      return char === '"' || char === "\\" ? `\\${char}` : char
    })
    .join("")}"`

/**
 * Whether two tokens written together might read as something else (an ident and a number as
 * one ident, `/` and `*` as a comment, an ident and `(` as a function, …). Punctuation and
 * strings end where they end; every other pair is tried with the tokenizer.
 */
const CLOSED = new Set([
  TokenType.Whitespace,
  TokenType.String,
  TokenType.OpenCurly,
  TokenType.CloseCurly,
  TokenType.OpenSquare,
  TokenType.CloseSquare,
  TokenType.CloseParen,
  TokenType.Colon,
  TokenType.Semicolon,
  TokenType.Comma
])
const mayMerge = (a: Out, b: Out) =>
  !CLOSED.has(a.type) && a.type !== TokenType.OpenParen && a.type !== TokenType.Function && !CLOSED.has(b.type)

/** Whether two tokens written together come back as themselves. */
const together = new Map<string, boolean>()
function separate(a: Out, b: Out): boolean {
  if (!mayMerge(a, b)) return false
  const pair = `${a.text}\u0000${b.text}`
  let cached = together.get(pair)
  if (cached === undefined) {
    const tokens = tokenize({ css: a.text + b.text }, { onParseError: () => {} })
    cached = !(tokens.length === 3 && keyOf(tokens[0]!) === a.key && keyOf(tokens[1]!) === b.key)
    if (together.size > 4096) together.clear()
    together.set(pair, cached)
  }
  return cached
}

class Writer {
  readonly out: Out[] = []
  mark() {
    return this.out.length
  }
  reset(mark: number) {
    this.out.length = mark
  }
  private push(out: Out) {
    this.out.push(out)
  }
  space() {
    const last = this.out[this.out.length - 1]
    if (last && last.type !== TokenType.Whitespace)
      this.push({ text: " ", key: TokenType.Whitespace, type: TokenType.Whitespace })
  }
  ident(value: string) {
    this.push({ text: serializeIdent(value), key: `${TokenType.Ident}:${value}`, type: TokenType.Ident })
  }
  fn(name: string) {
    this.push({ text: `${serializeIdent(name)}(`, key: `${TokenType.Function}:${name}`, type: TokenType.Function })
  }
  at(name: string) {
    this.push({ text: `@${serializeIdent(name)}`, key: `${TokenType.AtKeyword}:${name}`, type: TokenType.AtKeyword })
  }
  hash(value: string) {
    this.push({ text: `#${serializeName(value)}`, key: `${TokenType.Hash}:${value}`, type: TokenType.Hash })
  }
  string(value: string, media?: string) {
    this.push({
      text: serializeString(value),
      key: `${TokenType.String}:${value}`,
      type: TokenType.String,
      ...(media === undefined ? {} : { media })
    })
  }
  delim(char: string) {
    this.push({ text: char, key: `${TokenType.Delim}:${char}`, type: TokenType.Delim, delim: char })
  }
  number(token: CSSToken) {
    this.push({ text: token[1], key: `${token[0]}:${token[1]}`, type: token[0] })
  }
  punct(text: "(" | ")" | "[" | "]" | "{" | "}" | ":" | ";" | ",") {
    const type = {
      "(": TokenType.OpenParen,
      ")": TokenType.CloseParen,
      "[": TokenType.OpenSquare,
      "]": TokenType.CloseSquare,
      "{": TokenType.OpenCurly,
      "}": TokenType.CloseCurly,
      ":": TokenType.Colon,
      ";": TokenType.Semicolon,
      ",": TokenType.Comma
    }[text]
    this.push({ text, key: type, type })
  }
  /** The text, or null when the tokenizer would read it as anything but the tokens written. */
  text(from = 0, to = this.out.length): string | null {
    let text = ""
    let previous: Out | null = null
    const meant: string[] = []
    for (let index = from; index < to; index++) {
      const out = this.out[index]!
      if (
        previous &&
        previous.type !== TokenType.Whitespace &&
        out.type !== TokenType.Whitespace &&
        separate(previous, out)
      )
        text += "/**/"
      text += out.text
      meant.push(out.key)
      previous = out
    }
    let failed = false
    const read = tokenize({ css: text }, { onParseError: () => (failed = true) })
    if (failed) return null
    let at = 0
    for (const token of read) {
      if (token[0] === TokenType.Comment || token[0] === TokenType.EOF) continue
      if (keyOf(token) !== meant[at++]) return null
    }
    return at === meant.length ? text : null
  }
}

// ---------------------------------------------------------------------------------------------
// Values

/** Functions whose arguments name no resource. Everything else is refused. */
const VALUE_FUNCTIONS = new Set(
  (
    "rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark " +
    "calc min max clamp round mod rem abs sign sqrt pow hypot log exp sin cos tan asin acos atan atan2 " +
    "var env linear-gradient radial-gradient conic-gradient repeating-linear-gradient repeating-radial-gradient repeating-conic-gradient " +
    "-webkit-linear-gradient -webkit-radial-gradient -webkit-repeating-linear-gradient -webkit-repeating-radial-gradient " +
    "translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d rotate rotatex rotatey rotatez rotate3d skew skewx skewy matrix matrix3d perspective " +
    "blur brightness contrast drop-shadow grayscale hue-rotate invert opacity saturate sepia " +
    "cubic-bezier steps linear local format tech counter counters rect inset circle ellipse polygon path " +
    "repeat minmax fit-content"
  ).split(" ")
)
/** Conditions of @media, @supports and @container also take these. */
const PRELUDE_FUNCTIONS = new Set([...VALUE_FUNCTIONS, "selector", "style", "font-tech", "font-format", "scroll-state"])
const VALUE_DELIMS = new Set(["/", "*", "+", "-", ".", "<", ">", "=", "%", "&", "|", "~", "^", "$"])
/** Old properties that bind behaviour rather than style. */
const REFUSED_PROPERTIES = new Set(["behavior", "-ms-behavior", "-moz-binding"])
const PROPERTY = /^(?:--[-\w]+|-?[a-zA-Z][-a-zA-Z0-9]*)$/
const REMOTE = /^\s*(?:https?:)?\/\//i

interface Policy {
  readonly mediaScope: string | null | undefined
  /** Something naming another site was left out: the message says so. */
  remote: boolean
  readonly keyframes: ReadonlySet<string>
  readonly fonts: ReadonlySet<string>
  readonly messageClass?: string
  fontBytes: number
  fontExpanded: number
}
interface ValueOptions {
  readonly functions: ReadonlySet<string>
  /** url() is written at all (never in conditions). */
  readonly urls: boolean
  readonly fontSource?: boolean
  /** In-document `#` addresses only (SVG presentation attributes). */
  readonly fragmentsOnly?: boolean
  /** Names this stylesheet defines, renamed where they're used. */
  readonly rename?: "keyframes" | "fonts"
}

/** Whether refused values named another site: their url()s and the strings of loading functions. */
function mentionsRemote(values: ReadonlyArray<ComponentValue>): boolean {
  for (const value of values) {
    const token = tokenOf(value)
    if (token && (token[0] === TokenType.URL || token[0] === TokenType.String))
      if (REMOTE.test((token as TokenURL | TokenString)[4].value)) return true
    if ((isFunctionNode(value) || isSimpleBlockNode(value)) && mentionsRemote(value.value)) return true
  }
  return false
}

/** The one string a `url(` function takes, or null. */
function urlArgument(node: FunctionNode): string | null {
  const args = trim(node.value)
  const token = tokenOf(args[0])
  return args.length === 1 && token?.[0] === TokenType.String ? (token as TokenString)[4].value : null
}

function writeUrl(address: string, writer: Writer, policy: Policy, options: ValueOptions): boolean {
  const value = address.trim()
  let target: string | null = null
  if (value.startsWith("#") && value.length > 1) target = `#${renameId(value.slice(1))}`
  else if (!options.fragmentsOnly && /^data:/i.test(value))
    target = options.fontSource ? dataFont(value, policy) : value
  else if (!options.fragmentsOnly) target = proxyMediaUrl(value, policy.mediaScope)
  if (target === null) {
    policy.remote ||= REMOTE.test(value)
    return false
  }
  writer.fn("url")
  // Track queued addresses on the output token, which is discarded with a refused rule.
  writer.string(target, target.startsWith("/media/external?") ? target : undefined)
  writer.punct(")")
  return true
}

function writeValue(
  values: ReadonlyArray<ComponentValue>,
  writer: Writer,
  policy: Policy,
  options: ValueOptions
): boolean {
  for (const value of values) {
    if (isWhitespaceNode(value)) writer.space()
    else if (isCommentNode(value)) continue
    else if (isFunctionNode(value)) {
      const name = value.getName().toLowerCase()
      if (name === "url") {
        const address = urlArgument(value)
        if (!options.urls || address === null || !writeUrl(address, writer, policy, options)) return false
        continue
      }
      if (!options.functions.has(name)) return false
      writer.fn(name)
      if (!writeValue(value.value, writer, policy, options)) return false
      writer.punct(")")
    } else if (isSimpleBlockNode(value)) {
      const open = value.startToken[0]
      if (open !== TokenType.OpenParen && open !== TokenType.OpenSquare) return false
      writer.punct(open === TokenType.OpenParen ? "(" : "[")
      if (!writeValue(value.value, writer, policy, options)) return false
      writer.punct(open === TokenType.OpenParen ? ")" : "]")
    } else {
      const token = value.value
      switch (token[0]) {
        case TokenType.Ident: {
          const name = (token as TokenIdent)[4].value
          if (name.toLowerCase().startsWith("rpfont-")) return false
          writer.ident(renamed(name, policy, options) ?? name)
          break
        }
        case TokenType.String: {
          const text = (token as TokenString)[4].value
          if (text.toLowerCase().includes("rpfont-")) return false
          const name =
            options.rename === "fonts" && policy.fonts.has(text.toLowerCase()) ? fontName(text, policy) : text
          writer.string(name)
          break
        }
        case TokenType.Hash:
          writer.hash((token as TokenHash)[4].value)
          break
        case TokenType.Number:
        case TokenType.Percentage:
        case TokenType.Dimension:
          if (!plainNumber(token)) return false
          writer.number(token)
          break
        case TokenType.Comma:
          writer.punct(",")
          break
        case TokenType.Colon:
          writer.punct(":")
          break
        case TokenType.Delim:
          if (!VALUE_DELIMS.has(token[4].value)) return false
          writer.delim(token[4].value)
          break
        case TokenType.URL:
          if (!options.urls || !writeUrl((token as TokenURL)[4].value, writer, policy, options)) return false
          break
        case TokenType.EOF:
          break
        default:
          return false
      }
    }
  }
  return true
}
const renamed = (name: string, policy: Policy, options: ValueOptions) =>
  options.rename === "keyframes" && policy.keyframes.has(name)
    ? renameClass(name)
    : options.rename === "fonts" && policy.fonts.has(name.toLowerCase())
      ? fontName(name, policy)
      : null
/** A number written plainly: digits, a sign, a point, an exponent and an unescaped unit. */
function plainNumber(token: CSSToken): boolean {
  let numeric = token[1]
  if (token[0] === TokenType.Percentage) numeric = numeric.slice(0, -1)
  if (token[0] === TokenType.Dimension) {
    const unit = (token as TokenDimension)[4].unit
    if (!/^-?[a-zA-Z_][-\w]*$/.test(unit) || !numeric.endsWith(unit)) return false
    numeric = numeric.slice(0, -unit.length)
  }
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric)
}

const TEXT_ATTRIBUTES = new Set(["title", "alt", "data-label", "data-value", "data-text", "data-tooltip"])

/** No substitutions, URLs or nesting: every non-string must be precisely attr(one safe ident). */
function writeGeneratedText(values: ReadonlyArray<ComponentValue>, writer: Writer): boolean {
  for (const value of values) {
    const token = tokenOf(value)
    if (isBlank(value)) {
      if (isWhitespaceNode(value)) writer.space()
    } else if (token?.[0] === TokenType.String) writer.string((token as TokenString)[4].value)
    else if (isFunctionNode(value) && value.getName().toLowerCase() === "attr") {
      const args = trim(value.value)
      const name = tokenOf(args[0])
      if (args.length !== 1 || name?.[0] !== TokenType.Ident || !TEXT_ATTRIBUTES.has((name as TokenIdent)[4].value))
        return false
      writer.fn("attr")
      writer.ident((name as TokenIdent)[4].value)
      writer.punct(")")
    } else return false
  }
  return true
}

/** All selector branches must end at the generated pseudo-element itself. */
function textPseudo(prelude: ReadonlyArray<ComponentValue>): boolean {
  return selectorList(prelude).every((selector) => {
    const tail = selector.filter((value) => !isCommentNode(value)).slice(-3)
    const name = tokenOf(tail[2])
    return (
      isToken(tail[0], TokenType.Colon) &&
      isToken(tail[1], TokenType.Colon) &&
      name?.[0] === TokenType.Ident &&
      /^(before|after)$/i.test((name as TokenIdent)[4].value)
    )
  })
}

/** One declaration (`prop: value[ !important];`), or nothing when its name or value is refused. */
function writeDeclaration(
  item: Extract<Item, { kind: "decl" }>,
  writer: Writer,
  policy: Policy,
  generatedText = false,
  fontSource = false
): boolean {
  const name = item.name.startsWith("--") ? item.name : item.name.toLowerCase()
  if (item.raw !== item.name || !PROPERTY.test(item.name) || REFUSED_PROPERTIES.has(name)) return false
  const mark = writer.mark()
  writer.ident(name)
  writer.punct(":")
  writer.space()
  const rename =
    name === "animation" || name === "animation-name"
      ? "keyframes"
      : name === "font" || name === "font-family"
        ? "fonts"
        : undefined
  if (
    !(generatedText &&
    name === "content" &&
    item.value.some((value) => isFunctionNode(value) && value.getName().toLowerCase() === "attr")
      ? writeGeneratedText(item.value, writer)
      : writeValue(item.value, writer, policy, {
          functions: fontSource ? new Set(["local", "format", "tech"]) : VALUE_FUNCTIONS,
          urls: true,
          fontSource,
          ...(rename ? { rename } : {})
        }))
  ) {
    policy.remote ||= mentionsRemote(item.value)
    writer.reset(mark)
    return false
  }
  if (item.important) {
    writer.space()
    writer.delim("!")
    writer.ident("important")
  }
  writer.punct(";")
  return true
}

// ---------------------------------------------------------------------------------------------
// Selectors

const SELECTOR_DELIMS = new Set([".", "*", ">", "+", "~", "|", "&"])
const ATTRIBUTE_DELIMS = new Set(["=", "~", "|", "^", "$", "*"])

/** Selectors separated by top-level commas. */
function selectorList(values: ReadonlyArray<ComponentValue>): ReadonlyArray<ReadonlyArray<ComponentValue>> {
  const list: ComponentValue[][] = [[]]
  for (const value of values) {
    if (isToken(value, TokenType.Comma)) list.push([])
    else list[list.length - 1]!.push(value)
  }
  return list.map(trim)
}

/** How many `&`s a selector has, at any depth. */
function nestingCount(values: ReadonlyArray<ComponentValue>): number {
  let count = 0
  for (const value of values) {
    const token = tokenOf(value)
    if (token?.[0] === TokenType.Delim && token[4].value === "&") count++
    if (isFunctionNode(value) || isSimpleBlockNode(value)) count += nestingCount(value.value)
  }
  return count
}

/**
 * A selector, its classes and ids renamed as the markup's are. `depth` is 0 outside functions:
 * there numbers, strings and commas can't appear.
 */
function writeSelector(values: ReadonlyArray<ComponentValue>, writer: Writer, depth: number): boolean {
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (isWhitespaceNode(value)) writer.space()
    else if (isCommentNode(value)) continue
    else if (isFunctionNode(value)) {
      // Functional pseudo-classes and pseudo-elements only, as `:is(`, `::part(`.
      const before = writer.out[writer.out.length - 1]
      if (before?.type !== TokenType.Colon) return false
      writer.fn((value.name as TokenFunction)[4].value)
      if (!writeSelector(value.value, writer, depth + 1)) return false
      writer.punct(")")
    } else if (isSimpleBlockNode(value)) {
      if (value.startToken[0] !== TokenType.OpenSquare || !writeAttribute(value.value, writer)) return false
    } else {
      const token = value.value
      switch (token[0]) {
        case TokenType.Ident:
          writer.ident((token as TokenIdent)[4].value)
          break
        case TokenType.Hash:
          if ((token as TokenHash)[4].type !== HashType.ID) return false
          writer.hash(renameId((token as TokenHash)[4].value))
          break
        case TokenType.Colon:
          writer.punct(":")
          break
        case TokenType.Delim: {
          const char = token[4].value
          if (!SELECTOR_DELIMS.has(char)) return false
          writer.delim(char)
          if (char === ".") {
            // A class: `.` and its name, comments between them or not.
            let next = index + 1
            while (next < values.length && isCommentNode(values[next]!)) next++
            const name = tokenOf(values[next])
            if (name?.[0] !== TokenType.Ident) return false
            writer.ident(renameClass((name as TokenIdent)[4].value))
            index = next
          }
          break
        }
        case TokenType.Number:
        case TokenType.Percentage:
        case TokenType.Dimension:
          if (depth === 0 || !plainNumber(token)) return false
          writer.number(token)
          break
        case TokenType.String:
          if (depth === 0) return false
          writer.string((token as TokenString)[4].value)
          break
        case TokenType.Comma:
          if (depth === 0) return false
          writer.punct(",")
          break
        default:
          return false
      }
    }
  }
  return true
}

/** An attribute selector's brackets: names, operators, strings and flags, as written. */
function writeAttribute(values: ReadonlyArray<ComponentValue>, writer: Writer): boolean {
  writer.punct("[")
  for (const value of values) {
    if (isWhitespaceNode(value)) writer.space()
    else if (isCommentNode(value)) continue
    else {
      const token = tokenOf(value)
      if (token?.[0] === TokenType.Ident) writer.ident((token as TokenIdent)[4].value)
      else if (token?.[0] === TokenType.String) writer.string((token as TokenString)[4].value)
      else if (token?.[0] === TokenType.Delim && ATTRIBUTE_DELIMS.has(token[4].value)) writer.delim(token[4].value)
      else return false
    }
  }
  writer.punct("]")
  return true
}

/**
 * A style rule's selectors, each on its own: a refused one is left out. A top-level one gets
 * the scope in front; one starting with a sibling combinator would select the message's
 * siblings, so it goes. A nested one is relative to its parent, which is scoped already; an
 * explicit `&` is allowed only once, at its start, so `:is(&, body)` can't name the app.
 */
function writeSelectors(
  prelude: ReadonlyArray<ComponentValue>,
  writer: Writer,
  nested: boolean,
  mode: ScopeMode,
  ownClass?: string
): boolean {
  let written = 0
  for (const selector of selectorList(prelude)) {
    if (selector.length === 0) continue
    const first = tokenOf(selector[0])
    const firstDelim = first?.[0] === TokenType.Delim ? first[4].value : null
    if (!nested && (firstDelim === "+" || firstDelim === "~" || firstDelim === "|")) continue
    const ampersands = nestingCount(selector)
    if (nested && ampersands > 0 && !(ampersands === 1 && firstDelim === "&")) continue
    const mark = writer.mark()
    if (written > 0) writer.punct(",")
    if (!nested) {
      if (mode === "scope") {
        writer.punct(":")
        writer.ident("scope")
      } else {
        writer.delim(".")
        writer.ident(MESSAGE_SCOPE)
      }
      if (ownClass) {
        writer.delim(".")
        writer.ident(ownClass)
      }
      writer.space()
    }
    if (writeSelector(selector, writer, 0)) written++
    else writer.reset(mark)
  }
  return written > 0
}

// ---------------------------------------------------------------------------------------------
// Rules

/** At-rules whose content is scoped as the rest; their own conditions pass the value policy. */
const GROUPING = new Set(["media", "supports", "container", "starting-style"])
const KEYFRAMES = new Set(["keyframes", "-webkit-keyframes"])
const SIMPLE_NAME = /^-?[_a-zA-Z][-\w]*$/

interface Context {
  readonly policy: Policy
  readonly mode: ScopeMode
  readonly declarations?: "shared" | "fonts"
  readonly generatedText?: boolean
}

function writeRule(item: Extract<Item, { kind: "rule" }>, writer: Writer, context: Context, nested: boolean) {
  const mark = writer.mark()
  if (
    !writeSelectors(
      item.prelude,
      writer,
      nested,
      context.mode,
      context.declarations === "fonts" ? context.policy.messageClass : undefined
    )
  )
    return writer.reset(mark)
  writer.punct("{")
  const bodyFrom = writer.mark()
  writeBlock(blockItems(item.body), writer, { ...context, generatedText: textPseudo(item.prelude) })
  if (context.declarations === "fonts" && writer.mark() === bodyFrom) return writer.reset(mark)
  writer.punct("}")
}

/** A style rule's contents: declarations, nested rules, nested grouping rules. */
function writeBlock(items: ReadonlyArray<Item>, writer: Writer, context: Context) {
  for (const item of items) {
    if (item.kind === "decl") {
      const font = /^(font|font-family)$/i.test(item.name)
      if (!context.declarations || (context.declarations === "fonts" ? font : !font))
        writeDeclaration(item, writer, context.policy, context.generatedText)
    } else if (item.kind === "rule") writeRule(item, writer, context, true)
    else writeAtRule(item, writer, context, true)
  }
}

/** Rules at the top or in a top-level grouping rule. */
function writeRules(items: ReadonlyArray<Item>, writer: Writer, context: Context) {
  for (const item of items) {
    if (item.kind === "rule") writeRule(item, writer, context, false)
    else if (item.kind === "at") writeAtRule(item, writer, context, false)
  }
}

function writeAtRule(item: Extract<Item, { kind: "at" }>, writer: Writer, context: Context, nested: boolean) {
  if (item.body === null) return
  if (item.name === "layer") {
    // Unlayered, as the card wrote it for a page without layers.
    if (
      item.prelude.some(
        (value) => !isBlank(value) && !isToken(value, TokenType.Ident) && !isToken(value, TokenType.Delim)
      )
    )
      return
    if (nested) writeBlock(blockItems(item.body), writer, context)
    else writeRules(ruleItems(item.body), writer, context)
    return
  }
  if (!GROUPING.has(item.name)) return
  const mark = writer.mark()
  writer.at(item.name)
  const prelude = trim(item.prelude)
  if (item.name === "starting-style" ? prelude.length > 0 : prelude.length === 0) return writer.reset(mark)
  if (prelude.length) {
    writer.space()
    if (!writeValue(prelude, writer, context.policy, { functions: PRELUDE_FUNCTIONS, urls: false }))
      return writer.reset(mark)
  }
  writer.punct("{")
  if (nested) writeBlock(blockItems(item.body), writer, context)
  else writeRules(ruleItems(item.body), writer, context)
  writer.punct("}")
}

/** `@keyframes name`, renamed, with its frames' declarations through the value policy. */
function writeKeyframes(item: Extract<Item, { kind: "at" }>, writer: Writer, context: Context) {
  const name = keyframesName(item)
  if (name === null || item.body === null) return
  writer.at(item.name)
  writer.space()
  writer.ident(renameClass(name))
  writer.punct("{")
  for (const frame of ruleItems(item.body)) {
    if (frame.kind !== "rule") continue
    const frameMark = writer.mark()
    let ok = true
    for (const value of frame.prelude) {
      const token = tokenOf(value)
      if (isBlank(value)) writer.space()
      else if (token?.[0] === TokenType.Percentage && plainNumber(token)) writer.number(token)
      else if (token?.[0] === TokenType.Comma) writer.punct(",")
      else if (token?.[0] === TokenType.Ident && /^(?:from|to)$/i.test((token as TokenIdent)[4].value))
        writer.ident((token as TokenIdent)[4].value.toLowerCase())
      else ok = false
    }
    if (!ok) {
      writer.reset(frameMark)
      continue
    }
    writer.punct("{")
    for (const declaration of blockItems(frame.body))
      if (
        declaration.kind === "decl" &&
        !(context.policy.messageClass && /^(font|font-family)$/i.test(declaration.name))
      )
        writeDeclaration(declaration, writer, context.policy)
    writer.punct("}")
  }
  writer.punct("}")
}
function keyframesName(item: Extract<Item, { kind: "at" }>): string | null {
  const prelude = trim(item.prelude)
  const token = tokenOf(prelude[0])
  if (prelude.length !== 1 || !token || (token[0] !== TokenType.Ident && token[0] !== TokenType.String)) return null
  const name = (token as TokenIdent | TokenString)[4].value
  return SIMPLE_NAME.test(name) ? name : null
}

/**
 * `@font-face`: its one family renamed (only a single plain name, quoted or not, so it can't
 * stay global and redefine a font the app uses), descriptors through the value policy, and the
 * whole face dropped when no `src` is left.
 */
function writeFontFace(item: Extract<Item, { kind: "at" }>, writer: Writer, context: Context) {
  if (item.body === null || trim(item.prelude).length) return
  const descriptors = blockItems(item.body).filter((entry) => entry.kind === "decl")
  if (descriptors.some((entry) => entry.raw !== entry.name)) return
  const families = descriptors.filter((entry) => entry.name.toLowerCase() === "font-family")
  const family = families.length === 1 ? fontFamily(families[0]!) : null
  if (family === null) return
  const mark = writer.mark()
  writer.at("font-face")
  writer.punct("{")
  let sources = 0
  for (const entry of descriptors) {
    const name = entry.name.toLowerCase()
    if (name === "font-family") {
      writer.ident("font-family")
      writer.punct(":")
      writer.space()
      if (family.quoted) writer.string(fontName(family.name, context.policy))
      else writer.ident(fontName(family.name, context.policy))
      writer.punct(";")
    } else if (
      name !== "unicode-range" &&
      writeDeclaration(entry, writer, context.policy, false, name === "src") &&
      name === "src"
    )
      sources++
  }
  writer.punct("}")
  if (sources === 0) writer.reset(mark)
}
function fontFamily(entry: Extract<Item, { kind: "decl" }>): { name: string; quoted: boolean } | null {
  const token = tokenOf(entry.value[0])
  if (entry.value.length !== 1 || !token || (token[0] !== TokenType.Ident && token[0] !== TokenType.String)) return null
  const name = (token as TokenIdent | TokenString)[4].value
  return SIMPLE_NAME.test(name) ? { name, quoted: token[0] === TokenType.String } : null
}

/** The names a stylesheet defines globally (keyframes, fonts), renamed with their uses. */
function definedNames(items: ReadonlyArray<Item>) {
  const keyframes = new Set<string>()
  const fonts = new Set<string>()
  for (const item of items) {
    if (item.kind !== "at" || item.body === null) continue
    if (KEYFRAMES.has(item.name)) {
      const name = keyframesName(item)
      if (name !== null) keyframes.add(name)
    } else if (item.name === "font-face")
      for (const entry of blockItems(item.body))
        if (entry.kind === "decl" && entry.name.toLowerCase() === "font-family") {
          const family = fontFamily(entry)
          if (family) fonts.add(family.name.toLowerCase())
        }
  }
  return { keyframes, fonts }
}

// ---------------------------------------------------------------------------------------------
// Entry points

export interface ScopedCss {
  readonly media?: ReadonlyArray<string>
  readonly css: string
  /** Something from another site was left out: the message says so. */
  readonly blocked: boolean
}

/** Each of a message's `<style>`s scoped on its own, so one that doesn't parse leaves the others. */
export function scopeStyles(
  styles: ReadonlyArray<string>,
  mediaScope?: string | null,
  mode: ScopeMode = defaultScopeMode(),
  messageKey?: string
): ScopedCss {
  const parsed = styles.map((css) => {
    const values = parse(css)
    return values ? ruleItems(values) : null
  })
  const policy: Policy = {
    mediaScope,
    remote: false,
    fontBytes: 0,
    fontExpanded: 0,
    ...(messageKey === undefined ? {} : { messageClass: messageFontClass(messageKey) }),
    ...definedNames(parsed.flatMap((items) => items ?? []))
  }
  const scoped = parsed.map((items, index) =>
    items === null ? { css: "", blocked: styles[index]!.length > MAX_MESSAGE_CSS } : scopeItems(items, policy, mode)
  )
  return {
    css: scoped
      .map((one) => one.css)
      .filter((css) => css !== "")
      .join("\n"),
    media: scoped.flatMap((one) => one.media ?? []),
    blocked: scoped.some((one) => one.blocked)
  }
}

/** A message's CSS inside message bodies; CSS that doesn't parse is left out whole. */
export function scopeCss(css: string, mediaScope?: string | null, mode: ScopeMode = defaultScopeMode()): ScopedCss {
  return scopeStyles([css], mediaScope, mode)
}

function scopeItems(items: ReadonlyArray<Item>, policy: Policy, mode: ScopeMode): ScopedCss {
  const context: Context = {
    policy,
    mode,
    ...(policy.messageClass && policy.fonts.size ? { declarations: "shared" as const } : {})
  }
  const writer = new Writer()
  // Keyframes and fonts are global names (renamed); everything else is scoped.
  for (const item of items)
    if (item.kind === "at" && KEYFRAMES.has(item.name)) writeKeyframes(item, writer, context)
    else if (item.kind === "at" && item.name === "font-face") writeFontFace(item, writer, context)
  const scopedFrom = writer.mark()
  if (mode === "scope") {
    writer.at("scope")
    writer.space()
    writer.punct("(")
    writer.delim(".")
    writer.ident(MESSAGE_SCOPE)
    writer.punct(")")
    writer.punct("{")
  }
  const rulesFrom = writer.mark()
  writeRules(
    items.filter((item) => item.kind !== "at" || (!KEYFRAMES.has(item.name) && item.name !== "font-face")),
    writer,
    context
  )
  if (policy.messageClass && policy.fonts.size)
    writeRules(
      items.filter((item) => item.kind !== "at" || (!KEYFRAMES.has(item.name) && item.name !== "font-face")),
      writer,
      { policy, mode, declarations: "fonts" }
    )
  if (mode === "scope") {
    if (writer.mark() === rulesFrom) writer.reset(scopedFrom)
    else writer.punct("}")
  }
  const text = writer.text()
  if (text === null) return { css: "", blocked: policy.remote }
  return { css: text, blocked: policy.remote, media: writer.out.flatMap((token) => token.media ?? []) }
}

/** A CSS value's text from its own writer, checked; null when anything in it is refused. */
function valueText(values: ReadonlyArray<ComponentValue>, policy: Policy, options: ValueOptions): string | null {
  const writer = new Writer()
  if (!writeValue(trim(values), writer, policy, options)) return null
  return writer.text()
}

/** React's style object name for a property (as style-to-js's React mode names them). */
const styleName = (property: string) =>
  property.startsWith("--")
    ? property
    : property.replace(/^-ms-/, "ms-").replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())

/**
 * A style attribute as React's style object: each kept declaration a property and a checked
 * value, set by the browser one property at a time, so no value can add a declaration. Nothing
 * parses the attribute's text again. `!important` can't be set this way and is left off.
 */
export function cleanStyle(
  style: string,
  mediaScope?: string | null
): { readonly style: Readonly<Record<string, string>> | null; readonly blocked: boolean } {
  const values = parse(style)
  if (values === null) return { style: null, blocked: false }
  const policy: Policy = {
    mediaScope,
    remote: false,
    fontBytes: 0,
    fontExpanded: 0,
    keyframes: new Set(),
    fonts: new Set()
  }
  const kept: Record<string, string> = {}
  for (const item of blockItems(values)) {
    if (item.kind !== "decl") continue
    const name = item.name.startsWith("--") ? item.name : item.name.toLowerCase()
    if (item.raw !== item.name || !PROPERTY.test(item.name) || REFUSED_PROPERTIES.has(name)) continue
    const text = valueText(item.value, policy, { functions: VALUE_FUNCTIONS, urls: true })
    if (text === null) policy.remote ||= mentionsRemote(item.value)
    else kept[styleName(name)] = text
  }
  return { style: Object.keys(kept).length ? kept : null, blocked: policy.remote }
}

/**
 * An SVG presentation attribute the browser reads as a CSS value (`fill`, `filter`, `mask`, …):
 * the same value policy, with url() only to the message's own `#` elements, renamed as its ids.
 */
export function cleanPresentation(value: string): string | null {
  const values = parse(value)
  if (values === null) return null
  const policy: Policy = {
    mediaScope: null,
    remote: false,
    fontBytes: 0,
    fontExpanded: 0,
    keyframes: new Set(),
    fonts: new Set()
  }
  return valueText(values, policy, { functions: VALUE_FUNCTIONS, urls: true, fragmentsOnly: true })
}
