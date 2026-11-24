// The document-block frame's bootstrap (spec/HTML-MESSAGES.md §3.3, §3.4). It runs in a
// sandboxed frame with an opaque origin, built as its own entry (vite.config.ts) and loaded as a
// classic script: a module script's request would carry `Origin: null`, which the server
// refuses. It imports nothing.
//
// The parent (ui/html/DocumentFrame.tsx) posts the block's text once this says it's ready.
// Without `?scripts` in the page's URL, this writes it as the frame's document without its
// scripts (the page's CSP would refuse them too). With it, the panel's source allowed its
// scripts: the page's CSP lets inline scripts and `/frame/lib/` run, and this writes the
// document with the vendored libraries first, as Tavern Helper injects them. Either way it
// keeps `vh` to the chat column's height through `--dreamspan-vh`, takes the theme's colours as CSS
// variables, reports the document's height as it changes, and turns a click on an `http(s)`
// link into a request to open it in a new tab (the bridge, ui/html/bridge.ts). `dreamspan.copy(text)`
// asks the app to copy text, on a click.

interface Theme {
  readonly text: string
  readonly background: string
  readonly accent: string
  readonly scheme: "light" | "dark"
}
/** What a panel's scripts may read (Tier B; shared/panelDataApi.ts `PanelData`). */
interface Tavern {
  readonly messageId: number
  readonly messages: ReadonlyArray<{
    readonly messageId: number
    readonly name: string
    readonly role: "user" | "assistant" | "system"
    readonly hidden: boolean
    readonly message: string
  }>
  readonly chatVariables: Readonly<Record<string, unknown>>
  readonly names: { readonly user: string; readonly char: string }
}
type Incoming =
  | {
      readonly type: "dreamspan:render"
      readonly html: string
      readonly vh: number
      readonly theme: Theme
      readonly tavern?: Tavern
      readonly port?: MessagePort
    }
  | { readonly type: "dreamspan:theme"; readonly theme: Theme }
  | { readonly type: "dreamspan:vh"; readonly vh: number }

const host = window.parent
const hostOrigin = new URL(location.href).origin
// This entry is wrapped in a private scope in development and production (vite.config.ts).
// Save the native methods before panel code can replace globals or activation getters.
const post = host.postMessage.bind(host)
const activation = navigator.userActivation
const locallyActivated = activation
  ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activation), "isActive")?.get?.bind(activation)
  : undefined
const clock = performance.now.bind(performance)
/** When the user last pressed in this frame (a trusted pointer press, never a key). */
let pressedAt = Number.NEGATIVE_INFINITY
/**
 * The bridge's actions need the user's press in this frame, within the few seconds activation
 * lasts. Activation alone isn't enough: a key press gives it too, and a panel can take focus on
 * its own (the app sends it back, but a key typed meanwhile may reach it), and a key press on a
 * link it focused is a trusted click.
 */
const pressed = () => clock() - pressedAt < 5000 && locallyActivated?.() === true
const actionToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
  byte.toString(16).padStart(2, "0")
).join("")
const scripts = new URLSearchParams(location.search).has("scripts")

/*
 * The walls (spec/HTML-MESSAGES.md §3.4 "no network unless the user allows it"). The page's
 * CSP governs fetches, but not WebRTC's STUN and TURN, nor `<link rel=preconnect>` and
 * `dns-prefetch`, and a nested frame is a new realm with constructors of its own. So, before
 * any panel code runs: WebRTC's constructors are gone from this window, for good; no frame can
 * be made in it (a `<iframe>` is made an inert element of no namespace's); and no `<link>`
 * holds a `rel` but `stylesheet` and `alternate`. The HTML that panel code turns into elements
 * passes through the page's default Trusted Types policy (the page's CSP requires one, and no
 * other policy may be made), which takes those out of the text; the DOM calls that make or
 * change elements check the same. Everything the walls call was saved before panel code could
 * replace it, and every value is read once.
 */
const apply = Reflect.apply
const defineProperty = Object.defineProperty
const describe = Object.getOwnPropertyDescriptor
const fromCharCode = String.fromCharCode
const charCodeAt = String.prototype.charCodeAt
const weakSetAdd = WeakSet.prototype.add
const weakSetHas = WeakSet.prototype.has
const weakMapSet = WeakMap.prototype.set
const weakMapGet = WeakMap.prototype.get
const XHTML = "http://www.w3.org/1999/xhtml"
/** Where a frame element is made instead: an element no browser gives a frame. */
const INERT = "urn:dreamspan:inert"
const FRAMES: Readonly<Record<string, true>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, true>, {
    iframe: true,
    frame: true,
    fencedframe: true,
    portal: true
  })
)
const RELS: Readonly<Record<string, true>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, true>, { stylesheet: true, alternate: true })
)

/** ASCII lowercase, without String.prototype. */
function lower(text: string) {
  let out = ""
  for (let index = 0; index < text.length; index++) {
    const code = apply(charCodeAt, text, [index]) as number
    out += code >= 65 && code <= 90 ? fromCharCode(code + 32) : text[index]!
  }
  return out
}
const space = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r"
const alpha = (char: string | undefined) =>
  char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"))
/** The local part of a tag name (`x:link` is `link` in XML), lowercased. */
function localPart(name: string) {
  let start = 0
  for (let index = 0; index < name.length; index++) if (name[index] === ":") start = index + 1
  let out = ""
  for (let index = start; index < name.length; index++) out += name[index]!
  return lower(out)
}
/** A `rel` of only allowed tokens. A character reference counts as anything. */
function relAllowed(value: string) {
  let token = ""
  for (let index = 0; index <= value.length; index++) {
    const char = value[index]
    if (char === undefined || space(char)) {
      if (token !== "" && RELS[lower(token)] !== true) return false
      token = ""
    } else if (char === "&") return false
    else token += char
  }
  return true
}

interface Tag {
  /** Just past the tag's `>`, or -1 when the text ends first. */
  readonly end: number
  readonly name: string
  readonly attributes: ReadonlyArray<readonly [string, string]>
}
/** A start or end tag from `<` at `start`, as the HTML tokenizer reads it, whatever the context. */
function readTag(text: string, start: number): Tag {
  let index = start + 1
  if (text[index] === "/") index++
  let name = ""
  while (index < text.length && !space(text[index]) && text[index] !== "/" && text[index] !== ">")
    name += text[index++]!
  const attributes: Array<readonly [string, string]> = []
  for (;;) {
    while (space(text[index]) || text[index] === "/") index++
    if (index >= text.length) return { end: -1, name, attributes }
    if (text[index] === ">") return { end: index + 1, name, attributes }
    let key = text[index++]!
    while (
      index < text.length &&
      !space(text[index]) &&
      text[index] !== "/" &&
      text[index] !== ">" &&
      text[index] !== "="
    )
      key += text[index++]!
    while (space(text[index])) index++
    let value = ""
    if (text[index] === "=") {
      index++
      while (space(text[index])) index++
      const quote = text[index]
      if (quote === '"' || quote === "'") {
        index++
        while (index < text.length && text[index] !== quote) value += text[index++]!
        if (index >= text.length) return { end: -1, name, attributes }
        index++
      } else while (index < text.length && !space(text[index]) && text[index] !== ">") value += text[index++]!
    }
    attributes[attributes.length] = [lower(key), value]
  }
}
/** Where `text` holds something the walls keep out, from its `<` to past its `>` (or the end). */
function forbidden(text: string): readonly [number, number] | "refuse" | null {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "<") continue
    const next = text[index + 1] === "/" ? text[index + 2] : text[index + 1]
    // An XML entity can spell any element without its tag in the text.
    if (next === "!" && lower(text[index + 2] ?? "") === "e" && lower(text[index + 3] ?? "") === "n") return "refuse"
    if (!alpha(next) || text[index + 1] === "/") continue
    const tag = readTag(text, index)
    const name = localPart(tag.name)
    let bad = FRAMES[name] === true
    if (name === "link" || name === "meta")
      for (let at = 0; at < tag.attributes.length; at++) {
        const pair = tag.attributes[at]!
        const key = pair[0]
        const value = pair[1]
        if (name === "link" ? localPart(key) === "rel" && !relAllowed(value) : localPart(key) === "http-equiv")
          bad = true
      }
    // A link whose tag the text doesn't finish could take a `rel` from what follows it.
    if (name === "link" && tag.end < 0) bad = true
    if (bad) return [index, tag.end < 0 ? text.length : tag.end]
  }
  return null
}
/**
 * Whether `text`, read from data, ends in data: every tag, comment, declaration and CDATA
 * section it opens, it closes. `document.write` text is read on from where the last call
 * stopped, so a call may not stop inside one.
 */
function closed(text: string) {
  let index = 0
  const find = (what: string, from: number) => {
    for (let at = from; at + what.length <= text.length; at++) {
      let same = true
      for (let offset = 0; offset < what.length && same; offset++) same = text[at + offset] === what[offset]
      if (same) return at + what.length
    }
    return -1
  }
  while (index < text.length) {
    if (text[index] !== "<") {
      index++
      continue
    }
    const next = text[index + 1]
    if (next === undefined) return false
    if (next === "!") {
      const end =
        text[index + 2] === "-" && text[index + 3] === "-"
          ? find("-->", index + 4)
          : text[index + 2] === "["
            ? find("]]>", index + 2)
            : find(">", index + 2)
      if (end < 0) return false
      index = end
    } else if (next === "?" || (next === "/" && !alpha(text[index + 2]) && text[index + 2] !== undefined)) {
      const end = find(">", index + 2)
      if (end < 0) return false
      index = end
    } else if (alpha(next) || next === "/") {
      const end = readTag(text, index).end
      if (end < 0) return false
      index = end
    } else index++
  }
  return true
}
/** HTML text without what the walls keep out, or null when it can't be had (a write cut in a tag). */
function wallHtml(text: string, write: boolean): string | null {
  let rest = text
  // Taking a tag out joins what was around it; each pass makes the text shorter.
  for (let pass = 0; pass < 64; pass++) {
    const found = forbidden(rest)
    if (found === "refuse") return null
    if (found === null) return write && !closed(rest) ? null : rest
    let out = ""
    for (let index = 0; index < rest.length; index++) if (index < found[0] || index >= found[1]) out += rest[index]!
    rest = out
  }
  return null
}

type Native = (...args: Array<unknown>) => unknown
/**
 * Saves a prototype's native setter or method and puts the wall's in its place. A wall calls
 * the native through `apply` with arrays it built itself: no spread, no destructuring, as
 * panel code can replace the iterators those use.
 */
function wrapSetter(target: object, key: string, wall: (native: Native) => (this: unknown, value: unknown) => void) {
  const found = describe(target, key)
  if (found?.set === undefined) return
  defineProperty(target, key, {
    ...(found.get === undefined ? {} : { get: found.get }),
    set: wall(found.set as Native),
    configurable: false,
    enumerable: found.enumerable ?? false
  })
}
/** The arguments after the first `from`, as an array of their own (no spread). */
function rest(args: ArrayLike<unknown>, from: number, into: Array<unknown>) {
  for (let index = from; index < args.length; index++) into[into.length] = args[index]
  return into
}
function wrapMethod(
  target: object,
  key: string,
  wall: (native: Native) => (this: unknown, ...args: Array<unknown>) => unknown
) {
  const found = describe(target, key)
  if (typeof found?.value !== "function") return
  defineProperty(target, key, {
    value: wall(found.value as Native),
    writable: false,
    configurable: false,
    enumerable: found.enumerable ?? false
  })
}
const getter = (target: object, key: string) => describe(target, key)?.get

function wallUp() {
  // WebRTC, and XSLT (which makes elements from a stylesheet's text), are gone for good.
  for (const key of Object.getOwnPropertyNames(window)) {
    const start = key.length >= 9 && key[0] === "w" ? 6 : 0
    if ((key[start] === "R" && key[start + 1] === "T" && key[start + 2] === "C") || key === "XSLTProcessor")
      defineProperty(window, key, { value: undefined, writable: false, configurable: false, enumerable: false })
  }

  const localName = getter(Element.prototype, "localName")!
  const namespace = getter(Element.prototype, "namespaceURI")!
  const isLink = (element: unknown) =>
    apply(localName, element, []) === "link" && apply(namespace, element, []) === XHTML
  const attrName = getter(Attr.prototype, "localName")!
  const attrNamespace = getter(Attr.prototype, "namespaceURI")!
  const attrValue = getter(Attr.prototype, "value")!
  const attrOwner = getter(Attr.prototype, "ownerElement")!
  const nodeType = getter(Node.prototype, "nodeType")!
  /** An attribute node that is, or would be, a link's `rel`. */
  const isRel = (attr: unknown) => apply(attrName, attr, []) === "rel" && apply(attrNamespace, attr, []) === null
  const ownerIsLink = (attr: unknown) => {
    const owner = apply(attrOwner, attr, [])
    return owner !== null && isLink(owner)
  }

  // No frame element: `createElement`, `createElementNS`, a document whose root is one, or a
  // custom element built on one.
  const createElementNS = Document.prototype.createElementNS
  wrapMethod(
    Document.prototype,
    "createElement",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const name = `${args[0] as string}`
        if (FRAMES[lower(name)] === true) return apply(createElementNS, this, [INERT, name])
        return apply(native, this, rest(args, 1, [name]))
      }
  )
  wrapMethod(
    Document.prototype,
    "createElementNS",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const space = args[0] === null || args[0] === undefined ? null : `${args[0] as string}`
        const name = `${args[1] as string}`
        const inert = space === XHTML && FRAMES[localPart(name)] === true
        return apply(native, this, rest(args, 2, [inert ? INERT : space, name]))
      }
  )
  wrapMethod(
    DOMImplementation.prototype,
    "createDocument",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const space = args[0] === null || args[0] === undefined ? null : `${args[0] as string}`
        const name = args[1] === null ? null : `${args[1] as string}`
        const inert = space === XHTML && name !== null && FRAMES[localPart(name)] === true
        return apply(native, this, rest(args, 2, [inert ? INERT : space, name]))
      }
  )
  wrapMethod(
    CustomElementRegistry.prototype,
    "define",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const options = args[2] as { readonly extends?: unknown } | null | undefined
        const base = options === null || options === undefined ? undefined : options.extends
        const extend = base === undefined ? undefined : `${base as string}`
        if (extend !== undefined && FRAMES[lower(extend)] === true)
          throw new DOMException("Panels can't have frames.", "NotSupportedError")
        return apply(native, this, extend === undefined ? [args[0], args[1]] : [args[0], args[1], { extends: extend }])
      }
  )

  // A link's `rel`, however it's set.
  wrapSetter(
    HTMLLinkElement.prototype,
    "rel",
    (native) =>
      function (this: unknown, value: unknown) {
        const text = `${value as string}`
        if (relAllowed(text)) apply(native, this, [text])
      }
  )
  const relLists = new WeakSet<object>()
  const relList = describe(HTMLLinkElement.prototype, "relList")
  if (relList?.get !== undefined) {
    const read = relList.get
    const forward = relList.set
    defineProperty(HTMLLinkElement.prototype, "relList", {
      get(this: unknown) {
        const list = apply(read, this, []) as object
        apply(weakSetAdd, relLists, [list])
        return list
      },
      // `link.relList = text` sets its value.
      set(this: unknown, value: unknown) {
        const text = `${value as string}`
        if (forward !== undefined && relAllowed(text)) apply(forward, this, [text])
      },
      configurable: false,
      enumerable: true
    })
  }
  const ofLink = (list: unknown) => apply(weakSetHas, relLists, [list]) === true
  wrapMethod(
    DOMTokenList.prototype,
    "add",
    (native) =>
      function (this: unknown, ...tokens: Array<unknown>) {
        const texts: Array<string> = []
        for (let index = 0; index < tokens.length; index++) texts[index] = `${tokens[index] as string}`
        if (ofLink(this)) for (let index = 0; index < texts.length; index++) if (!relAllowed(texts[index]!)) return
        return apply(native, this, texts)
      }
  )
  wrapMethod(
    DOMTokenList.prototype,
    "toggle",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const token = `${args[0] as string}`
        if (ofLink(this) && !relAllowed(token)) return false
        return apply(native, this, rest(args, 1, [token]))
      }
  )
  wrapMethod(
    DOMTokenList.prototype,
    "replace",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const before = `${args[0] as string}`
        const after = `${args[1] as string}`
        if (ofLink(this) && !relAllowed(after)) return false
        return apply(native, this, [before, after])
      }
  )
  wrapSetter(
    DOMTokenList.prototype,
    "value",
    (native) =>
      function (this: unknown, value: unknown) {
        const text = `${value as string}`
        if (!ofLink(this) || relAllowed(text)) apply(native, this, [text])
      }
  )
  wrapMethod(
    Element.prototype,
    "setAttribute",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const name = `${args[0] as string}`
        const value = `${args[1] as string}`
        if (lower(name) === "rel" && isLink(this) && !relAllowed(value)) return
        return apply(native, this, [name, value])
      }
  )
  wrapMethod(
    Element.prototype,
    "setAttributeNS",
    (native) =>
      function (this: unknown, ...args: Array<unknown>) {
        const space = args[0] === null || args[0] === undefined ? null : `${args[0] as string}`
        const name = `${args[1] as string}`
        const value = `${args[2] as string}`
        if ((space === null || space === "") && name === "rel" && isLink(this) && !relAllowed(value)) return
        return apply(native, this, [space, name, value])
      }
  )
  for (const key of ["setAttributeNode", "setAttributeNodeNS"])
    wrapMethod(
      Element.prototype,
      key,
      (native) =>
        function (this: unknown, attr: unknown) {
          if (isLink(this) && isRel(attr) && !relAllowed(apply(attrValue, attr, []) as string)) return null
          return apply(native, this, [attr])
        }
    )
  const owners = new WeakMap<object, object>()
  const attributes = getter(Element.prototype, "attributes")!
  defineProperty(Element.prototype, "attributes", {
    get(this: unknown) {
      const map = apply(attributes, this, []) as object
      apply(weakMapSet, owners, [map, this])
      return map
    },
    configurable: false,
    enumerable: true
  })
  for (const key of ["setNamedItem", "setNamedItemNS"])
    wrapMethod(
      NamedNodeMap.prototype,
      key,
      (native) =>
        function (this: unknown, attr: unknown) {
          const owner = apply(weakMapGet, owners, [this])
          if (owner !== undefined && isLink(owner) && isRel(attr) && !relAllowed(apply(attrValue, attr, []) as string))
            return null
          return apply(native, this, [attr])
        }
    )
  wrapSetter(
    Attr.prototype,
    "value",
    (native) =>
      function (this: unknown, value: unknown) {
        const text = `${value as string}`
        if (!(isRel(this) && ownerIsLink(this) && !relAllowed(text))) apply(native, this, [text])
      }
  )
  for (const key of ["nodeValue", "textContent"])
    wrapSetter(
      Node.prototype,
      key,
      (native) =>
        function (this: unknown, value: unknown) {
          // An attribute node.
          if (apply(nodeType, this, []) === 2) {
            const text = value === null ? "" : `${value as string}`
            if (isRel(this) && ownerIsLink(this) && !relAllowed(text)) return
            apply(native, this, [text])
          } else apply(native, this, [value])
        }
    )

  // These safe methods don't use Trusted Types. Apply the same wall and let the
  // browser apply its native sanitizer, including any caller-supplied options.
  const safeHtml = (native: Native) =>
    function (this: unknown, ...args: Array<unknown>) {
      if (args.length === 0) return apply(native, this, args)
      const filtered = wallHtml(`${args[0] as string}`, false)
      if (filtered === null) throw new TypeError("That HTML isn't allowed in panels.")
      return apply(native, this, rest(args, 1, [filtered]))
    }
  wrapMethod(Element.prototype, "setHTML", safeHtml)
  wrapMethod(ShadowRoot.prototype, "setHTML", safeHtml)
  wrapMethod(Document, "parseHTML", safeHtml)
}

interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    rules: {
      createHTML?: (value: string, type?: string, sink?: string) => string | null
      createScript?: (value: string) => string
      createScriptURL?: (value: string) => string
    }
  ): { createHTML(value: string): string }
}
/**
 * The page's policies (the CSP names only these two): ours, for the block itself, and the
 * default one every HTML sink of panel code goes through.
 */
const trusted = (window as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes
const own =
  scripts && trusted !== undefined ? trusted.createPolicy("dreamspan", { createHTML: (value) => value }) : undefined
const ownHtml = own === undefined ? undefined : (Object.getPrototypeOf(own).createHTML as (value: string) => string)
/** Text for a sink, as our policy's TrustedHTML where the page requires one. */
const html = (text: string): string => (own === undefined ? text : (apply(ownHtml!, own, [text]) as string))
if (scripts) {
  wallUp()
  trusted?.createPolicy("default", {
    // A frame's own document is a new realm: never.
    createHTML: (value, _type, sink) =>
      sink === "HTMLIFrameElement srcdoc"
        ? null
        : wallHtml(value, sink === "Document write" || sink === "Document writeln"),
    createScript: (value) => value,
    createScriptURL: (value) => value
  })
}

let rendered = false
let reported = -1
let observer: ResizeObserver | null = null

/** The vendored libraries (served from `/frame/lib/`, vite.config.ts), in Tavern Helper's order. */
const LIBRARIES: ReadonlyArray<readonly ["script" | "style", string]> = [
  ["style", "fontawesome/css/all.min.css"],
  ["script", "tailwind.js"],
  ["script", "jquery.min.js"],
  ["script", "jquery-ui.min.js"],
  ["style", "jquery-ui/theme.css"],
  ["script", "jquery.ui.touch-punch.min.js"],
  ["script", "lodash.min.js"],
  ["script", "vue.global.prod.js"],
  ["script", "vue-router.global.prod.js"]
]

/** `50vh` as `calc(var(--dreamspan-vh) * 50)`: the frame's own viewport is only as tall as its content. */
const viewportUnits = (css: string) =>
  css.replace(/(-?(?:\d+\.?\d*|\.\d+))(?:d|s|l)?vh\b/gi, (_, amount: string) => `calc(var(--dreamspan-vh) * ${amount})`)

/** Takes the walls' elements out of a tree, its templates' contents too: frames, `rel`s but stylesheets. */
function strip(root: ParentNode) {
  for (const element of root.querySelectorAll("iframe, frame, fencedframe, portal, link, template")) {
    if (element instanceof HTMLTemplateElement) strip(element.content)
    else if (element.localName !== "link" || !relAllowed(element.getAttribute("rel") ?? "")) element.remove()
  }
}

/** The block as a document: no base or refresh, no frames or hints, and `vh` in the chat column's terms. */
function parse(text: string) {
  const parsed = new DOMParser().parseFromString(html(text), "text/html")
  const removed = scripts ? "base, meta[http-equiv]" : "script, base, meta[http-equiv], noscript"
  for (const element of parsed.querySelectorAll(removed)) element.remove()
  strip(parsed)
  for (const style of parsed.querySelectorAll("style")) style.textContent = viewportUnits(style.textContent)
  for (const element of parsed.querySelectorAll<HTMLElement>("[style]"))
    element.setAttribute("style", viewportUnits(element.getAttribute("style") ?? ""))
  return parsed
}

function render(text: string, vh: number, theme: Theme, data?: Tavern, port?: MessagePort) {
  const parsed = parse(text)
  if (scripts) {
    if (data !== undefined) tavern(data, port)
    // The variables go in with the document: its scripts may read them as it's written.
    setViewport(vh, parsed.documentElement)
    setTheme(theme, parsed.documentElement)
    const libraries = LIBRARIES.map(([kind, path]) => {
      const element = parsed.createElement(kind === "script" ? "script" : "link")
      if (kind === "script") element.setAttribute("src", `/frame/lib/${path}`)
      else {
        element.setAttribute("rel", "stylesheet")
        element.setAttribute("href", `/frame/lib/${path}`)
      }
      return element
    })
    parsed.head.prepend(...libraries)
    // Written, not imported: only a parser runs the block's scripts. Opening the document
    // takes away this window's listeners, so they're added again before its scripts run.
    document.open()
    listen()
    if (data !== undefined) Object.assign(window, tavernApi)
    // Read again from its text, the document may differ from the tree it was written from (an
    // SVG `<style>`'s text is written as it is, and read as markup), so the text is walled too.
    document.write(html(wallHtml(`<!doctype html>${parsed.documentElement.outerHTML}`, false) ?? ""))
    document.close()
    if (document.body) watch()
    else document.addEventListener("DOMContentLoaded", watch, { once: true })
  } else {
    document.documentElement.replaceWith(document.importNode(parsed.documentElement, true))
    setViewport(vh)
    setTheme(theme)
    watch()
  }
}

/** Reports the height as it changes. */
function watch() {
  observer?.disconnect()
  observer = new ResizeObserver(report)
  observer.observe(document.documentElement)
  if (document.body) observer.observe(document.body)
  report()
}

function report() {
  const body = document.body
  if (!body) return
  const style = getComputedStyle(body)
  const height = Math.ceil(
    Math.max(body.scrollHeight, body.getBoundingClientRect().height) +
      (Number.parseFloat(style.marginTop) || 0) +
      (Number.parseFloat(style.marginBottom) || 0)
  )
  if (height === reported) return
  reported = height
  post({ type: "dreamspan:height", height }, hostOrigin)
}

function setTheme(theme: Theme, element: HTMLElement = document.documentElement) {
  const root = element.style
  root.setProperty("--dreamspan-text", theme.text)
  root.setProperty("--dreamspan-background", theme.background)
  root.setProperty("--dreamspan-accent", theme.accent)
  root.setProperty("color-scheme", theme.scheme)
}
const setViewport = (vh: number, element: HTMLElement = document.documentElement) =>
  element.style.setProperty("--dreamspan-vh", `${vh / 100}px`)

const XLINK = "http://www.w3.org/1999/xlink"

/**
 * A link would navigate the frame away from its panel: every HTML and SVG link and image-map
 * area is stopped, on primary and auxiliary clicks, in the capture phase (so a link SVG
 * animation changed counts too). A primary click on an `http(s)` one asks the app to open it.
 */
function onClick(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest("a, area") : null
  if (!link) return
  event.preventDefault()
  if (event.type !== "click" || !event.isTrusted || !pressed()) return
  const href = (link.getAttribute("href") ?? link.getAttributeNS(XLINK, "href") ?? "").trim()
  if (/^https?:\/\//i.test(href)) post({ type: "dreamspan:open", url: href, token: actionToken }, hostOrigin)
}

/**
 * Tier B (spec/HTML-MESSAGES.md §3.4): a read-only subset of Tavern Helper's API, answered from
 * what the app gave this panel, its message and those before it, so it's synchronous as Tavern
 * Helper's is. Nothing here writes. Updates come through `port`, which only the document the
 * block was delivered to holds; each fires `tavern_events.MESSAGE_UPDATED` with this message's id.
 */
let snapshot: Tavern | null = null
const listeners = new Map<string, Array<(...args: Array<unknown>) => unknown>>()
const EVENTS = { MESSAGE_UPDATED: "message_updated" } as const
const copy = <A>(value: A): A => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as A))

function tavern(data: Tavern, port?: MessagePort) {
  snapshot = data
  if (port === undefined) return
  port.onmessage = (event: MessageEvent<{ readonly type?: unknown; readonly tavern?: Tavern }>) => {
    if (event.data?.type !== "dreamspan:data" || typeof event.data.tavern !== "object") return
    snapshot = event.data.tavern
    emit(EVENTS.MESSAGE_UPDATED, snapshot.messageId)
  }
}

function emit(type: string, ...args: Array<unknown>) {
  for (const listener of [...(listeners.get(type) ?? [])]) {
    try {
      void listener(...args)
    } catch (error) {
      setTimeout(() => {
        throw error
      })
    }
  }
}

/** Tavern Helper's message range: `n`, `"n"` or `"a-b"`, negatives counted back from the last. */
function range(input: unknown, last: number): readonly [number, number] | null {
  const clamp = (value: number) => Math.min(Math.max(value < 0 ? last + value + 1 : value, 0), last)
  const text = String(input).trim()
  const one = /^(-?\d+)$/.exec(text)
  if (one) return [clamp(Number(one[1])), clamp(Number(one[1]))]
  const two = /^(-?\d+)-(-?\d+)$/.exec(text)
  if (!two) return null
  const [a, b] = [clamp(Number(two[1])), clamp(Number(two[2]))]
  return a <= b ? [a, b] : [b, a]
}

interface MessageOptions {
  readonly role?: "all" | "system" | "assistant" | "user"
  readonly hide_state?: "all" | "hidden" | "unhidden"
  readonly include_swipes?: boolean
}

const tavernApi = {
  /** This panel's message: the last a panel may see (causal order). */
  getCurrentMessageId: () => snapshot?.messageId ?? 0,
  getLastMessageId: () => snapshot?.messageId ?? 0,
  getChatMessages(input: unknown, { role = "all", hide_state = "all", include_swipes = false }: MessageOptions = {}) {
    if (snapshot === null) return []
    const bounds = range(input, snapshot.messageId)
    if (bounds === null) return []
    return snapshot.messages
      .filter(
        (m) =>
          m.messageId >= bounds[0] &&
          m.messageId <= bounds[1] &&
          (role === "all" || m.role === role) &&
          (hide_state === "all" || (hide_state === "hidden") === m.hidden)
      )
      .map((m) => {
        const base = { message_id: m.messageId, name: m.name, role: m.role, is_hidden: m.hidden }
        // Only the version shown is given: its one swipe.
        return include_swipes
          ? { ...base, swipe_id: 0, swipes: [m.message], swipes_data: [{}], swipes_info: [{}] }
          : { ...base, message: m.message, data: {}, extra: {}, swipe_id: 0, swipes: [m.message], swipes_data: [{}] }
      })
  },
  /** The chat's variables; every other scope reads as empty. */
  getVariables: (option: { readonly type?: string } = { type: "chat" }) =>
    (option?.type ?? "chat") === "chat" ? copy({ ...snapshot?.chatVariables }) : {},
  getAllVariables: () => copy({ ...snapshot?.chatVariables }),
  eventOn(type: string, listener: (...args: Array<unknown>) => unknown) {
    const list = listeners.get(type) ?? []
    if (!list.includes(listener)) list.push(listener)
    listeners.set(type, list)
    return { stop: () => tavernApi.eventRemoveListener(type, listener) }
  },
  eventOnce(type: string, listener: (...args: Array<unknown>) => unknown) {
    const once = (...args: Array<unknown>) => {
      tavernApi.eventRemoveListener(type, once)
      return listener(...args)
    }
    return tavernApi.eventOn(type, once)
  },
  eventRemoveListener(type: string, listener: (...args: Array<unknown>) => unknown) {
    const list = listeners.get(type)
    if (list)
      listeners.set(
        type,
        list.filter((one) => one !== listener)
      )
  },
  tavern_events: EVENTS,
  SillyTavern: { getContext: () => ({ name1: snapshot?.names.user ?? "", name2: snapshot?.names.char ?? "" }) }
}
Object.assign(tavernApi, { TavernHelper: { ...tavernApi } })

function onMessage(event: MessageEvent<Incoming>) {
  if (event.source !== host || event.origin !== hostOrigin || typeof event.data !== "object" || event.data === null)
    return
  const message = event.data
  if (message.type === "dreamspan:render" && !rendered && typeof message.html === "string") {
    rendered = true
    render(message.html, message.vh, message.theme, message.tavern, message.port)
  } else if (message.type === "dreamspan:theme" && rendered) setTheme(message.theme)
  else if (message.type === "dreamspan:vh" && rendered) setViewport(message.vh)
}

/** Only a click in this frame grants its helpers activation; a parent click grants none. */
const helpers = {
  copy: (text: unknown) => {
    if (pressed()) post({ type: "dreamspan:copy", text: String(text), token: actionToken }, hostOrigin)
  }
}

/**
 * The user pressed in this frame: the app lets it keep focus (DocumentFrame.tsx takes focus back
 * from a frame that takes it on its own). Only a trusted press counts, signed like the bridge's
 * actions; a panel that removes this listener (document.open) only loses focus, never gains it.
 * Sent on release too: a touch gives the page its activation only when the finger lifts.
 */
function onPress(event: PointerEvent) {
  if (!event.isTrusted) return
  pressedAt = clock()
  if (event.type === "pointerdown") pressFocus = null
  post({ type: "dreamspan:focus", token: actionToken }, hostOrigin)
}

/**
 * What a press focused here, kept a moment: the app may take focus back before the press's
 * `dreamspan:focus` reaches it (its pointer events wait for its next frame, so on a busy host it can
 * see the focus move before the pointer's arrival) and gives it back once it does. Taking it
 * back blurs the press's field, and the frame gets the focus back without it, so the typing
 * would go nowhere: the frame's focus coming back that soon after the press puts it back there.
 */
let pressFocus: Element | null = null
const PRESS_FOCUS_MS = 2000
function onFocusIn(event: FocusEvent) {
  if (event.isTrusted && clock() - pressedAt < PRESS_FOCUS_MS && event.target instanceof Element)
    pressFocus = event.target
}
function onWindowFocus(event: FocusEvent) {
  if (!event.isTrusted || event.target !== window || clock() - pressedAt >= PRESS_FOCUS_MS) return
  const field = pressFocus
  if (field === null || !field.isConnected || document.activeElement === field) return
  if (document.activeElement !== null && document.activeElement !== document.body) return
  ;(field as HTMLElement).focus?.({ preventScroll: true })
}

function listen() {
  addEventListener("message", onMessage)
  addEventListener("focus", onWindowFocus)
  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("pointerdown", onPress, true)
  document.addEventListener("pointerup", onPress, true)
  document.addEventListener("click", onClick, true)
  document.addEventListener("auxclick", onClick, true)
  Object.assign(window, { dreamspan: helpers })
}

listen()
post({ type: "dreamspan:ready", token: actionToken }, hostOrigin)

// A module, so its names stay its own (it has no imports or exports when built).
export {}
