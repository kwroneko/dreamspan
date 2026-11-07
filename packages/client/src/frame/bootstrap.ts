// The document-block frame's bootstrap (spec/HTML-MESSAGES.md §3.3), the only script
// `/frame/panel`'s CSP lets run. It runs in a sandboxed frame with an opaque origin, built as
// its own entry (vite.config.ts) and loaded as a classic script: a module script's request
// would carry `Origin: null`, which the server refuses. It imports nothing.
//
// The parent (ui/html/DocumentFrame.tsx) posts the block's text once this says it's ready;
// this writes it as the frame's document without its scripts (the CSP would refuse them too),
// keeps `vh` to the chat column's height through `--rp-vh`, takes the theme's colours as CSS
// variables, and reports the document's height as it changes.

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
let rendered = false
let reported = -1

/** `50vh` as `calc(var(--rp-vh) * 50)`: the frame's own viewport is only as tall as its content. */
const viewportUnits = (css: string) =>
  css.replace(/(-?(?:\d+\.?\d*|\.\d+))(?:d|s|l)?vh\b/gi, (_, amount: string) => `calc(var(--rp-vh) * ${amount})`)

function render(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  for (const element of parsed.querySelectorAll("script, base, meta[http-equiv], noscript")) element.remove()
  for (const style of parsed.querySelectorAll("style")) style.textContent = viewportUnits(style.textContent)
  for (const element of parsed.querySelectorAll<HTMLElement>("[style]"))
    element.setAttribute("style", viewportUnits(element.getAttribute("style") ?? ""))
  const root = document.importNode(parsed.documentElement, true)
  document.documentElement.replaceWith(root)
  // A link would navigate the frame away from its panel.
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a[href]")) event.preventDefault()
  })
  const observer = new ResizeObserver(report)
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
  host.postMessage({ type: "rp:height", height }, "*")
}

function setTheme(theme: Theme) {
  const root = document.documentElement.style
  root.setProperty("--rp-text", theme.text)
  root.setProperty("--rp-background", theme.background)
  root.setProperty("--rp-accent", theme.accent)
  root.setProperty("color-scheme", theme.scheme)
}
const setViewport = (vh: number) => document.documentElement.style.setProperty("--rp-vh", `${vh / 100}px`)

addEventListener("message", (event: MessageEvent<Incoming>) => {
  if (event.source !== host || typeof event.data !== "object" || event.data === null) return
  const message = event.data
  if (message.type === "rp:render" && !rendered && typeof message.html === "string") {
    rendered = true
    render(message.html)
    setViewport(message.vh)
    setTheme(message.theme)
  } else if (message.type === "rp:theme" && rendered) setTheme(message.theme)
  else if (message.type === "rp:vh" && rendered) setViewport(message.vh)
})
host.postMessage({ type: "rp:ready" }, "*")

// A module, so its names stay its own (it has no imports or exports when built).
export {}
