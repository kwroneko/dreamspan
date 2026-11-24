// ← and → at the start of each frame's tab strip (owner, 2026-11-24; spec/TAB-HISTORY.md): the
// frame's shown tab's own back and forward. They follow the shown tab, are always there (disabled,
// explaining, when there's nowhere to go, so nothing shifts), and their hovers name only where
// they go. Registered as the strip's `workbench.tab-history` part.
import { useCallback, useSyncExternalStore } from "react"
import { IconButton } from "../../ui/Tooltip.tsx"
import { DISABLED_HOVER, type StripPartProps } from "./stripParts.ts"
import { useWorkbench } from "./tab.tsx"

const noSubscribe = () => () => {}

export function TabHistoryArrows({ tabId }: StripPartProps) {
  const store = useWorkbench()
  // The shown tab's history changes, and the layout (another tab shown, a tab moved).
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!store) return noSubscribe()
      const stopHistory = store.subscribeHistory(listener)
      const stopLayout = store.subscribe(listener)
      return () => {
        stopHistory()
        stopLayout()
      }
    },
    [store]
  )
  const back = useSyncExternalStore(subscribe, () => (store && tabId ? store.stepLabel(tabId, -1) : null))
  const forward = useSyncExternalStore(subscribe, () => (store && tabId ? store.stepLabel(tabId, 1) : null))
  const step = (delta: -1 | 1) => {
    if (store && tabId) store.step(tabId, delta)
  }
  return (
    <div data-strip-history className="flex shrink-0 items-center gap-0.5 border-r border-border px-1">
      <IconButton
        label="Back"
        hint={back === null ? "Nothing to go back to" : `Back to ${back}`}
        icon="back"
        disabled={back === null}
        focusableWhenDisabled
        className={`size-7! ${DISABLED_HOVER}`}
        onClick={() => step(-1)}
      />
      <IconButton
        label="Forward"
        hint={forward === null ? "Nothing to go forward to" : `Forward to ${forward}`}
        icon="forward"
        disabled={forward === null}
        focusableWhenDisabled
        className={`size-7! ${DISABLED_HOVER}`}
        onClick={() => step(1)}
      />
    </div>
  )
}
