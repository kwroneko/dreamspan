// What a file opens in (spec/FILES-AND-ENVIRONMENT.md §8.2), by type: a registry, so a plugin can
// add or replace a viewer (the full set, PDF and the editor among them, is track B2). Built in:
// text and code (read-only here), images, video and audio. Anything else offers a download.
import { viewOf, type FileView } from "@rp/shared/files.ts"
import { useEffect, useState, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { ImageViewer, type Zoom } from "../../ui/ImageViewer.tsx"
import { formatByteSize } from "@rp/shared/byteSize.ts"
import type { FilesSource } from "./source.ts"

interface ViewerProps {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly source: FilesSource
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

/** More than this shows as a download instead: a viewer that pages through big text is B2's. */
const TEXT_LIMIT = 2 * 1024 * 1024

function TextViewer({ path, name, size, source }: ViewerProps) {
  const [text, setText] = useState<{ for: string; value: string } | { for: string; error: string } | null>(null)
  const tooBig = size > TEXT_LIMIT
  useEffect(() => {
    if (tooBig) return
    let live = true
    fetch(source.rawUrl(path), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The server answered ${response.status}.`)
        return response.text()
      })
      .then(
        (value) => live && setText({ for: path, value }),
        (error: unknown) =>
          live && setText({ for: path, error: error instanceof Error ? error.message : String(error) })
      )
    return () => {
      live = false
    }
  }, [path, source, tooBig])
  if (tooBig) return <NoViewer name={name} size={size} why="It's too large to show here." />
  const shown = text?.for === path ? text : null
  if (shown === null)
    return (
      <p role="status" className="text-sm text-muted">
        Loading {name}…
      </p>
    )
  if ("error" in shown)
    return (
      <p role="alert" className="text-sm text-danger">
        {name} couldn’t be read: {shown.error}
      </p>
    )
  return (
    <CodeEditor
      label={`Contents of ${name}`}
      value={shown.value}
      base={shown.value}
      readOnly
      mono
      textActions={false}
      expand={false}
      rows={16}
      onChange={() => undefined}
    />
  )
}

function PictureViewer({ path, name, source }: ViewerProps) {
  const [zoom, setZoom] = useState<Zoom>("fit")
  return (
    <div className="h-[min(70vh,40rem)] min-h-64 overflow-hidden rounded-md border border-border bg-canvas">
      <ImageViewer src={source.rawUrl(path)} alt={name} zoom={zoom} onZoom={setZoom} initials={name.slice(0, 2)} />
    </div>
  )
}

function VideoViewer({ path, name, source }: ViewerProps) {
  return (
    <video
      controls
      preload="metadata"
      aria-label={name}
      src={source.rawUrl(path)}
      className="max-h-[70vh] w-full rounded-md border border-border bg-canvas"
    />
  )
}

function AudioViewer({ path, name, source }: ViewerProps) {
  return <audio controls preload="metadata" aria-label={name} src={source.rawUrl(path)} className="w-full" />
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
  fileViewers.register({ id: "text", component: TextViewer }),
  fileViewers.register({ id: "image", component: PictureViewer }),
  fileViewers.register({ id: "video", component: VideoViewer }),
  fileViewers.register({ id: "audio", component: AudioViewer })
]
