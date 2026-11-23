import { chromeButton } from "./FieldFrame.tsx"
import { IconLink } from "./Tooltip.tsx"

/**
 * A field's expand button (owner, 2026-11-23): a link to the tab holding the field on its own,
 * so a click opens it in the workbench and its right-click menu opens it beside or in a new
 * browser tab, as any link's.
 */
export function ExpandLink({ label, href, open }: { label: string; href: string; open?: () => void }) {
  return (
    <IconLink
      label={`Open ${label} in a tab`}
      hint={`Opens ${label} in its own tab.`}
      icon="expand"
      href={href}
      onOpen={open}
      className={chromeButton}
    />
  )
}
