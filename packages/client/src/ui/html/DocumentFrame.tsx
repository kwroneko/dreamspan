// A document block in a frame (spec/HTML-MESSAGES.md §3.3), the registered `html.frame` renderer.
// The frame loads `/frame/panel` with an opaque origin (sandbox without allow-same-origin) under
// that page's own CSP, which runs only our bootstrap (src/frame/bootstrap.ts): the block's own
// scripts stay off. The block's text goes to it by postMessage, never in the URL; it answers
// with its height. Frames load near the screen, eight at most (frames.ts); an unloaded one keeps
// its height. While its reply streams the block shows "Panel loading"; older than the viewer's
// panel depth, it waits for Run panel.
import { useContext, useEffect, useRef, useState } from "react"
import { Button } from "../Button.tsx"
import { FrameSlots } from "./frames.ts"
import { HtmlChatContext, HtmlMessageContext, HtmlSettingsContext } from "./messageHtml.ts"
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
/** The chat column's height: the frame's `100vh`. */
const columnHeight = (element: Element | null) =>
  element?.closest("[data-testid=messages]")?.clientHeight ?? window.innerHeight

export function DocumentFrame({ index, source, sourceMap }: DocumentBlockProps) {
  const message = useContext(HtmlMessageContext)
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

  // The frame's side of the conversation: only messages from this frame's window count.
  useEffect(() => {
    if (!live) return
    const post = (data: unknown) => frame.current?.contentWindow?.postMessage(data, "*")
    const onMessage = (event: MessageEvent<{ type?: unknown; height?: unknown }>) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (data?.type === "rp:ready")
        post({ type: "rp:render", html: source, vh: columnHeight(frame.current), theme: theme() })
      else if (data?.type === "rp:height" && typeof data.height === "number" && Number.isFinite(data.height)) {
        const next = Math.max(0, Math.min(Math.ceil(data.height), window.innerHeight * 2))
        slots.heights.set(id, next)
        setHeight(next)
      }
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
  }, [live, source, id, slots])

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
  return (
    <div ref={holder} className="my-2">
      {live ? (
        <iframe
          ref={frame}
          src={FRAME_URL}
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
