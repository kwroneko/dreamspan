// PDFs in the viewer (spec/FILES-AND-ENVIRONMENT.md §8.2): pdf.js (`pdfjs-dist`, exact-pinned),
// loaded only when a PDF opens, with its worker from the app's own origin. Pages are drawn on
// canvases as they come near the screen; nothing in the PDF runs (no scripting, no forms, no
// annotation layer, so no links), and no WebAssembly is needed under the app's CSP. On wide
// screens a column of page thumbnails jumps to a page.
import { useEffect, useRef, useState } from "react"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { ViewerProps } from "./viewers.tsx"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** pdf.js and its worker, fetched the first time a PDF opens. */
const loadPdfJs = async () => {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

export function PdfViewer({ url, name }: ViewerProps) {
  const [doc, setDoc] = useState<{ for: string; pdf: PDFDocumentProxy } | { for: string; error: string } | null>(null)
  useEffect(() => {
    let live = true
    let task: { destroy: () => Promise<void> } | null = null
    loadPdfJs()
      .then((pdfjs) => {
        if (!live) throw new Error("closed")
        const loading = pdfjs.getDocument({
          url,
          enableXfa: false,
          useWasm: false,
          isOffscreenCanvasSupported: false,
          withCredentials: true
        })
        task = loading
        return loading.promise
      })
      .then(
        (pdf) => live && setDoc({ for: url, pdf }),
        (error: unknown) => live && setDoc({ for: url, error: message(error) })
      )
    return () => {
      live = false
      // Ends the worker's work on it, and the requests still loading its bytes.
      void task?.destroy()
    }
  }, [url])
  const shown = doc?.for === url ? doc : null
  if (shown === null)
    return (
      <p role="status" className="text-sm text-muted">
        Loading {name}…
      </p>
    )
  if ("error" in shown)
    return (
      <p role="alert" className="text-sm text-danger">
        {name} couldn’t be opened: {shown.error}
      </p>
    )
  return <Pages pdf={shown.pdf} name={name} />
}

function Pages({ pdf, name }: { pdf: PDFDocumentProxy; name: string }) {
  const pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1)
  const scroller = useRef<HTMLDivElement>(null)
  const show = (n: number) =>
    scroller.current?.querySelector(`[data-pdf-page="${n}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })
  return (
    <div className="@container flex min-w-0 flex-col gap-2" data-file-pdf="">
      <p className="text-xs text-muted">{pdf.numPages === 1 ? "1 page" : `${pdf.numPages.toLocaleString()} pages`}</p>
      <div className="flex min-w-0 gap-3">
        <nav
          aria-label={`Pages of ${name}`}
          className="hidden max-h-[75vh] w-32 shrink-0 flex-col gap-2 overflow-y-auto p-2 @3xl:flex"
        >
          {pages.map((n) => (
            <Tooltip key={n} label={`Shows page ${n}.`}>
              <button
                type="button"
                aria-label={`Page ${n}`}
                onClick={() => show(n)}
                className="flex flex-col items-center gap-1 rounded-md p-1 text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
              >
                <PageCanvas pdf={pdf} number={n} width={80} label={`Page ${n}, small`} />
                <span>{n}</span>
              </button>
            </Tooltip>
          ))}
        </nav>
        <div
          ref={scroller}
          className="flex max-h-[75vh] min-w-0 grow flex-col items-center gap-3 overflow-auto rounded-md border border-border bg-canvas p-2"
        >
          {pages.map((n) => (
            <div key={n} data-pdf-page={n} className="w-full max-w-3xl">
              <PageCanvas pdf={pdf} number={n} label={`Page ${n} of ${pdf.numPages}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** One page, drawn when it comes near the screen, at the width it has (or `width` CSS pixels). */
function PageCanvas({
  pdf,
  number,
  width,
  label
}: {
  pdf: PDFDocumentProxy
  number: number
  width?: number
  label: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    const element = canvas.current!
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: "800px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!near) return
    let cancelled = false
    let task: { cancel: () => void } | null = null
    void pdf
      .getPage(number)
      .then(async (page) => {
        if (cancelled) return
        const element = canvas.current!
        const cssWidth = width ?? Math.max(200, element.parentElement?.clientWidth ?? 600)
        const natural = page.getViewport({ scale: 1 })
        const ratio = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: (cssWidth / natural.width) * ratio })
        element.width = Math.floor(viewport.width)
        element.height = Math.floor(viewport.height)
        element.style.width = `${cssWidth}px`
        element.style.aspectRatio = `${viewport.width} / ${viewport.height}`
        const render = page.render({ canvas: element, viewport })
        task = render
        await render.promise
      })
      .catch((error: unknown) => {
        if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException"))
          setFailed(message(error))
      })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, pdf, number, width])
  return (
    <>
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        className="mx-auto block max-w-full bg-surface shadow-sm"
        style={width ? { width: `${width}px`, aspectRatio: "1 / 1.414" } : { aspectRatio: "1 / 1.414" }}
      />
      {failed && (
        <p role="alert" className="text-xs text-danger">
          Page {number} couldn’t be shown: {failed}
        </p>
      )}
    </>
  )
}
