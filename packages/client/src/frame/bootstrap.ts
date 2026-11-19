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

function render(html: string, vh: number, theme: Theme, data?: Tavern, port?: MessagePort) {
  const parsed = parse(html)
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
