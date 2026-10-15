// A card's avatar: its image when it has one, else its initials on a tint picked from its
// id, so the same card always looks the same. A stack shows a chat's cast together.

import { useOpenPortrait } from "./Portrait.tsx"
import { mediaUrl, useMediaWidth } from "./mediaImage.ts"

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

const SIZES = {
  xs: "size-5 text-[0.5625rem]",
  sm: "size-6 text-[0.625rem]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  chat: "chat-portrait text-lg",
  xl: "size-16 text-lg",
  "2xl": "size-24 text-2xl",
  /** Fills its box: a grid tile's picture. */
  fill: "size-full text-4xl"
} as const

export type AvatarSize = keyof typeof SIZES

export function Avatar({
  id,
  name,
  mediaId = null,
  size = "md",
  shape = "circle",
  className = "",
  preview = false,
  alt = ""
}: {
  id: string
  name: string
  mediaId?: string | null
  size?: AvatarSize
  /** A square fills a tile whose own corners round it. */
  shape?: "circle" | "square"
  className?: string
  preview?: boolean
  alt?: string
}) {
  const open = useOpenPortrait()
  const { ref, width } = useMediaWidth()
  const round = size === "chat" ? "" : shape === "circle" ? "rounded-full" : ""
  const box = `relative inline-flex shrink-0 overflow-hidden ${round} ${SIZES[size]} ${className}`
  const content = (
    <>
      {mediaId !== null && width !== undefined && (
        <img
          src={mediaUrl(mediaId, width)}
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
      type="button"
      aria-label={`View ${name}'s portrait`}
      title={`View ${name}'s full portrait`}
      className={`${box} outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      onClick={(event) => {
        event.stopPropagation()
        open({ id, name, mediaId })
      }}
    >
      {content}
    </button>
  ) : (
    <span ref={ref} className={box}>
      {content}
    </span>
  )
}

interface Face {
  readonly id: string
  readonly name: string
  readonly mediaId?: string | null
}

/** A chat's cast in one square: one face, two side by side, or up to four in a grid. */
export function AvatarStack({
  faces,
  size = "lg",
  preview = false
}: {
  faces: ReadonlyArray<Face>
  size?: "md" | "lg"
  preview?: boolean
}) {
  const box = size === "lg" ? "size-10" : "size-8"
  const shown = faces.slice(0, 4)
  if (shown.length <= 1) {
    const face = shown[0] ?? { id: "", name: "?" }
    return <Avatar id={face.id} name={face.name} mediaId={face.mediaId ?? null} size={size} preview={preview} />
  }
  return (
    <span className={`grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-full ${box}`}>
      {shown.map((face, i) => (
        <span
          key={face.id}
          className={`overflow-hidden ${shown.length === 2 ? "row-span-2" : shown.length === 3 && i === 0 ? "row-span-2" : ""}`}
        >
          <Avatar
            id={face.id}
            name={face.name}
            mediaId={face.mediaId ?? null}
            size="fill"
            shape="square"
            preview={preview}
            className="text-[0.5rem]!"
          />
        </span>
      ))}
    </span>
  )
}
