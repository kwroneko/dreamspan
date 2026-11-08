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

/** "This panel has scripts": the button that lets its source's scripts run. */
function ScriptsStrip({ ask }: { ask: NonNullable<PanelPermit["ask"]> }) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const allow = async () => {
    setPending(true)
    setFailed(false)
    const ok = await ask.allow()
    setPending(false)
    setFailed(!ok)
  }
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>{failed ? "This panel has scripts. They couldn't be allowed." : "This panel has scripts."}</span>
      <Button
        className="max-w-full"
        pending={pending}
        hint={`Lets panels from ${ask.name} run their scripts, in every chat. They can't reach your account, your chats or other sites.`}
        onClick={() => void allow()}
      >
        <span className="truncate">Run scripts from {ask.name}</span>
      </Button>
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
      if (data.type === "rp:ready") {
        if (delivered.current.has(target)) return
        delivered.current.set(target, data.token)
        post({ type: "rp:render", html: source, vh: columnHeight(frame.current), theme: theme() })
      } else if (data.type === "rp:height") {
        const next = Math.max(0, Math.min(Math.ceil(data.height), window.innerHeight * 2))
        slots.heights.set(id, next)
        setHeight(next)
      } else if (data.type === "rp:open") {
        const link = bridgeLink(data.url)
        if (link !== null && data.token === delivered.current.get(target) && clicked())
          window.open(link, "_blank", "noopener,noreferrer")
      } else if (data.type === "rp:copy" && data.token === delivered.current.get(target) && clicked())
        void copyText(data.text).catch(() => {})
    }
    window.addEventListener("message", onMessage)
    const themeChanged = () => post({ type: "rp:theme", theme: theme() })
    const scheme = window.matchMedia("(prefers-color-scheme: dark)")
    scheme.addEventListener("change", themeChanged)
    const attributes = new MutationObserver(themeChanged)
    attributes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"]
    })
    const resized = () => post({ type: "rp:vh", vh: columnHeight(frame.current) })
    window.addEventListener("resize", resized)
    return () => {
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
