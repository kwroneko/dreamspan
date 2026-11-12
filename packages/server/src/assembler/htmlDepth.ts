// "HTML in older messages sent to the model" (spec/HTML-MESSAGES.md §3.6): an older message's
// context form, computed per request from its text after the prompt scripts, never stored.
// "Text only" removes HTML tags and keeps their text; "Leave out panels" also drops document
// blocks whole. Code that isn't a document stays as written, and so do tags that aren't HTML's
// (a model's own `<status>` markers, reply sections): only the elements HTML defines go.
import { decodeHTML } from "entities"
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5"
import type { HtmlDepth } from "@rp/shared/state.ts"

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
/** Elements whose content isn't text: they go with it. */
const DROPPED = /<(script|style|template|noscript|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
const HAS_DROPPED = new RegExp(DROPPED.source, "i")
/** Elements that end a line: their end becomes a line break. */
const BLOCKS = new Set(
  "address article aside blockquote details dialog div dl dt dd fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tr ul".split(
    " "
  )
)
const TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g
const hasMarkup = (text: string) => {
  for (const match of text.matchAll(TAG)) if (ELEMENTS.has(match[1]!.toLowerCase())) return true
  return /<!--|<!doctype\b/i.test(text)
}

/** `text` without HTML's tags: their text stays, line ends where blocks ended, entities decoded. */
const textOnly = (text: string) => {
  if (!hasMarkup(text) && !HAS_DROPPED.test(text)) return text
  const stripped = withoutNonText(text, false)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<!doctype\b[^>]*>/gi, "")
    .replace(DROPPED, "")
    .replace(TAG, (tag, name: string) => {
      const element = name.toLowerCase()
      if (!ELEMENTS.has(element)) return tag
      if (element === "br") return "\n"
      if (tag.startsWith("</") && BLOCKS.has(element)) return "\n"
      if (tag.startsWith("</") && (element === "td" || element === "th")) return " "
      return ""
    })

  return decodeHTML(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

const FENCE = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/gm
const INLINE_CODE = /(`+)[^`\n][\s\S]*?\1/g

/** Remove complete non-text elements before Markdown spans can split their bodies.
 * Source offsets keep unknown markers and prose byte-for-byte; parse5 handles nested
 * templates, quoted attributes and raw-text elements as the browser does. */
const withoutNonText = (text: string, protectCode = true) => {
  if (!/<(?:script|style|template|noscript|head)\b|<!--/i.test(text)) return text
  const spans = protectCode ? [...text.matchAll(INLINE_CODE)] : []
  const protectedAt = (at: number) => spans.some((span) => span.index <= at && at < span.index + span[0].length)
  const ranges: Array<{ startOffset: number; endOffset: number }> = []
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    const location = node.sourceCodeLocation
    if (
      location &&
      !protectedAt(location.startOffset) &&
      (node.nodeName === "#comment" || ["script", "style", "template", "noscript", "head"].includes(node.nodeName))
    ) {
      ranges.push(location)
      return
    }
    if ("childNodes" in node) node.childNodes.forEach(visit)
  }
  visit(parseFragment(text, { sourceCodeLocationInfo: true }))
  // The fragment parser ignores head tags outside a document; their content still
  // isn't visible prose. Match those spans before protecting inline Markdown.
  for (const match of text.matchAll(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi))
    if (!protectedAt(match.index)) ranges.push({ startOffset: match.index, endOffset: match.index + match[0].length })
  let out = ""
  let at = 0
  for (const range of ranges.sort((a, b) => a.startOffset - b.startOffset)) {
    if (range.startOffset >= at) out += text.slice(at, range.startOffset)
    at = Math.max(at, range.endOffset)
  }
  return out + text.slice(at)
}

/** Prose's HTML reduced to text, leaving inline code as written. */
const prose = (source: string) => {
  const text = withoutNonText(source)
  let out = ""
  let at = 0
  for (const match of text.matchAll(INLINE_CODE)) {
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
  if (!text.includes("<")) return text
  let out = ""
  let at = 0
  for (const match of text.matchAll(FENCE)) {
    out += prose(text.slice(at, match.index))
    const code = match[4] ?? ""
    out += isDocument(code) ? (mode === "panels" ? "" : textOnly(code)) : match[0]
    at = match.index + match[0].length
  }
  out += prose(text.slice(at))
  return out === text ? text : out.replace(/\n{3,}/g, "\n\n").trim()
}
