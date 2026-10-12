// A card's avatar: its initials on a tint picked from its id, so the same card always looks
// the same. Image avatars come with the media route; until then, initials.

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

export function Avatar({ id, name, size = "md" }: { id: string; name: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none ${tint(id)} ${
        size === "sm" ? "size-6 text-[0.625rem]" : "size-8 text-xs"
      }`}
    >
      {initials(name)}
    </span>
  )
}
