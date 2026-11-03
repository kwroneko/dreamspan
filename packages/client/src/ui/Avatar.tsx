// A card's avatar: its image when it has one, else its initials on a tint picked from its
// id, so the same card always looks the same. A stack shows a chat's cast together.

import type { AvatarCrop } from "@rp/shared/media.ts"
import type { CSSProperties } from "react"
import { PortraitFrame, useOpenPortrait } from "./Portrait.tsx"
import { useMediaWidth } from "./mediaImage.ts"
import { portraitUrl } from "./portraitParts.ts"

const TINTS = [
  "bg-accent/15 text-accent",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-danger/15 text-danger"
]

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("") || "?"

const tint = (id: string) => {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return TINTS[Math.abs(hash) % TINTS.length]!
}

export const AVATAR_SIZES = {
  xs: "h-7.5 w-5 text-[0.5625rem]",
  sm: "h-9 w-6 text-[0.625rem]",
  chip: "h-7 w-[18.667px] text-[0.625rem]",
  md: "h-12 w-8 text-xs",
  lg: "h-15 w-10 text-sm",
  chat: "chat-portrait text-lg",
  xl: "h-24 w-16 text-lg",
  "2xl": "h-36 w-24 text-2xl",
  /** Fills its box: a grid tile's picture. */
  fill: "aspect-[2/3] w-full text-4xl"
} as const

export type AvatarSize = keyof typeof AVATAR_SIZES

/**
 * Where `object-cover` puts an image that isn't already the cutout: an animated or very large
 * one, which the server serves whole (§14.5b). The cutout's centre is kept in view; a cut-out
 * thumbnail is 2:3 already, so this moves nothing.
 */
const cutoutPosition = (crop: AvatarCrop | null | undefined): CSSProperties | undefined => {
  if (!crop) return { objectPosition: "50% 0%" }
  const along = (start: number, size: number) => (size >= 1 ? 50 : (start / (1 - size)) * 100)
  return { objectPosition: `${along(crop.x, crop.width)}% ${along(crop.y, crop.height)}%` }
}

export function Avatar({
  id,
  name,
  mediaId = null,
  crop = null,
  size = "md",
  shape: _shape,
  className = "",
  preview = false,
  alt = ""
}: {
  id: string
  name: string
  mediaId?: string | null
  /** The avatar's chosen cutout (§14.5c): what the portrait shows. Absent or null: the default. */
  crop?: AvatarCrop | null | undefined
  size?: AvatarSize
  /** Compatibility for tile callers; portraits always use rectangular corners. */
  shape?: "circle" | "square"
  className?: string
  preview?: boolean
  alt?: string
}) {
  const open = useOpenPortrait()
  const { ref, width } = useMediaWidth()
  // A filling portrait must not leave an inline baseline below it in collage cells.
  // That extra line-box space otherwise makes row gaps larger than column gaps.
  const box = `relative ${size === "fill" ? "flex" : "inline-flex"} shrink-0 overflow-hidden rounded-sm ${AVATAR_SIZES[size]} ${className}`
  const content = (
    <>
      {mediaId !== null && width !== undefined && (
        <img
          src={portraitUrl(mediaId, width, crop)}
          style={cutoutPosition(crop)}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full bg-surface-raised object-cover"
        />
      )}
      <span
        aria-hidden="true"
        {...(mediaId !== null ? { "data-image-fallback": true } : {})}
        className={`size-full items-center justify-center font-semibold select-none ${mediaId !== null ? "bg-surface-raised text-muted" : `inline-flex ${tint(id)}`}`}
      >
        {initials(name)}
      </span>
    </>
  )
  return preview && open ? (
    <button
      ref={ref}
      data-portrait
      type="button"
      aria-label={`View ${name}'s portrait`}
      title={`View ${name}'s full portrait`}
      className={`${box} outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      onClick={(event) => {
        event.stopPropagation()
        open({ id, name, mediaId })
      }}
    >
      <PortraitFrame className="size-full">{content}</PortraitFrame>
    </button>
  ) : (
    <span ref={ref} data-portrait className={box}>
      <PortraitFrame className="size-full">{content}</PortraitFrame>
    </span>
  )
}

interface Face {
  readonly id: string
  readonly name: string
  readonly mediaId?: string | null
  readonly crop?: AvatarCrop | null | undefined
}

/** A chat's cast as a compact row of consistently shaped portraits. */
export function AvatarStack({
  faces,
  size = "lg",
  preview = false
}: {
  faces: ReadonlyArray<Face>
  size?: "md" | "lg"
  preview?: boolean
}) {
  const shown = faces.slice(0, 3)
  return (
    <span className="inline-flex shrink-0 gap-0.5">
      {(shown.length ? shown : [{ id: "", name: "?" }]).map((face) => (
        <Avatar
          key={face.id}
          id={face.id}
          name={face.name}
          mediaId={face.mediaId ?? null}
          crop={face.crop ?? null}
          size={size}
          preview={preview}
        />
      ))}
    </span>
  )
}
