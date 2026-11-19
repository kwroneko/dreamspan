// "HTML in older messages sent to the model" (spec/HTML-MESSAGES.md §3.6): an older message's
// context form, computed per request from its text after the prompt scripts, never stored.
// "Text only" removes HTML tags and keeps their text; "Leave out panels" also drops document
// blocks whole. Code that isn't a document stays as written, and so do tags that aren't HTML's
// (a model's own `<status>` markers, reply sections): only the elements HTML defines go.
// HTML is read by parse5's tokenizer, the one the client's renderer (rehype-raw) uses, with
// the tree builder's raw-text switches, so tags, attributes, comments, character references and
// textarea/script bodies split where the browser splits them. Markdown's code spans and fences
// are found as before. Output is a pure function of the text: same history, same bytes.
import { Tokenizer, TokenizerMode, type Token } from "parse5"
import type { HtmlDepth } from "@dreamspan/shared/state.ts"

/** Tavern Helper's test (`is_frontend.ts`), as the client's renderer has it (ui/html/parts.ts). */
const isDocument = (code: string) => ["html>", "<head>", "<body"].some((tag) => code.includes(tag))

/** HTML's elements: a tag with another name isn't markup to remove. */
const ELEMENTS = new Set(
  (
    "a abbr address area article aside audio b bdi bdo big blink blockquote body br button canvas caption " +
    "center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em fieldset " +
    "figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i img input ins kbd " +
    "label legend li link main map mark marquee menu meta meter nav nobr ol optgroup option output p " +
    "picture pre progress q rp rt ruby s samp section select small source span strike strong sub summary " +
    "sup table tbody td tfoot th thead time tr track tt u ul var video wbr svg path circle rect line " +
    "polyline polygon ellipse g text tspan defs use symbol title " +
    "acronym applet bgsound content embed frame frameset iframe keygen listing menuitem multicol " +
    "nextid noembed noframes object param plaintext rb rtc search shadow slot spacer textarea xmp " +
    "math maction maligngroup malignmark menclose merror mfenced mfrac mglyph mi mlabeledtr mlongdiv " +
    "mmultiscripts mn mo mover mpadded mphantom mroot mrow ms mscarries mscarry msgroup msline mspace " +
    "msqrt msrow mstack mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics " +
    "annotation annotation-xml animate animatemotion animatetransform clippath desc discard feblend " +
    "fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap " +
    "fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage femerge " +
    "femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence " +
    "filter foreignobject lineargradient marker mask metadata mpath pattern radialgradient set stop " +
    "switch textpath view"
  ).split(" ")
)
/** Elements whose content isn't text: they go with it, through the end when unfinished. */
const NON_TEXT = new Set(["script", "style", "template", "noscript", "head"])
/** Elements that end a line: their end becomes a line break. */
const BLOCKS = new Set(
  "address article aside blockquote details dialog div dl dt dd fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tr ul".split(
    " "
  )
)
/** The tree builder's tokenizer switches (HTML §13.2.6.4.7), outside SVG and MathML. */
const RAW_TEXT = new Map<string, Tokenizer["state"]>([
  ["textarea", TokenizerMode.RCDATA],
  ["title", TokenizerMode.RCDATA],
  ["style", TokenizerMode.RAWTEXT],
  ["xmp", TokenizerMode.RAWTEXT],
  ["iframe", TokenizerMode.RAWTEXT],
  ["noembed", TokenizerMode.RAWTEXT],
  ["noframes", TokenizerMode.RAWTEXT],
  // Scripting is on in the reader's browser, so its content is raw text there too.
  ["noscript", TokenizerMode.RAWTEXT],
  ["script", TokenizerMode.SCRIPT_DATA],
  ["plaintext", TokenizerMode.PLAINTEXT]
])

type Piece =
  /** `chars` as HTML decodes them there (references in text and RCDATA, none in raw text). */
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly chars: string }
  | { readonly kind: "start" | "end"; readonly start: number; readonly end: number; readonly name: string }
  | { readonly kind: "other"; readonly start: number; readonly end: number }

/**
 * A `<` that Markdown shows as text (it isn't raw HTML there) but that HTML's tokenizer would
 * open a bogus comment with (or drop, `</>`), hiding text up to the next `>`: `</` without a tag name (`</3`),
 * `<?` with no `?>` after it, `<!` without a letter, `--` or CDATA, or with no `>` after it.
 */
const LITERAL_OPENING = /<(?=\/(?![A-Za-z])|\?|!(?!--|\[CDATA\[))/g
const MARKS = ["", "", "", "", "﷐", "﷑"]
const withLiteralOpenings = (source: string) => {
  const mark = MARKS.find((candidate) => !source.includes(candidate))
  if (mark === undefined) return { masked: source, unmask: (chars: string) => chars }
  const lastInstruction = source.lastIndexOf("?>")
  const lastClose = source.lastIndexOf(">")
  const masked = source.replace(LITERAL_OPENING, (lt, at: number) => {
    const next = source[at + 1]
    if (next === "?") return lastInstruction > at ? lt : mark
    if (next === "!") return /[A-Za-z]/.test(source[at + 2] ?? "") && lastClose > at ? lt : mark
    return mark
  })
  return { masked, unmask: (chars: string) => chars.replaceAll(mark, "<") }
}

/** `source` as HTML tokenizes it. Bytes no token covers (a tag cut off by the end) are left out. */
const tokenize = (source: string): ReadonlyArray<Piece> => {
  const pieces: Piece[] = []
  const { masked, unmask } = withLiteralOpenings(source)
  let foreign = 0
  const span = (token: { readonly location: Token.Location | null }) => ({
    start: token.location!.startOffset,
    end: token.location!.endOffset
  })
  const text = (token: Token.CharacterToken) =>
    pieces.push({ kind: "text", ...span(token), chars: unmask(token.chars) })
  const tokenizer: Tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onCharacter: text,
      onWhitespaceCharacter: text,
      // The tree builder drops NULs in body text.
      onNullCharacter: (token) => pieces.push({ kind: "text", ...span(token), chars: "" }),
      onComment: (token) => pieces.push({ kind: "other", ...span(token) }),
      onDoctype: (token) => pieces.push({ kind: "other", ...span(token) }),
      onStartTag: (token) => {
        pieces.push({ kind: "start", ...span(token), name: token.tagName })
        if (token.tagName === "svg" || token.tagName === "math") foreign += token.selfClosing ? 0 : 1
        else if (foreign === 0) {
          const state = RAW_TEXT.get(token.tagName)
          if (state !== undefined) tokenizer.state = state
        }
        tokenizer.inForeignNode = foreign > 0
      },
      onEndTag: (token) => {
        pieces.push({ kind: "end", ...span(token), name: token.tagName })
        if ((token.tagName === "svg" || token.tagName === "math") && foreign > 0) foreign--
        tokenizer.inForeignNode = foreign > 0
      },
      onEof: () => {}
    }
  )
  tokenizer.write(masked, true)
  return pieces
}

const isMarkup = (piece: Piece) =>
  piece.kind === "other" || (piece.kind !== "text" && (ELEMENTS.has(piece.name) || NON_TEXT.has(piece.name)))

/** Where the non-text element starting at `pieces[i]` ends: its matching end tag, or the end. */
const nonTextEnd = (pieces: ReadonlyArray<Piece>, i: number, sourceEnd: number) => {
  const first = pieces[i]!
  if (first.kind !== "start") return first.end
  let depth = 0
  for (let j = i; j < pieces.length; j++) {
    const piece = pieces[j]!
    if (piece.kind === "start" && piece.name === first.name) depth++
    else if (piece.kind === "end" && piece.name === first.name && --depth === 0) return piece.end
  }
  return sourceEnd
}
const startsNonText = (piece: Piece) => piece.kind === "other" || (piece.kind === "start" && NON_TEXT.has(piece.name))

/** `text` without HTML's tags: their text stays, line ends where blocks ended, references decoded. */
const textOnly = (text: string) => {
  const pieces = tokenize(text)
  if (!pieces.some(isMarkup)) return text
  let out = ""
  let at = 0
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    if (piece.start < at) continue
    // What no token covers (a tag cut off at the end) is text to Markdown, as written.
    out += text.slice(at, piece.start)
    at = piece.end
    if (startsNonText(piece)) {
      at = nonTextEnd(pieces, i, text.length)
      continue
    }
    if (piece.kind === "text") out += piece.chars
    else if (piece.kind === "other") continue
    else if (!ELEMENTS.has(piece.name)) out += text.slice(piece.start, piece.end)
    else if (piece.name === "br") out += "\n"
    else if (piece.kind === "end" && BLOCKS.has(piece.name)) out += "\n"
    else if (piece.kind === "end" && (piece.name === "td" || piece.name === "th")) out += " "
  }
  out += text.slice(at)
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

/** Pair equal-length backtick runs once. The former backreference regex tried every
 * suffix of a long unmatched run, taking cubic time on a single adversarial message. */
const inlineCode = (text: string) => {
  const runs = [...text.matchAll(/`+/g)]
  const next = new Map<number, number>()
  const pairs: Array<number | undefined> = new Array(runs.length)
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i]![0].length
    pairs[i] = next.get(length)
    next.set(length, i)
  }
  const spans: Array<{ readonly index: number; readonly 0: string }> = []
  for (let i = 0; i < runs.length; i++) {
    const closing = pairs[i]
    if (closing === undefined) continue
    const start = runs[i]!.index
    const end = runs[closing]!.index + runs[closing]![0].length
    spans.push({ index: start, 0: text.slice(start, end) })
    i = closing
  }
  return spans
}

/** Scan fenced blocks by lines, without variable-length regex backreferences. */
const fencedBlocks = (text: string) => {
  const lines = text.split("\n")
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const blocks: Array<{ readonly index: number; readonly 0: string; readonly 4: string }> = []
  for (let i = 0; i < lines.length - 1; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!)
    if (!open) continue
    let closing = i + 1
    for (; closing < lines.length; closing++) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[closing]!)
      if (close && close[1]![0] === open[1]![0] && close[1]!.length >= open[1]!.length) break
    }
    const start = offsets[i]!
    const end = closing < lines.length ? offsets[closing]! + lines[closing]!.length : text.length
    const contentEnd = closing < lines.length ? offsets[closing]! - 1 : text.length
    blocks.push({
      index: start,
      0: text.slice(start, end),
      4: text.slice(offsets[i + 1]!, Math.max(offsets[i + 1]!, contentEnd))
    })
    i = closing
  }
  return blocks
}

/** Remove complete non-text elements and comments before Markdown spans can split their bodies.
 * Inline code is protected, so a literal example in backticks stays; prose and unknown markers
 * stay byte-for-byte. */
const withoutNonText = (text: string) => {
  if (!/<(?:script|style|template|noscript|head)|<!/i.test(text)) return text
  const spans = inlineCode(text)
  let spanIndex = 0
  const protectedAt = (at: number) => {
    while (spanIndex < spans.length && spans[spanIndex]!.index + spans[spanIndex]![0].length <= at) spanIndex++
    const span = spans[spanIndex]
    return span !== undefined && span.index <= at
  }
  const pieces = tokenize(text)
  let out = ""
  let at = 0
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!
    if (piece.start < at || !startsNonText(piece) || protectedAt(piece.start)) continue
    out += text.slice(at, piece.start)
    at = nonTextEnd(pieces, i, text.length)
  }
  return out + text.slice(at)
}

/** Prose's HTML reduced to text, leaving inline code as written. */
const prose = (source: string) => {
  const text = withoutNonText(source)
  let out = ""
  let at = 0
  for (const match of inlineCode(text)) {
    out += textOnly(text.slice(at, match.index))
    out += match[0]
    at = match.index + match[0].length
  }
  return out + textOnly(text.slice(at))
}

/**
 * The context form of a message's text for `mode` ("text" or "panels"): document blocks reduced
 * to their text, or dropped whole for "panels"; other code kept; prose's HTML reduced to text.
 * Text without HTML comes back unchanged, so its cache stays.
 */
export const htmlDepthForm = (text: string, mode: Exclude<HtmlDepth["mode"], "as_written">) => {
  // Bounded reduction work. Larger messages retain their inspectable as-written form;
  // never truncate a message or cut a token in half.
  if (text.length > 200_000 || !text.includes("<")) return text
  let out = ""
  let at = 0
  for (const match of fencedBlocks(text)) {
    out += prose(text.slice(at, match.index))
    const code = match[4] ?? ""
    out += isDocument(code) ? (mode === "panels" ? "" : textOnly(code)) : match[0]
    at = match.index + match[0].length
  }
  out += prose(text.slice(at))
  return out === text ? text : out.replace(/\n{3,}/g, "\n\n").trim()
}
