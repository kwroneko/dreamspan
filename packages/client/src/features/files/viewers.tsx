// What a file opens in (spec/FILES-AND-ENVIRONMENT.md §8.2), by type: a registry, so a plugin can
// add or replace a viewer. Built in: the text editor (text and code, Markdown with its preview,
// CSV and TSV as a table, HTML as source with a sandboxed preview), images, video and audio, and
// PDF. Anything else offers a download. A viewer shows either a file of Files (`path`, which it may
// change unless `readOnly`) or an attachment's copy as sent (`path` null: read-only).
import type { FileView } from "@dreamspan/shared/files.ts"
import { viewOf } from "@dreamspan/shared/files.ts"
import { lazy, Suspense, useState, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import { ImageViewer, type Zoom } from "../../ui/ImageViewer.tsx"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import type { FilesSource } from "./source.ts"
import type { TextMode } from "./TextViewer.tsx"

export interface ViewerProps {
  readonly name: string
  readonly size: number
  /** Where its bytes load from. */
  readonly url: string
  /** Its path in Files, or null for an attachment's copy as sent. */
  readonly path: string | null
  /** The store it's in, for a file of Files. */
  readonly source: FilesSource | null
  /** Shown only: a folder shared as Can view, or a copy as sent. */
  readonly readOnly: boolean
}

interface FileViewer {
  /** The kind of file it shows (`viewOf`). */
  readonly id: FileView
  readonly component: ComponentType<ViewerProps>
}

/** @public A plugin adds or replaces a viewer here. */
export const fileViewers = makeRegistry<FileViewer>()

/** The viewer for a file, or null: it downloads. */
export const viewerFor = (name: string) => fileViewers.get(viewOf(name)) ?? null

/** An attachment's copy as sent in the viewer for its type, read-only (§6.1): the chat's file tiles open it. */
export function AttachmentViewer({ name, url }: { readonly name: string; readonly url: string }) {
  const Viewer = viewerFor(name)?.component
  return Viewer ? <Viewer name={name} url={url} size={-1} path={null} source={null} readOnly /> : null
}

const Text = lazy(() => import("./TextViewer.tsx").then((m) => ({ default: m.TextViewer })))
const Pdf = lazy(() => import("./PdfViewer.tsx").then((m) => ({ default: m.PdfViewer })))

function Loading({ name }: { name: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      Loading {name}…
    </p>
  )
}

const textViewer = (mode: TextMode) =>
  function TextFileViewer(props: ViewerProps) {
    return (
      <Suspense fallback={<Loading name={props.name} />}>
        <Text {...props} mode={mode} />
      </Suspense>
    )
  }

function PdfFileViewer(props: ViewerProps) {
  return (
    <Suspense fallback={<Loading name={props.name} />}>
      <Pdf {...props} />
    </Suspense>
  )
}

function PictureViewer({ url, name }: ViewerProps) {
  const [zoom, setZoom] = useState<Zoom>("fit")
  return (
    <div className="h-[min(70vh,40rem)] min-h-64 overflow-hidden rounded-md border border-border bg-canvas">
      <ImageViewer src={url} alt={name} zoom={zoom} onZoom={setZoom} initials={name.slice(0, 2)} />
    </div>
  )
}

function VideoViewer({ url, name }: ViewerProps) {
  return (
    <video
      controls
      preload="metadata"
      aria-label={name}
      src={url}
      className="max-h-[70vh] w-full rounded-md border border-border bg-canvas"
    />
  )
}

function AudioViewer({ url, name }: ViewerProps) {
  return <audio controls preload="metadata" aria-label={name} src={url} className="w-full" />
}

/** A file no viewer shows: what it is, and the way to get it. The header's Download is the action. */
export function NoViewer({ name, size, why }: { name: string; size: number; why?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-canvas p-3 text-sm" data-no-viewer="">
      <p className="font-medium [overflow-wrap:anywhere]">{name}</p>
      <p className="text-muted">{formatByteSize(size)}</p>
      <p className="text-muted">{why ?? "The app can’t show this kind of file. Download it to open it."}</p>
    </div>
  )
}

export const registerViewers = () => [
  fileViewers.register({ id: "text", component: textViewer("text") }),
  fileViewers.register({ id: "markdown", component: textViewer("markdown") }),
  fileViewers.register({ id: "table", component: textViewer("table") }),
  fileViewers.register({ id: "html", component: textViewer("html") }),
  fileViewers.register({ id: "pdf", component: PdfFileViewer }),
  fileViewers.register({ id: "image", component: PictureViewer }),
  fileViewers.register({ id: "video", component: VideoViewer }),
  fileViewers.register({ id: "audio", component: AudioViewer })
]
