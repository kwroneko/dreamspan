import type { ComponentProps } from "react"
import { IconButton } from "./Tooltip.tsx"

/** The same corner control for dismissible dialogs, sheets and popovers. */
export function WindowClose(props: Omit<ComponentProps<typeof IconButton>, "icon" | "label" | "className">) {
  return (
    <IconButton {...props} data-window-close label="Close" icon="close" className="[@media(pointer:coarse)]:size-11" />
  )
}
