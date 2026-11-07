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
// keeps `vh` to the chat column's height through `--rp-vh`, takes the theme's colours as CSS
// variables, reports the document's height as it changes, and turns a click on an `http(s)`
// link into a request to open it in a new tab (the bridge, ui/html/bridge.ts). `rp.copy(text)`
// asks the app to copy text, on a click.

interface Theme {
  readonly text: string
  readonly background: string
  readonly accent: string
  readonly scheme: "light" | "dark"
}
type Incoming =
  | { readonly type: "rp:render"; readonly html: string; readonly vh: number; readonly theme: Theme }
  | { readonly type: "rp:theme"; readonly theme: Theme }
  | { readonly type: "rp:vh"; readonly vh: number }

const host = window.parent
const hostOrigin = new URL(location.href).origin
const scripts = new URLSearchParams(location.search).has("scripts")
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

/** `50vh` as `calc(var(--rp-vh) * 50)`: the frame's own viewport is only as tall as its content. */
const viewportUnits = (css: string) =>
  css.replace(/(-?(?:\d+\.?\d*|\.\d+))(?:d|s|l)?vh\b/gi, (_, amount: string) => `calc(var(--rp-vh) * ${amount})`)

/** The block as a document: no base or refresh, and `vh` in the chat column's terms. */
function parse(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const removed = scripts ? "base, meta[http-equiv]" : "script, base, meta[http-equiv], noscript"
  for (const element of parsed.querySelectorAll(removed)) element.remove()
  for (const style of parsed.querySelectorAll("style")) style.textContent = viewportUnits(style.textContent)
  for (const element of parsed.querySelectorAll<HTMLElement>("[style]"))
    element.setAttribute("style", viewportUnits(element.getAttribute("style") ?? ""))
  return parsed
}

function render(html: string, vh: number, theme: Theme) {
  const parsed = parse(html)
  if (scripts) {
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
    document.write(`<!doctype html>${parsed.documentElement.outerHTML}`)
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
  host.postMessage({ type: "rp:height", height }, hostOrigin)
}

function setTheme(theme: Theme, element: HTMLElement = document.documentElement) {
  const root = element.style
  root.setProperty("--rp-text", theme.text)
  root.setProperty("--rp-background", theme.background)
  root.setProperty("--rp-accent", theme.accent)
  root.setProperty("color-scheme", theme.scheme)
}
const setViewport = (vh: number, element: HTMLElement = document.documentElement) =>
  element.style.setProperty("--rp-vh", `${vh / 100}px`)

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
  if (event.type !== "click") return
  const href = (link.getAttribute("href") ?? link.getAttributeNS(XLINK, "href") ?? "").trim()
  if (/^https?:\/\//i.test(href)) host.postMessage({ type: "rp:open", url: href }, hostOrigin)
}

function onMessage(event: MessageEvent<Incoming>) {
  if (event.source !== host || event.origin !== hostOrigin || typeof event.data !== "object" || event.data === null)
    return
  const message = event.data
  if (message.type === "rp:render" && !rendered && typeof message.html === "string") {
    rendered = true
    render(message.html, message.vh, message.theme)
  } else if (message.type === "rp:theme" && rendered) setTheme(message.theme)
  else if (message.type === "rp:vh" && rendered) setViewport(message.vh)
}

/** The panel's helpers: copying needs the user's click, which the app checks. */
const helpers = {
  copy: (text: unknown) => host.postMessage({ type: "rp:copy", text: String(text) }, hostOrigin)
}

function listen() {
  addEventListener("message", onMessage)
  document.addEventListener("click", onClick, true)
  document.addEventListener("auxclick", onClick, true)
  Object.assign(window, { rp: helpers })
}

listen()
host.postMessage({ type: "rp:ready" }, hostOrigin)

// A module, so its names stay its own (it has no imports or exports when built).
export {}
