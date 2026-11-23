// A plain click on a field's expand link (fieldTab.ts): it keeps the tab it's opened from (an
// italic preview would otherwise give its place to the field) and opens the field in that tab's
// frame, or where a field's tab is showing (its kind opens where it's shown). Outside the
// workbench it's a navigation. Kept apart so a chat's texts use it without the editors.
import { useNavigate } from "@tanstack/react-router"
import { useWorkbench, useWorkbenchTab } from "../workbench/tab.tsx"

/** A field's tab, for its expand link: where it goes, and a plain click's opening. */
export interface FieldTabLink {
  readonly href: string
  readonly open: () => void
}

/** The expand link of a field whose tab is at `href`. */
export function useFieldTabLink(href: string): FieldTabLink {
  const workbench = useWorkbench()
  const tab = useWorkbenchTab()
  const navigate = useNavigate()
  const open = () => {
    if (!workbench) return void navigate({ href })
    if (tab) workbench.pin(tab.tabId)
    workbench.openIn(tab ? workbench.frameOf(tab.tabId) : undefined, href)
  }
  return { href, open }
}
