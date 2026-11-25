// Image token estimates as the chat shows them (DESIGN §10.2a): each figure says where it
// comes from, and an image whose cost nothing states yet reads as unknown, never as zero.
import { createContext, Fragment, useContext, type ReactNode } from "react"
import type { ContextImage, NextContext } from "@dreamspan/shared/inspectorApi.ts"
import { ContentImage } from "../../ui/ContentImage.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { EnsurePortraitViewer, usePortraitViewer } from "../../ui/Portrait.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { attachmentPicture } from "./attachmentPictures.ts"

const basisLabel: Record<ContextImage["basis"], string> = {
  counted: "counted by the provider",
  formula: "provider's formula",
  calibrated: "calibrated from earlier requests",
  unknown: "unknown until the first request with an image"
}

/** One image's figure and basis, for a context view message. */
export function ImageEstimate({ image, index }: { image: ContextImage; index: number }) {
  const figure =
    image.tokens === null
      ? `unknown (budgeted ~${image.budgeted.toLocaleString()})`
      : `~${image.tokens.toLocaleString()}`
  const title = [
    !image.sent && "Not sent: past the model's image limit, or taken out of the context.",
    image.detail && `Detail: ${image.detail}.`,
    image.note
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <span className="inline-flex items-center gap-1" title={title || undefined}>
      <Badge tone={image.basis === "unknown" ? "warning" : "neutral"}>
        Image {index + 1}: {image.sent ? `${figure} tokens` : "not sent"}
      </Badge>
      {image.sent && <span className="text-xs text-muted">{basisLabel[image.basis]}</span>}
    </span>
  )
}

/** The next request's images, summed, beside the composer. */
export function NextImagesNote({ images }: { images: NonNullable<NextContext["imageTokens"]> }) {
  const bases = images.bases.filter((b) => b !== "unknown").map((b) => basisLabel[b])
  return (
    <p className="chat-column py-0.5 text-xs text-muted">
      {images.count === 1 ? "1 image" : `${images.count} images`} in the next request: ~{images.tokens.toLocaleString()}{" "}
      tokens
      {bases.length > 0 && ` (${bases.join(", ")})`}.
      {images.unknown > 0 &&
        ` ${images.unknown === 1 ? "1 is" : `${images.unknown} are`} unknown until the first request with an image, and budgeted at a reserve.`}
    </p>
  )
}

function SentImage({ image, index }: { image: ContextImage; index: number }) {
  const viewer = usePortraitViewer()
  const name = `Image ${index + 1}`
  const figure = image.tokens === null ? "tokens unknown" : `~${image.tokens.toLocaleString()} tokens`
  return (
    <figure className="m-0 flex flex-col items-start gap-1" data-sent-image={index + 1}>
      <button
        type="button"
        aria-label={`${name}, sent to the model`}
        onClick={() => viewer?.open(attachmentPicture(image.mediaId, name))}
        className="rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ContentImage
          src={mediaUrl(image.mediaId, 320)}
          alt=""
          loading="lazy"
          className="max-h-40 max-w-full rounded-md object-contain"
        />
      </button>
      <figcaption className="text-xs text-muted tabular-nums">{figure}</figcaption>
    </figure>
  )
}

const IMAGE_TAG = /<attachment\b[^>]*?path="\/attachments\/([^"]+)"[^>]*?image_block="true"[^>]*?\/>/g

/** The sent images of the message being shown, by media id, for the tags that carry them. */
const SentImagesContext = createContext<ReadonlyMap<string, { image: ContextImage; index: number }> | null>(null)

/** The images of a message whose `<attachment … image_block="true"/>` tag is in its text. */
const taggedIn = (content: string, images: ReadonlyArray<ContextImage>) => {
  const ids = new Set([...content.matchAll(IMAGE_TAG)].map((m) => m[1]!))
  return new Set(images.flatMap((image, index) => (image.sent && ids.has(image.mediaId) ? [index] : [])))
}

/**
 * A message's text with each image-block tag shown as an opening and closing pair around the
 * image sent with it. Display only: the request's text is the self-closing tag.
 */
export function ImagesInTags({ text, children }: { text: string; children: (text: string) => ReactNode }) {
  const sent = useContext(SentImagesContext)
  if (!sent) return children(text)
  const out: Array<ReactNode> = []
  let at = 0
  for (const match of text.matchAll(IMAGE_TAG)) {
    const found = sent.get(match[1]!)
    if (!found) continue
    const start = match.index
    const open = match[0].slice(0, -2) + ">"
    if (start > at) out.push(<Fragment key={`t${at}`}>{children(text.slice(at, start))}</Fragment>)
    out.push(
      <div key={`i${start}`} className="flex flex-col gap-1 font-mono text-[13px] leading-relaxed text-muted">
        <span className="break-words whitespace-pre-wrap">{open}</span>
        <div className="pl-4">
          <SentImage image={found.image} index={found.index} />
        </div>
        <span>{"</attachment>"}</span>
      </div>
    )
    at = start + match[0].length
  }
  if (out.length === 0) return children(text)
  if (at < text.length) out.push(<Fragment key={`t${at}`}>{children(text.slice(at))}</Fragment>)
  return <>{out}</>
}

/**
 * The images a request message carries as image blocks. Each shows inside its attachment tag in
 * the text below (an API attaches images to the whole message, so this is how the inspector
 * marks which one); `raw` text and images with no tag are listed after it. An image left out of
 * the request has no thumbnail: its text reference is all the model got.
 */
export function SentImagesScope({
  message,
  raw,
  children
}: {
  message: { content: string; images?: ReadonlyArray<ContextImage> }
  raw: boolean
  children: ReactNode
}) {
  const images = message.images ?? []
  const tagged = raw ? new Set<number>() : taggedIn(message.content, images)
  const map = new Map(
    images.flatMap((image, index) => (tagged.has(index) ? [[image.mediaId, { image, index }] as const] : []))
  )
  const rest = images.flatMap((image, index) => (image.sent && !tagged.has(index) ? [{ image, index }] : []))
  return (
    <SentImagesContext value={map}>
      <EnsurePortraitViewer>
        {children}
        {rest.length > 0 && (
          <div className="flex flex-wrap items-start gap-2" aria-label="Images sent to the model">
            {rest.map(({ image, index }) => (
              <SentImage key={index} image={image} index={index} />
            ))}
          </div>
        )}
      </EnsurePortraitViewer>
    </SentImagesContext>
  )
}
