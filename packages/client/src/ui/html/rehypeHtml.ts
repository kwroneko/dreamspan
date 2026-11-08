// The inline-HTML pipeline around rehype-raw (spec/HTML-MESSAGES.md §3.2), as rehype plugins for
// StMarkdown: mark Markdown's own elements, parse the raw HTML, prepare it, sanitize it with the
// registered schema, then finish what the five fixes need on the parsed elements only. Media
// from elsewhere is taken out, and a marker element tells the renderer to say so.
import rehypeSanitize from "rehype-sanitize"
import type { PositionedNode } from "../sourcePositions.ts"
import { sliceText } from "../sourcePositions.ts"
import { cleanStyle, renameClass, renameId, renameReferences } from "./css.ts"
import { effectiveClassifier, effectiveDocumentRenderer, effectiveSchema, htmlPartsRevision } from "./parts.ts"

interface Node extends PositionedNode {
  children?: Node[]
  data?: PositionedNode["data"] & { html?: boolean }
}

/**
 * The trusted attribute on Markdown's own elements, random per page load, so markup in a
 * message can't claim it. It's a hast property (`data-rp…` as an attribute) because
 * rehype-raw rebuilds every element from its attributes, and `data` doesn't survive it.
 */
const MARK = `dataRp${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => String.fromCharCode(97 + (byte % 26))).join("")}`

/** The element that tells the renderer media was left out (HtmlParts.tsx). */
export const MEDIA_MARKER = "rp-media-blocked"
/** The element a document block becomes (HtmlParts.tsx renders it with the frame renderer). */
export const FRAME_ELEMENT = "rp-frame"

const elements = (node: Node) => (node.children ?? []).filter((child) => child.type === "element")
const textOf = (node: Node): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("")

/** Step 1, before rehype-raw: Markdown's elements get the mark. */
export function htmlMark() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.type === "element") node.properties = { ...node.properties, [MARK]: "" }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}

/**
 * Step 2, after rehype-raw: `<style>` goes (StMarkdown takes the CSS from the text, as ST does),
 * forms become `div`s (fix 2), and line breaks inside tags the schema doesn't know become `<br>`
 * before the tag goes and its text stays, as ST does (`<Status>` on its lines).
 */
export function htmlPrepare(_options: { parts: number }) {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value)
    const schema = effectiveSchema()?.schema(MARK)
    const known = new Set(schema?.tagNames ?? [])
    const stripped = new Set(schema?.strip ?? [])
    // The HTML parser can leave a position without its ends; the copy mapping needs both.
    const positions = (node: Node) => {
      const position = node.position as Partial<NonNullable<Node["position"]>> | undefined
      if (position && (position.start?.offset === undefined || position.end?.offset === undefined)) delete node.position
      for (const child of node.children ?? []) positions(child)
    }
    positions(tree)
    const visit = (node: Node) => {
      if (!node.children) return
      const children: Node[] = []
      for (const child of node.children) {
        if (child.type !== "element" || MARK in (child.properties ?? {})) {
          children.push(child)
          visit(child)
          continue
        }
        const name = child.tagName!.toLowerCase()
        if (name === "style") continue
        if (name === "form") child.tagName = "div"
        else if (!known.has(child.tagName!) && !stripped.has(name)) breakLines(child, source)
        children.push(child)
        visit(child)
      }
      node.children = children
    }
    visit(tree)
  }
}
function breakLines(node: Node, source: string) {
  const children = node.children ?? []
  node.children = children.flatMap((child, index): Node[] => {
    const value = child.value ?? ""
    if (child.type !== "text" || !value.includes("\n")) return [child]
    const parts: Node[] = []
    // Markdown's own line break is a `<br>` and then the newline: that newline is already a break.
    const after = children[index - 1]?.tagName === "br" && value.startsWith("\n")
    if (after) parts.push(sliceText(child, 0, 1, source) as Node)
    let from = after ? 1 : 0
    for (let at = value.indexOf("\n", from); at >= 0; at = value.indexOf("\n", from)) {
      if (at > from) parts.push(sliceText(child, from, at, source) as Node)
      const newline = sliceText(child, at, at + 1, source)
      parts.push({
        type: "element",
        tagName: "br",
        properties: {},
        children: [],
        ...(newline.position ? { position: newline.position } : {})
      })
      from = at + 1
    }
    if (from < value.length) parts.push(sliceText(child, from, value.length, source) as Node)
    return parts
  })
}

/** Step 3: the registered schema (schema.ts), one sanitizer per registry revision. */
let sanitizer: { revision: number; transform: (tree: Node) => Node } | null = null
export function htmlSanitize(_options: { parts: number }) {
  return (tree: Node) => {
    const revision = htmlPartsRevision()
    if (sanitizer?.revision !== revision) {
      const schema = effectiveSchema()?.schema(MARK)
      sanitizer = { revision, transform: rehypeSanitize(schema) as unknown as (tree: Node) => Node }
    }
    return sanitizer.transform(tree)
  }
}

/** DOMPurify's checks on attribute values (`_isValidAttribute`), for every attribute it doesn't trust by name. */
const URI_SAFE = new Set([
  "alt",
  "className",
  "htmlFor",
  "id",
  "label",
  "name",
  "pattern",
  "placeholder",
  "role",
  "summary",
  "title",
  "value",
  "style",
  "xmlns"
])
const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
// DOMPurify's ATTR_WHITESPACE
const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g

/**
 * An address as the browser's URL parser reads it: without the controls and spaces at its ends
 * and the tabs and line breaks inside, so `" #root"` and `"#ro\not"` are fragments too.
 */
export const urlAddress = (value: string) =>
  value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
const DATA_URI_TAGS = new Set(["audio", "video", "img", "source", "image", "track"])

/** Attributes that name other elements by id, which follow the ids' prefix (fix 3). */
const ID_LISTS = [
  "htmlFor",
  "list",
  "headers",
  "ariaActiveDescendant",
  "ariaControls",
  "ariaDescribedBy",
  "ariaDetails",
  "ariaErrorMessage",
  "ariaFlowTo",
  "ariaLabelledBy",
  "ariaOwns"
]
/** SVG presentation attributes that can refer to a gradient, filter or marker by `url(#id)`. */
const REFERENCES = ["fill", "stroke", "filter", "clipPath", "mask", "markerStart", "markerMid", "markerEnd"]
const REMOTE = /^\s*(?:https?:)?\/\//i
const MEDIA = new Set(["audio", "video", "source", "track"])

/**
 * Step 4, after sanitizing: Markdown's elements lose their mark, and a code block the classifier
 * calls a document becomes a frame; parsed elements get the custom- class prefix, the ids' prefix
 * and links to them, DOMPurify's value checks, and lose whatever would load from elsewhere.
 */
export function htmlFinish(options: { parts: number; block: number }) {
  return (tree: Node) => {
    const classifier = effectiveClassifier()
    const frames = classifier && effectiveDocumentRenderer() ? classifier : undefined
    let blocked = false
    let documents = 0
    const visit = (node: Node) => {
      if (!node.children) return
      const children: Node[] = []
      for (const child of node.children) {
        if (child.type !== "element") {
          children.push(child)
          continue
        }
        const properties = child.properties ?? {}
        if (MARK in properties) {
          delete properties[MARK]
          const code = child.tagName === "pre" ? elements(child).find((inner) => inner.tagName === "code") : undefined
          if (code && frames) {
            const text = textOf(code)
            const classes = (code.properties?.className as string[] | undefined) ?? []
            const language = classes.find((name) => name.startsWith("language-"))?.slice(9) ?? ""
            if (frames.isDocument(text, language)) {
              children.push({
                type: "element",
                tagName: FRAME_ELEMENT,
                properties: { source: text, index: documents++, block: options.block },
                children: [],
                ...(child.position ? { position: child.position } : {})
              })
              continue
            }
          }
        } else {
          const name = child.tagName!.toLowerCase()
          if (MEDIA.has(name)) {
            blocked ||= ["src", "srcSet", "poster"].some((key) => REMOTE.test(String(properties[key] ?? "")))
            blocked ||= elements(child).some((inner) => REMOTE.test(String(inner.properties?.src ?? "")))
            continue
          }
          blocked = finishParsed(child, name) || blocked
        }
        children.push(child)
        visit(child)
      }
      node.children = children
    }
    visit(tree)
    if (blocked) tree.children = [...(tree.children ?? []), { type: "element", tagName: MEDIA_MARKER, children: [] }]
  }
}

/** One parsed element's attributes; true when something from another site was taken out. */
function finishParsed(node: Node, name: string): boolean {
  const properties = node.properties ?? {}
  let blocked = false
  node.data = { ...node.data, html: true }
  for (const [key, value] of Object.entries(properties)) {
    if (URI_SAFE.has(key) || /^(?:data|aria)[A-Z]/.test(key) || typeof value === "boolean" || typeof value === "number")
      continue
    const text = (Array.isArray(value) ? value.join(" ") : String(value)).replace(ATTR_WHITESPACE, "")
    const dataUri =
      ["src", "xLinkHref", "href", "srcSet"].includes(key) && text.startsWith("data:") && DATA_URI_TAGS.has(name)
    if (!ALLOWED_URI.test(text) && !dataUri) delete properties[key]
  }
  if (Array.isArray(properties.className))
    properties.className = properties.className.map((c) => renameClass(String(c)))
  for (const key of ["id", "name"])
    if (typeof properties[key] === "string" && properties[key] !== "") properties[key] = renameId(properties[key])
  for (const key of ID_LISTS) {
    const value = properties[key]
    if (Array.isArray(value)) properties[key] = value.map((id) => renameId(String(id)))
    else if (typeof value === "string" && value !== "") properties[key] = value.split(/\s+/).map(renameId).join(" ")
  }
  delete properties.form
  for (const key of ["href", "xLinkHref", "useMap"]) {
    const value = properties[key]
    const address = typeof value === "string" ? urlAddress(value) : ""
    if (address.startsWith("#") && address.length > 1) properties[key] = `#${renameId(address.slice(1))}`
  }
  for (const key of REFERENCES)
    if (typeof properties[key] === "string") properties[key] = renameReferences(properties[key])
  if (typeof properties.style === "string") {
    const cleaned = cleanStyle(properties.style)
    blocked ||= cleaned.blocked
    if (cleaned.style) properties.style = cleaned.style
    else delete properties.style
  }
  // Images: `data:` loads (it makes no request); harden captions the rest as blocked.
  if (name === "img") {
    blocked ||= REMOTE.test(String(properties.src ?? ""))
    const set = properties.srcSet
    const entries = Array.isArray(set) ? set.map(String) : typeof set === "string" ? [set] : []
    if (entries.some((entry) => !entry.trim().startsWith("data:"))) {
      blocked ||= entries.some((entry) => REMOTE.test(entry))
      delete properties.srcSet
    }
  }
  if (name === "image" || name === "feimage") {
    for (const key of ["href", "xLinkHref"]) {
      const value = String(properties[key] ?? "")
      if (value && !value.startsWith("#") && !value.startsWith("data:")) {
        blocked ||= REMOTE.test(value)
        delete properties[key]
      }
    }
  }
  if (name === "input" && typeof properties.src === "string" && !properties.src.startsWith("data:")) {
    blocked ||= REMOTE.test(properties.src)
    delete properties.src
  }
  if (typeof properties.background === "string") {
    blocked ||= REMOTE.test(properties.background)
    delete properties.background
  }
  return blocked
}
