// The media a library document names (spec/SAVED-MEDIA.md §3.1): only places that load
// something, read as the client's renderer reads them: HTML by parse5's tokenizer (rehype-raw's),
// CSS by @csstools' tokenizer (the client's scoper's), Markdown images by their syntax. Every
// string of the document is looked at, whatever its field. Pure and bounded: it runs in a
// reader worker.
import { tokenize, TokenType, type CSSToken } from "@csstools/css-tokenizer"
import { mediaKey, type MediaKind } from "@rp/shared/savedMedia.ts"
import { Tokenizer, TokenizerMode, type Token } from "parse5"

export interface FoundMedia {
  readonly url: string
  readonly kind: MediaKind
}

/** At most this many addresses per revision; more are reported as one refusal. */
export const MAX_MEDIA_PER_REVISION = 200
/** Strings longer than this aren't read (a card is capped at 8 MiB as a whole). */
const MAX_STRING = 2_000_000

const RAW_TEXT = new Map<string, Tokenizer["state"]>([
  ["textarea", TokenizerMode.RCDATA],
  ["title", TokenizerMode.RCDATA],
  ["style", TokenizerMode.RAWTEXT],
  ["xmp", TokenizerMode.RAWTEXT],
  ["iframe", TokenizerMode.RAWTEXT],
  ["noembed", TokenizerMode.RAWTEXT],
  ["noframes", TokenizerMode.RAWTEXT],
  ["noscript", TokenizerMode.RAWTEXT],
  ["script", TokenizerMode.SCRIPT_DATA],
  ["plaintext", TokenizerMode.PLAINTEXT]
])

/** CSS `url()` addresses, with fonts inside `@font-face`. */
export function cssMedia(css: string, add: (raw: string, kind: MediaKind) => void) {
  let tokens: CSSToken[]
  try {
    tokens = tokenize({ css })
  } catch {
    return
  }
  let fontFaceNext = false
  let fontDepth = -1
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const kind: MediaKind = fontDepth >= 0 ? "font" : "image"
    switch (token[0]) {
      case TokenType.AtKeyword:
        fontFaceNext = token[4].value.toLowerCase() === "font-face"
        break
      case TokenType.OpenCurly:
        depth++
        if (fontFaceNext && fontDepth < 0) fontDepth = depth
        fontFaceNext = false
        break
      case TokenType.CloseCurly:
        if (depth === fontDepth) fontDepth = -1
        depth = Math.max(0, depth - 1)
        break
      case TokenType.Semicolon:
        fontFaceNext = false
        break
      case TokenType.URL:
        add(token[4].value, kind)
        break
      case TokenType.Function:
        if (token[4].value.toLowerCase() === "url") {
          let j = i + 1
          while (tokens[j]?.[0] === TokenType.Whitespace) j++
          const argument = tokens[j]
          if (argument?.[0] === TokenType.String) add(argument[4].value, kind)
        }
        break
    }
  }
}

/** HTML media attributes, `<style>` contents and `style` attributes. */
export function htmlMedia(html: string, add: (raw: string, kind: MediaKind) => void) {
  let foreign = 0
  let style: string[] | null = null
  const players: Array<"audio" | "video"> = []
  const attribute = (token: Token.TagToken, name: string) =>
    token.attrs.find((attr) => attr.name.toLowerCase() === name)?.value
  const tokenizer: Tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: false },
    {
      onCharacter: (token) => style?.push(token.chars),
      onWhitespaceCharacter: (token) => style?.push(token.chars),
      onNullCharacter: () => {},
      onComment: () => {},
      onDoctype: () => {},
      onStartTag: (token) => {
        const name = token.tagName
        const styleValue = attribute(token, "style")
        if (styleValue) cssMedia(styleValue, add)
        const background = attribute(token, "background")
        if (background) add(background, "image")
        if (name === "img" || name === "input") {
          const src = attribute(token, "src")
          if (src) add(src, "image")
        }
        if (name === "img" || name === "source") {
          const set = attribute(token, "srcset")
          if (set)
            for (const entry of set.split(",")) {
              const address = entry.trim().split(/\s+/)[0]
              if (address) add(address, name === "img" ? "image" : (players.at(-1) ?? "image"))
            }
        }
        if (name === "audio" || name === "video") {
          const src = attribute(token, "src")
          if (src) add(src, name)
          const poster = attribute(token, "poster")
          if (poster && name === "video") add(poster, "image")
          if (!token.selfClosing) players.push(name)
        }
        if (name === "source" || name === "track") {
          const src = attribute(token, "src")
          if (src && name === "source") add(src, players.at(-1) ?? "audio")
        }
        if (name === "image" || name === "feimage") {
          const href = attribute(token, "href") ?? attribute(token, "xlink:href")
          if (href) add(href, "image")
        }
        if (name === "svg" || name === "math") foreign += token.selfClosing ? 0 : 1
        else if (foreign === 0) {
          const state = RAW_TEXT.get(name)
          if (state !== undefined) tokenizer.state = state
          if (name === "style") style = []
        }
        tokenizer.inForeignNode = foreign > 0
      },
      onEndTag: (token) => {
        if (token.tagName === "style" && style) {
          cssMedia(style.join(""), add)
          style = null
        }
        if ((token.tagName === "audio" || token.tagName === "video") && players.at(-1) === token.tagName) players.pop()
        if ((token.tagName === "svg" || token.tagName === "math") && foreign > 0) foreign--
        tokenizer.inForeignNode = foreign > 0
      },
      onEof: () => {
        if (style) cssMedia(style.join(""), add)
        style = null
      }
    }
  )
  tokenizer.write(html, true)
}

/** `![alt](address "title")` and `![alt](<address>)`, as CommonMark reads an inline image. */
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^<>\n]+)>|([^\s()<>]+))/g

/** The media one text names. */
export function textMedia(text: string, add: (raw: string, kind: MediaKind) => void) {
  if (text.length > MAX_STRING || !/(?:https?:)?\/\//i.test(text)) return
  if (text.includes("<")) htmlMedia(text, add)
  if (text.includes("![")) for (const match of text.matchAll(MARKDOWN_IMAGE)) add(match[1] ?? match[2]!, "image")
}

/**
 * Every media address a document names, once each, in the order found, as `mediaKey` forms
 * them. `over` is how many more there were past the limit.
 */
export function documentMedia(doc: unknown): { readonly media: ReadonlyArray<FoundMedia>; readonly over: number } {
  const found = new Map<string, MediaKind>()
  let over = 0
  const add = (raw: string, kind: MediaKind) => {
    const url = mediaKey(raw)
    if (url === null || found.has(url)) return
    if (found.size >= MAX_MEDIA_PER_REVISION) over++
    else found.set(url, kind)
  }
  const stack: unknown[] = [doc]
  while (stack.length) {
    const value = stack.pop()
    if (typeof value === "string") textMedia(value, add)
    else if (Array.isArray(value)) for (let i = value.length - 1; i >= 0; i--) stack.push(value[i])
    else if (value !== null && typeof value === "object") {
      const values = Object.values(value)
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i])
    }
  }
  return { media: [...found].map(([url, kind]) => ({ url, kind })), over }
}
