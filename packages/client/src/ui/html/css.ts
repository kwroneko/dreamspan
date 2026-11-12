import { proxyMediaUrl } from "./media.ts"
// A message's `<style>` as CSS for the chat's constructed stylesheet (spec/HTML-MESSAGES.md §3.2,
// as ST's decodeStyleTags): every selector under the message-body scope, classes and ids renamed
// as the markup's are, `@import` and other global at-rules dropped, and declarations that would
// load something from elsewhere dropped while external media is blocked; approved simple url() values use the authenticated media proxy.
import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from "postcss"

/** The class every message body carries, which the card's styles are scoped to. */
export const MESSAGE_SCOPE = "message-html"
/** At most this much CSS from one message is kept; past it, the rest is left out. */
const MAX_MESSAGE_CSS = 200_000

/** Font Awesome's, ST's note and monospace classes keep their names, as in ST. */
export const renameClass = (name: string) =>
  name.startsWith("fa-") || name.startsWith("note-") || name === "monospace" ? name : `custom-${name}`
/** Ids and names in parsed HTML, so they can't clobber the app's own or its globals (fix 3). */
const ID_PREFIX = "user-content-"
export const renameId = (name: string) => `${ID_PREFIX}${name}`

/** Rename the classes and ids a selector names; strings and attribute selectors stay as written. */
export function renameSelector(selector: string): string {
  let out = ""
  let i = 0
  const ident = /^(?:\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F]|[-\w]|[^\x00-\x7F])+/
  while (i < selector.length) {
    const char = selector[i]!
    if (char === "\\") {
      out += selector.slice(i, i + 2)
      i += 2
    } else if (char === '"' || char === "'") {
      const end = closingQuote(selector, i)
      out += selector.slice(i, end)
      i = end
    } else if (char === "[") {
      let end = i + 1
      while (end < selector.length && selector[end] !== "]") {
        end = selector[end] === '"' || selector[end] === "'" ? closingQuote(selector, end) : end + 1
      }
      out += selector.slice(i, end + 1)
      i = end + 1
    } else if ((char === "." || char === "#") && ident.test(selector.slice(i + 1))) {
      const name = ident.exec(selector.slice(i + 1))![0]
      out += char === "." ? `.${renameClass(name)}` : `#${renameId(name)}`
      i += 1 + name.length
    } else {
      out += char
      i++
    }
  }
  return out
}
function closingQuote(text: string, start: number) {
  const quote = text[start]
  let i = start + 1
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1
  return i + 1
}

/** CSS escapes decoded and comments gone, so an escape or a comment can't hide a function name. */
function plain(value: string, lowercase = true) {
  const decoded = value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => {
      const point = Number.parseInt(hex, 16)
      return String.fromCodePoint(
        point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point
      )
    })
    .replace(/\\(.)/g, "$1")
  return lowercase ? decoded.toLowerCase() : decoded
}
/** What a value refers to: url() arguments, image-set strings and src() functions. */
const URL_FUNCTION = /(?:url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g
/**
 * Whether a declaration's value would load something: any url() or src() but `data:` and
 * in-document `#` references, a quoted image-set() entry, or an absolute address at all (ST's
 * `://` rule). `remote` says whether it named another site, which the message's note reports.
 */
export function loads(value: string): { readonly loads: boolean; readonly remote: boolean } {
  const text = plain(value)
  const remote = text.includes("//")
  let loads = remote
  for (const match of text.matchAll(URL_FUNCTION)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (!target.startsWith("data:") && !target.startsWith("#")) loads = true
  }
  // image-set() takes plain strings as addresses too.
  if (/image-set\([^)]*["']/.test(text)) loads = true
  if (/expression\(|-moz-binding/.test(text)) loads = true
  return { loads, remote }
}
/** In-document references (an SVG gradient's `url(#g)`) follow the ids' prefix. */
export const renameReferences = (value: string) =>
  value.replace(
    /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/gi,
    (_, quote: string, id: string) => `url(${quote}#${renameId(id)}${quote})`
  )

/** Rewrite only simple url() values. Other loading constructs retain the blocking policy. */
function mediaValue(value: string, scope?: string | null) {
  if (!scope) return { value, ...loads(value) }
  const proxies: string[] = []
  const decoded = plain(value, false)
  const masked = decoded.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (whole, a: string, b: string, c: string) => {
      const proxy = proxyMediaUrl((a ?? b ?? c ?? "").trim(), scope)
      if (!proxy) return whole
      const index = proxies.push(proxy) - 1
      return `url("data:rp-media-${index}")`
    }
  )
  const result = loads(masked)
  return {
    ...result,
    value: masked.replace(/url\("data:rp-media-(\d+)"\)/g, (whole, index: string) =>
      proxies[Number(index)] === undefined ? whole : `url("${proxies[Number(index)]}")`
    )
  }
}

/**
 * A `style` attribute without the declarations that would load something, its `url(#id)`
 * references renamed. Split as the browser reads it: at semicolons outside strings and brackets.
 */
export function cleanStyle(
  style: string,
  mediaScope?: string | null
): { readonly style: string; readonly blocked: boolean } {
  const declarations: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i <= style.length; i++) {
    const char = style[i]
    if (char === "\\") i++
    else if (quote) quote = char === quote ? null : quote
    else if (char === '"' || char === "'") quote = char
    else if (char === "(") depth++
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if ((char === ";" && depth === 0) || char === undefined) {
      declarations.push(style.slice(start, i))
      start = i + 1
    }
  }
  let blocked = false
  const kept = declarations.flatMap((declaration) => {
    if (!declaration.trim()) return []
    const result = mediaValue(declaration, mediaScope)
    blocked ||= result.remote
    return result.loads ? [] : [renameReferences(result.value.trim())]
  })
  return { style: kept.join("; "), blocked }
}

/** Names the stylesheet defines globally (keyframes, fonts) get the class prefix too. */
const renameNames = (value: string, names: ReadonlySet<string>) =>
  names.size === 0
    ? value
    : value.replace(/(["']?)(-?[_a-zA-Z][-\w]*)\1/g, (whole, quote: string, name: string) =>
        names.has(name) ? `${quote}${renameClass(name)}${quote}` : whole
      )

/** At-rules whose content is scoped as the rest: their own conditions are left as written. */
const GROUPING = new Set(["media", "supports", "container", "starting-style", "document", "-moz-document"])

export interface ScopedCss {
  readonly css: string
  /** Something from another site was left out: the message says so. */
  readonly blocked: boolean
}

/** Each of a message's `<style>`s scoped on its own, so one that doesn't parse leaves the others. */
export function scopeStyles(styles: ReadonlyArray<string>, mediaScope?: string | null): ScopedCss {
  const scoped = styles.map((css) => scopeCss(css, undefined, mediaScope))
  return {
    css: scoped
      .map((one) => one.css)
      .filter((css) => css.trim() !== "")
      .join("\n"),
    blocked: scoped.some((one) => one.blocked)
  }
}

/** A message's CSS under `.message-html`; unparsable CSS is left out whole, as nothing applies. */
export function scopeCss(css: string, scope = `.${MESSAGE_SCOPE}`, mediaScope?: string | null): ScopedCss {
  let root
  try {
    root = postcss.parse(css.slice(0, MAX_MESSAGE_CSS))
  } catch {
    return { css: "", blocked: false }
  }
  let blocked = false
  const keyframes = new Set<string>()
  const fonts = new Set<string>()
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase()
    if (/^(?:-\w+-)?keyframes$/.test(name)) keyframes.add(rule.params.trim())
    if (name === "font-face")
      rule.walkDecls(/^font-family$/i, (decl) => {
        fonts.add(decl.value.trim().replace(/^(["'])(.*)\1$/, "$2"))
      })
  })
  const declaration = (decl: Declaration) => {
    const { loads: loading, remote, value } = mediaValue(decl.value, mediaScope)
    if (loading) {
      blocked ||= remote
      decl.remove()
      return
    }
    decl.value = renameReferences(value)
    const property = decl.prop.toLowerCase()
    if (property === "animation" || property === "animation-name") decl.value = renameNames(decl.value, keyframes)
    if (property === "font" || property === "font-family") decl.value = renameNames(decl.value, fonts)
  }
  const visit = (container: Container, nested: boolean) => {
    for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
      if (node.type === "decl") declaration(node)
      else if (node.type === "rule") {
        const rule = node as Rule
        const selectors = rule.selectors.filter((selector) => {
          const text = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim()
          // Prefixing a relative sibling selector would target siblings of the message.
          if (!nested) return !/^[+~|]/.test(text)
          // Implicit nesting stays below the parent. Explicit nesting is safe only when
          // that parent anchors the selector: :is(&, body) can otherwise select the app.
          // Be conservative about '&' even in strings; no selector parser is involved.
          return !text.includes("&") || (text.startsWith("&") && !text.slice(1).includes("&"))
        })
        if (selectors.length === 0) {
          rule.remove()
          continue
        }
        rule.selectors = selectors.map((selector) =>
          nested ? renameSelector(selector) : `${scope} ${renameSelector(selector)}`
        )
        visit(rule, true)
      } else if (node.type === "atrule") atRule(node, nested)
      else if (node.type === "comment") node.remove()
    }
  }
  const atRule = (rule: AtRule, nested: boolean) => {
    const name = rule.name.toLowerCase()
    if (GROUPING.has(name) && rule.nodes) visit(rule, nested)
    else if (name === "layer" && rule.nodes) {
      // Unlayered, as the card wrote it for a page without layers.
      visit(rule, nested)
      rule.replaceWith(rule.nodes)
    } else if (/^(?:-\w+-)?keyframes$/.test(name) && !nested) {
      rule.params = renameClass(rule.params.trim())
      rule.walkDecls(declaration)
    } else if (name === "font-face" && !nested) {
      const descriptors = (rule.nodes ?? []).filter((node): node is Declaration => node.type === "decl")
      const families = descriptors.filter((decl) => decl.prop.toLowerCase() === "font-family")
      // renameNames handles simple CSS identifiers only. An escaped or multiword family
      // would otherwise remain global and could redefine a font used by the app.
      if (
        families.length === 0 ||
        descriptors.some((decl) => decl.prop.includes("\\")) ||
        families.some((decl) => !/^(["']?)-?[_a-zA-Z][-\w]*\1$/.test(decl.value.trim()))
      ) {
        rule.remove()
        return
      }
      rule.walkDecls((decl) => {
        if (decl.prop.toLowerCase() === "font-family") decl.value = renameNames(decl.value, fonts)
        else declaration(decl)
      })
      if (!rule.some((node) => node.type === "decl" && node.prop.toLowerCase() === "src")) rule.remove()
    }
    // @import, @namespace, @property, @counter-style, @page, @font-feature-values and the
    // rest reach outside the message or load something.
    else rule.remove()
  }
  visit(root, false)
  return { css: root.toString(), blocked }
}
