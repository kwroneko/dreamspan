import { Tooltip } from "./Tooltip.tsx"
// A card's avatar: its image when it has one, else its initials on a tint picked from its
// id, so the same card always looks the same. A stack shows a chat's cast together.

import type { AvatarCrop } from "@dreamspan/shared/media.ts"
import { type ComponentProps, type CSSProperties, useState } from "react"
import { carryOnDrag, PICTURE_DRAG } from "./appDrags.ts"
import { PortraitFrame, usePortraitViewer } from "./Portrait.tsx"
import { useMediaWidth } from "./mediaImage.ts"
import { portraitUrl } from "./portraitParts.ts"

const TINTS = [
  "bg-accent/15 text-accent",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-danger/15 text-danger"
]

export const initials = (name: string) =>
  [
    ...name
      .split(/\s+/)
      .filter((word) => word !== "")
      .slice(0, 2)
      .map((word) => [...word][0]!.toUpperCase())
      .join("")
  ]
    .slice(0, 2)
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
  alt = "",
  src
}: {
  id: string
  name: string
  mediaId?: string | null
  /** A picture that isn't a stored file (a card source's, through this server), at a width. */
  src?: ((width: number) => string) | undefined
  /** The avatar's chosen cutout (§14.5c): what the portrait shows. Absent or null: the default. */
  crop?: AvatarCrop | null | undefined
  size?: AvatarSize
  /** Compatibility for tile callers; portraits always use rectangular corners. */
  shape?: "circle" | "square"
  className?: string
  preview?: boolean
  alt?: string
}) {
  const viewer = usePortraitViewer()
  const open = viewer?.open
  const { ref, width } = useMediaWidth()
  // A filling portrait must not leave an inline baseline below it in collage cells.
  // That extra line-box space otherwise makes row gaps larger than column gaps.
  const box = `relative ${size === "fill" ? "flex" : "inline-flex"} shrink-0 overflow-hidden rounded-sm ${AVATAR_SIZES[size]} ${className}`
  // A source's picture that fails to load shows the initials, as a card without one does.
  const [failed, setFailed] = useState<string | null>(null)
  const url = src && width !== undefined ? src(width) : null
  const shown = mediaId !== null || (src !== undefined && failed !== url)
  const content = (
    <>
      {shown && width !== undefined && (
        <img
          src={url ?? portraitUrl(mediaId!, width, crop)}
          {...(url === null ? {} : { onError: () => setFailed(url) })}
          style={cutoutPosition(crop)}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full bg-surface-raised object-cover"
        />
      )}
      <span
        aria-hidden="true"
        {...(shown ? { "data-image-fallback": true } : {})}
        className={`size-full items-center justify-center text-[40cqi] leading-none font-semibold select-none ${shown ? "bg-surface-raised text-muted" : `inline-flex ${tint(id)}`}`}
      >
        {initials(name)}
      </span>
    </>
  )
  return preview && open ? (
    <Tooltip label="Opens this portrait at full size.">
      <button
        ref={ref}
        data-portrait
        type="button"
        aria-label={`View ${name}'s portrait`}
        title={`View ${name}'s full portrait`}
        className={`${box} outline-none focus-visible:ring-2 focus-visible:ring-focus`}
        onClick={(event) => {
          event.stopPropagation()
          open({ id, name, mediaId, picture: crop?.picture })
        }}
        onDragStart={(event) => {
          // Dropped on a frame, it opens there as a tab (features/workbench), never as an attachment.
          const href = viewer?.tabHref?.({ id, name, mediaId, picture: crop?.picture })
          carryOnDrag(event.dataTransfer, PICTURE_DRAG.id, href)
        }}
      >
        <PortraitFrame className="@container size-full">{content}</PortraitFrame>
      </button>
    </Tooltip>
  ) : (
    <span ref={ref} data-portrait className={box}>
      <PortraitFrame className="@container size-full">{content}</PortraitFrame>
    </span>
  )
}

interface Face {
  readonly id: string
  readonly name: string
  readonly mediaId?: string | null
  readonly crop?: AvatarCrop | null | undefined
}

/**
 * The header's overflow tile, scaled to match its adjacent portraits. `fixedWidth`: one width
 * for every count, the width of "+99" in tabular numerals, and above 99 "99+" in it, so a
 * count arriving or changing moves nothing beside the tile.
 */
export function PortraitOverflow({
  remaining,
  size = "md",
  fixedWidth = false,
  className = "",
  ...props
}: { remaining: number; size?: AvatarSize; fixedWidth?: boolean } & Omit<ComponentProps<"span">, "children">) {
  if (remaining <= 0) return null
  return (
    <span
      data-portrait-overflow
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
      className={`inline-flex shrink-0 items-center justify-center rounded-sm border border-border bg-surface-raised text-muted ${AVATAR_SIZES[size]} ${className}`}
    >
      {fixedWidth ? (
        // "+99", unseen and not part of the text, sizes the one cell the count is centred in.
        <span className="grid justify-items-center tabular-nums before:invisible before:col-start-1 before:row-start-1 before:content-['+99']">
          <span className="col-start-1 row-start-1">{remaining > 99 ? "99+" : `+${remaining}`}</span>
        </span>
      ) : (
        <span>+{remaining}</span>
      )}
    </span>
  )
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
    <Tooltip label={`Characters: ${faces.map((face) => face.name).join(", ")}`}>
      <span
        tabIndex={0}
        aria-label={`Characters: ${faces.map((face) => face.name).join(", ")}`}
        className="relative inline-flex w-fit shrink-0 gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
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
        <PortraitOverflow remaining={faces.length - shown.length} size={size} />
      </span>
    </Tooltip>
  )
}
