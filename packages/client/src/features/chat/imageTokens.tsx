// Image token estimates as the chat shows them (DESIGN §10.2a): each figure says where it
// comes from, and an image whose cost nothing states yet reads as unknown, never as zero.
import type { ContextImage, NextContext } from "@rp/shared/inspectorApi.ts"
import { Badge } from "../../ui/Surface.tsx"

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
export function NextImagesNote({ images }: { images: NonNullable<NextContext["images"]> }) {
  const bases = images.bases.filter((b) => b !== "unknown").map((b) => basisLabel[b])
  return (
    <p className="mx-auto w-full max-w-3xl py-0.5 text-xs text-muted">
      {images.count === 1 ? "1 image" : `${images.count} images`} in the next request: ~{images.tokens.toLocaleString()}{" "}
      tokens
      {bases.length > 0 && ` (${bases.join(", ")})`}.
      {images.unknown > 0 &&
        ` ${images.unknown === 1 ? "1 is" : `${images.unknown} are`} unknown until the first request with an image, and budgeted at a reserve.`}
    </p>
  )
}
