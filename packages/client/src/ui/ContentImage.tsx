// Message/draft images share the root concealment rules with portraits. Keeping a
// placeholder beside the img preserves its measured box when images are hidden.
import type { ComponentProps } from "react"

export function ContentImage({
  alt,
  frameClassName = "",
  ...props
}: ComponentProps<"img"> & { frameClassName?: string }) {
  return (
    <span className={`relative inline-flex min-w-0 max-w-full items-center justify-center ${frameClassName}`}>
      <img {...props} alt={alt} />
      <span
        data-image-fallback
        className="absolute inset-0 items-center justify-center rounded-md bg-surface-raised px-2 text-center text-xs text-muted"
      >
        Image hidden
      </span>
    </span>
  )
}
