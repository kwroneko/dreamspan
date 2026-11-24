// What a frame's tab strip shows besides its tabs, as registered parts (the owner's rule: every
// feature a registered, replaceable part). The strip's start, after the hidden sidebar's Show
// and before the tabs, holds the tab's back and forward (TabHistoryArrows.tsx).
import { defineSlot } from "../../slots.tsx"

export interface StripPartProps {
  readonly frameId: string
  /** The frame's shown tab, null while the frame is empty. */
  readonly tabId: string | null
}

export const tabStripStart = defineSlot<StripPartProps>("workbench.strip.start")

/** A disabled strip button keeps its look on hover: it only explains (owner: disabled with a reason, not hidden). */
export const DISABLED_HOVER = "data-disabled:hover:bg-transparent data-disabled:hover:text-muted"
