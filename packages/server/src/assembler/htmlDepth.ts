// "HTML in older messages sent to the model" (spec/HTML-MESSAGES.md §3.6): an older message's
// context form, computed per request from its text after the prompt scripts, never stored.
// "Text only" removes HTML tags and keeps their text; "Leave out panels" also drops document
// blocks whole. Code that isn't a document stays as written, and so do tags that aren't HTML's
// (a model's own `<status>` markers, reply sections): only the elements HTML defines go.
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
    "polyline polygon ellipse g text tspan defs use symbol title"
  ).split(" ")
)
/** Elements whose content isn't text: they go with it. */
const DROPPED = /<(script|style|template|noscript|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const HAS_DROPPED = new RegExp(DROPPED.source, "i")
/** Elements that end a line: their end becomes a line break. */
const BLOCKS = new Set(
  "address article aside blockquote details dialog div dl dt dd fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tr ul".split(
    " "
  )
)
const TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", amp: "&" }

/** A numeric reference's character: zero, a surrogate or past Unicode is U+FFFD, as HTML reads it. */
const codePoint = (code: number) =>
  code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || !Number.isFinite(code)
    ? "\uFFFD"
    : String.fromCodePoint(code)

const hasMarkup = (text: string) => {
  for (const match of text.matchAll(TAG)) if (ELEMENTS.has(match[1]!.toLowerCase())) return true
  return /<!--/.test(text)
}

/** `text` without HTML's tags: their text stays, line ends where blocks ended, entities decoded. */
const textOnly = (text: string) => {
  if (!hasMarkup(text) && !HAS_DROPPED.test(text)) return text
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(DROPPED, "")
    .replace(TAG, (tag, name: string) => {
      const element = name.toLowerCase()
      if (!ELEMENTS.has(element)) return tag
      if (element === "br") return "\n"
      if (tag.startsWith("</") && BLOCKS.has(element)) return "\n"
      if (tag.startsWith("</") && (element === "td" || element === "th")) return " "
      return ""
    })
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return codePoint(Number.parseInt(name.slice(2), 16))
      if (name.startsWith("#")) return codePoint(Number(name.slice(1)))
      return ENTITIES[name.toLowerCase()] ?? entity
    })
  return stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

const FENCE = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/gm
const INLINE_CODE = /(`+)[^`\n][\s\S]*?\1/g

/** Prose's HTML reduced to text, leaving inline code as written. */
const prose = (text: string) => {
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
