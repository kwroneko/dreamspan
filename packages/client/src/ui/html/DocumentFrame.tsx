// A document block in a frame (spec/HTML-MESSAGES.md §3.3, §3.4), the registered `html.frame`
// renderer. The frame loads `/frame/panel` with an opaque origin (sandbox without
// allow-same-origin) under that page's own CSP, which runs only our bootstrap
// (src/frame/bootstrap.ts) until the message's sources allowed scripts (`PanelPermit`): then
// `?scripts` (and `&network`) choose a CSP that runs the block's scripts and the vendored
// libraries too. The block's text goes to it by postMessage once, never in the URL; it answers
// through the bridge (bridge.ts): its height, and links and copies after a click in it. Frames
// load near the screen, eight at most (frames.ts); an unloaded one keeps its height. While its
// reply streams the block shows "Panel loading"; older than the viewer's panel depth, it waits
// for Run panel. A block with scripts that don't run says so, with the button that allows them.
import { useContext, useEffect, useRef, useState } from "react"
import { copyText } from "../../copyText.ts"
import { Button } from "../Button.tsx"
import { ConfirmDialog } from "../Dialog.tsx"
import { bridgeLink, parseBridgeMessage } from "./bridge.ts"
import { FrameSlots } from "./frames.ts"
import {
  HtmlChatContext,
  HtmlMessageContext,
  HtmlSettingsContext,
  panelHasScripts,
  type PanelPermit
} from "./messageHtml.ts"
import type { DocumentBlockProps } from "./parts.ts"

/** The page every frame loads (the server's route, packages/server/src/server.ts). */
const FRAME_URL = "/frame/panel"
/** Frames outside any chat view (a preview) share these slots. */
const loose = new FrameSlots()

/** The theme's colours, for the frame's CSS variables. */
function theme() {
  const style = getComputedStyle(document.documentElement)
  return {
    text: style.getPropertyValue("--color-text").trim(),
    background: style.getPropertyValue("--color-surface").trim(),
    accent: style.getPropertyValue("--color-accent").trim(),
    scheme: style.colorScheme.includes("dark") ? "dark" : "light"
  }
}
/** The page a frame loads for what it may run. */
const frameUrl = (permit: PanelPermit | undefined) =>
  permit?.scripts ? `${FRAME_URL}?scripts=1${permit.network ? "&network=1" : ""}` : FRAME_URL

/**
 * The app has a click's activation. It isn't the proof of a click in the frame (the app's own
 * clicks give it too): that is the bootstrap's, which signs its messages with a token only
 * it holds (bootstrap.ts), checked with this.
 */
const clicked = () => navigator.userActivation?.isActive === true

/**
 * Focus: a frame keeps it only after the user pressed in it (its bootstrap's signed `dreamspan:focus`)
 * or tabbed to it. A panel's script can focus its own document at any time, which would take the
 * keys typed in the composer. When the app's window loses focus while the page keeps it
 * (`hasFocus` counts frames), a frame took it, and unless the user chose that frame, focus goes
 * back to the app's element that had it:
 * - at once while the user is typing in the app, or when the frame isn't the one under the
 *   pointer (a press is always over it). Chrome doesn't always make a frame that focuses itself
 *   the app's active element, so which frame took it can't otherwise be relied on;
 * - otherwise after a moment, unless the press's `dreamspan:focus` (posted on `pointerdown`, which comes
 *   before the focus moves) arrives first: sending it back at once would bounce focus on every
 *   press in a panel and lose the first key typed there.
 * Sending it back is late anyway (the frame runs in its own process, and `inert` doesn't stop its
 * own script either), so a key typed in that moment can still reach it. The bridge doesn't count
 * those: its actions need a pointer press in the frame (bootstrap.ts), never a key.
 */
const TYPING_MS = 500
const CONFIRM_MS = 300
const focusGuard = {
  /** The frame the user pressed in or tabbed to. */
  granted: null as HTMLIFrameElement | null,
  previous: null as HTMLElement | null,
  tabbing: false,
  /** When the user last pressed a key in the app. */
  keyAt: Number.NEGATIVE_INFINITY,
  /** The frame under the pointer. */
  hovered: null as HTMLIFrameElement | null,
  /** The app's own window has focus (not a frame in it). */
  windowFocused: true,
  /** A frame under the pointer took focus: its press's `dreamspan:focus` has this long. */
  waiting: null as ReturnType<typeof setTimeout> | null,
  users: 0
}
const onGuardFocusIn = (event: FocusEvent) => {
  if (event.target instanceof HTMLIFrameElement || !(event.target instanceof HTMLElement)) return
  focusGuard.previous = event.target
  focusGuard.granted = null
}
const onGuardKeyDown = (event: KeyboardEvent) => {
  focusGuard.keyAt = performance.now()
  if (event.key !== "Tab") return
  focusGuard.tabbing = true
  setTimeout(() => (focusGuard.tabbing = false), 0)
}
const onGuardPointerOver = (event: PointerEvent) => {
  focusGuard.hovered = event.target instanceof HTMLIFrameElement ? event.target : null
}
/** A frame has focus the user didn't give it (undefined: none has, or the user's has). */
const takenBy = (): Element | null | undefined => {
  // Back in the app's window, or gone from the page (another window or tab): no frame has it.
  if (focusGuard.windowFocused || !document.hasFocus()) return undefined
  const active = document.activeElement
  if (active instanceof HTMLIFrameElement && active === focusGuard.granted) return undefined
  return active
}
const sendBack = (active: Element | null) => {
  if (active instanceof HTMLIFrameElement) active.blur()
  window.focus()
  if (focusGuard.previous?.isConnected) focusGuard.previous.focus({ preventScroll: true })
}
const guardCheck = () => {
  const active = takenBy()
  if (active === undefined) return
  if (active instanceof HTMLIFrameElement && focusGuard.tabbing) {
    focusGuard.granted = active
    return
  }
  const pressing =
    active instanceof HTMLIFrameElement &&
    active === focusGuard.hovered &&
    performance.now() - focusGuard.keyAt > TYPING_MS
  if (!pressing) {
    sendBack(active)
    return
  }
  focusGuard.waiting ??= setTimeout(() => {
    focusGuard.waiting = null
    const still = takenBy()
    if (still !== undefined) sendBack(still)
  }, CONFIRM_MS)
}
const onGuardBlur = () => {
  focusGuard.windowFocused = false
  guardCheck()
  setTimeout(guardCheck, 0)
}
const onGuardFocus = () => {
  focusGuard.windowFocused = true
}
/** Watches focus while any frame is live; returns the release. */
function watchFocus() {
  if (focusGuard.users++ === 0) {
    document.addEventListener("focusin", onGuardFocusIn, true)
    document.addEventListener("keydown", onGuardKeyDown, true)
    document.addEventListener("pointerover", onGuardPointerOver, true)
    window.addEventListener("blur", onGuardBlur)
    window.addEventListener("focus", onGuardFocus)
    focusGuard.windowFocused = document.hasFocus() && !(document.activeElement instanceof HTMLIFrameElement)
  }
  return () => {
    if (--focusGuard.users > 0) return
    document.removeEventListener("focusin", onGuardFocusIn, true)
    document.removeEventListener("keydown", onGuardKeyDown, true)
    document.removeEventListener("pointerover", onGuardPointerOver, true)
    window.removeEventListener("blur", onGuardBlur)
    window.removeEventListener("focus", onGuardFocus)
  }
}

/**
 * "This panel has scripts": the button that lets its source's scripts run. It only asks: the
 * message's own HTML can paint over anything in the message, this button included (a decoy
 * with `pointer-events: none` passes the click through), so the approval is the dialog's,
 * which opens outside the message where its HTML can't reach.
 */
function ScriptsStrip({ ask }: { ask: NonNullable<PanelPermit["ask"]> }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const allow = async () => {
    setPending(true)
    setFailed(false)
    const ok = await ask.allow()
    setPending(false)
    setFailed(!ok)
    if (ok) setOpen(false)
  }
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>{failed ? "This panel has scripts. They couldn't be allowed." : "This panel has scripts."}</span>
      <Button
        className="max-w-full"
        hint={`Asks before letting panels from ${ask.name} run their scripts.`}
        onClick={() => setOpen(true)}
      >
        <span className="truncate">Run scripts from {ask.name}</span>
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Run scripts from ${ask.name}?`}
        description={`Panels from ${ask.name} will run their scripts in every chat. They stay walled off: they can't reach your account, your chats or other sites. You can stop them in its Panels settings.`}
        confirmLabel="Run scripts"
        pending={pending}
        onConfirm={() => void allow()}
      />
    </div>
  )
}

/** The chat column's height: the frame's `100vh`. */
const columnHeight = (element: Element | null) =>
  element?.closest("[data-testid=messages]")?.clientHeight ?? window.innerHeight

export function DocumentFrame({ index, source, sourceMap }: DocumentBlockProps) {
  const message = useContext(HtmlMessageContext)
  const permit = message?.permit
  const src = frameUrl(permit)
  const chat = useContext(HtmlChatContext)
  const { panelDepth } = useContext(HtmlSettingsContext)
  const slots = chat?.frames ?? loose
  const id = `${message?.key ?? "preview"}:${index}`
  const streaming = message?.streaming === true
  const older =
    panelDepth !== null && message?.fromTip !== undefined && message.fromTip !== null && message.fromTip >= panelDepth
  const [run, setRun] = useState(false)
  const collapsed = older && !run
  const [live, setLive] = useState(false)
  const [height, setHeight] = useState<number | null>(() => slots.heights.get(id) ?? null)
  const holder = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  // WindowProxy identity survives navigation. Never redeliver HTML to a new document
  // that took over the frame, even if it replays the bootstrap's ready message. The value
  // is the original bootstrap's private action token, never posted back into the frame.
  const delivered = useRef(new WeakMap<Window, string>())

  // Near the screen, claim a slot; away from it, offer it up.
  useEffect(() => {
    const element = holder.current
    if (!element || streaming || collapsed) return
    let near = false
    const claim = () => {
      if (!near) return
      if (slots.claim(id, () => setLive(false))) setLive(true)
      else slots.wait(id, claim)
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        near = entry?.isIntersecting === true
        if (near) claim()
        else slots.away(id)
      },
      { root: element.closest("[data-testid=messages]"), rootMargin: "50% 0px" }
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      slots.release(id)
      setLive(false)
    }
  }, [id, slots, streaming, collapsed])

  // The frame's side of the conversation: only messages from this frame's window count, and
  // only the bridge's. A frame window gets the block once (`delivered`).
  useEffect(() => {
    if (!live) return
    const post = (data: unknown) => frame.current?.contentWindow?.postMessage(data, "*")
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target || event.origin !== "null") return
      const data = parseBridgeMessage(event.data)
      if (data === null) return
      if (data.type === "dreamspan:ready") {
        if (delivered.current.has(target)) return
        delivered.current.set(target, data.token)
        post({ type: "dreamspan:render", html: source, vh: columnHeight(frame.current), theme: theme() })
      } else if (data.type === "dreamspan:height") {
        const next = Math.max(0, Math.min(Math.ceil(data.height), window.innerHeight * 2))
        slots.heights.set(id, next)
        setHeight(next)
      } else if (data.type === "dreamspan:open") {
        const link = bridgeLink(data.url)
        if (link !== null && data.token === delivered.current.get(target) && clicked())
          window.open(link, "_blank", "noopener,noreferrer")
      } else if (data.type === "dreamspan:copy" && data.token === delivered.current.get(target) && clicked())
        void copyText(data.text).catch(() => {})
      else if (data.type === "dreamspan:focus" && data.token === delivered.current.get(target) && clicked()) {
        // A press in the frame: it may keep the focus it took, or get it back.
        focusGuard.granted = frame.current
        if (document.activeElement !== frame.current) frame.current?.focus({ preventScroll: true })
      }
    }
    const releaseFocus = watchFocus()
    window.addEventListener("message", onMessage)
    const themeChanged = () => post({ type: "dreamspan:theme", theme: theme() })
    const scheme = window.matchMedia("(prefers-color-scheme: dark)")
    scheme.addEventListener("change", themeChanged)
    const attributes = new MutationObserver(themeChanged)
    attributes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"]
    })
    const resized = () => post({ type: "dreamspan:vh", vh: columnHeight(frame.current) })
    window.addEventListener("resize", resized)
    return () => {
      releaseFocus()
      window.removeEventListener("message", onMessage)
      scheme.removeEventListener("change", themeChanged)
      attributes.disconnect()
      window.removeEventListener("resize", resized)
    }
  }, [live, source, src, id, slots])

  // One character stands for the whole block when a selection is copied (sourcePositions.ts).
  const copy = (
    <span className="sr-only" {...(sourceMap === undefined ? {} : { "data-source-map": sourceMap })}>
      {" "}
    </span>
  )
  if (streaming || collapsed)
    return (
      <div className="my-2 flex min-h-12 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">
        <span className="flex-1">{streaming ? "Panel loading" : "Older panel"}</span>
        {!streaming && (
          <Button hint="Runs this older message's panel. Newer panels run on their own." onClick={() => setRun(true)}>
            Run panel
          </Button>
        )}
        {copy}
      </div>
    )
  const ask = !permit?.scripts && permit?.ask && panelHasScripts(source) ? permit.ask : null
  return (
    <div ref={holder} className="my-2">
      {ask && <ScriptsStrip ask={ask} />}
      {live ? (
        <iframe
          // A new frame for new text or permissions: each gets its block once.
          key={`${src}\n${source}`}
          ref={frame}
          src={src}
          sandbox="allow-scripts"
          title="Panel"
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ height: height ?? 150 }}
        />
      ) : (
        <div className="w-full" style={{ height: height ?? 150 }} aria-hidden />
      )}
      {copy}
    </div>
  )
}
