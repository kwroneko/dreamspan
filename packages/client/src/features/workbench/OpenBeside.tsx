// "Open beside" for an opener outside a tab (the sidebar's rows and tiles): VS Code's Open to
// the Side. The workbench's link gestures (Workbench.tsx) act on `data-open-beside`, so the
// button works wherever it's rendered, inside the workbench's context or not.
import { useSyncExternalStore } from "react"
import { IconButton } from "../../ui/Tooltip.tsx"

const WIDE = "(min-width: 1024px)"
const subscribe = (listener: () => void) => {
  const query = matchMedia(WIDE)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}

/** Only where frames can sit side by side (a phone has one). */
export function OpenBesideButton({ href, name, className = "" }: { href: string; name: string; className?: string }) {
  const wide = useSyncExternalStore(subscribe, () => matchMedia(WIDE).matches)
  if (!wide) return null
  return (
    <IconButton
      label={`Open ${name} beside`}
      hint="Opens it in the frame on the right, adding one if there's none. Alt-click a link to do the same."
      icon="split-right"
      data-open-beside={href}
      className={className}
    />
  )
}
