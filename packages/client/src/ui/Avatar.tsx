// A card's avatar: its image when it has one, else its initials on a tint picked from its
// id, so the same card always looks the same. A stack shows a chat's cast together.

const TINTS = [
  "bg-accent/15 text-accent",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-danger/15 text-danger"
]

const initials = (name: string) =>
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
  xl: "size-16 text-lg"
} as const

export type AvatarSize = keyof typeof SIZES

export function Avatar({
  id,
  name,
  mediaId = null,
  size = "md",
  className = ""
}: {
  id: string
  name: string
  mediaId?: string | null
  size?: AvatarSize
  className?: string
}) {
  if (mediaId !== null) {
    return (
      <img
        src={`/library/media?id=${encodeURIComponent(mediaId)}`}
        alt=""
        loading="lazy"
        className={`shrink-0 rounded-full bg-surface-raised object-cover ${SIZES[size]} ${className}`}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none ${tint(id)} ${SIZES[size]} ${className}`}
    >
      {initials(name)}
    </span>
  )
}

interface Face {
  readonly id: string
  readonly name: string
  readonly mediaId?: string | null
}

/** A chat's cast in one square: one face, two side by side, or up to four in a grid. */
export function AvatarStack({ faces, size = "lg" }: { faces: ReadonlyArray<Face>; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-10" : "size-8"
  const shown = faces.slice(0, 4)
  if (shown.length <= 1) {
    const face = shown[0] ?? { id: "", name: "?" }
    return <Avatar id={face.id} name={face.name} mediaId={face.mediaId ?? null} size={size} />
  }
  return (
    <span aria-hidden="true" className={`grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-full ${box}`}>
      {shown.map((face, i) => (
        <span
          key={face.id}
          className={`overflow-hidden ${shown.length === 2 ? "row-span-2" : shown.length === 3 && i === 0 ? "row-span-2" : ""}`}
        >
          {face.mediaId ? (
            <img
              src={`/library/media?id=${encodeURIComponent(face.mediaId)}`}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <span className={`flex size-full items-center justify-center text-[0.5rem] font-semibold ${tint(face.id)}`}>
              {initials(face.name).slice(0, 1)}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}
