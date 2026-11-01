// Generic text-command contributions. Editors offer them in their own chrome; features supply
// the behavior. The browser's own context menu stays everywhere: nothing here replaces it.
import { useEffect, useSyncExternalStore, type KeyboardEvent } from "react"
import { makeRegistry } from "./registry.ts"
import { Icon, type IconName } from "./ui/Icon.tsx"
import { Tooltip } from "./ui/Tooltip.tsx"
import { textSelection, type TextSelection } from "./ui/textTargets.ts"

interface TextActionContext {
  readonly text: string
  readonly source?: "snippet" | "note"
  readonly refId?: string
}
export interface TextAction {
  readonly id: string
  readonly label: string
  /** What a phone's narrow editor bar shows, `label` remaining its accessible name. */
  readonly shortLabel?: string
  readonly icon?: IconName
  /**
   * Where an editor offers it in its own chrome: on its whole text, or on its selection,
   * shown only while there is one. Without it, a feature offers the action itself.
   */
  readonly editor?: "text" | "selection"
  /** With Ctrl/Command+Shift, inside an editor that shows this action's control. */
  readonly shortcut?: string
  readonly available: (context: TextActionContext) => boolean
  readonly run: (context: TextActionContext) => void
}
export const textActions = makeRegistry<TextAction>()
let destination: TextSelection | null = null
export const hasTextDestination = () => destination !== null
export const insertText = (text: string) => {
  if (!destination) return false
  destination.insert(text)
  return true
}

/** Remembers the last field the user worked in, where Insert puts text. */
export function TextActionHost() {
  useEffect(() => {
    const isTool = (e: Event) =>
      e.composedPath().some((node) => node instanceof HTMLElement && node.hasAttribute("data-text-tool"))
    const capture = (e: Event) => {
      if (isTool(e)) return
      const target = textSelection(e)
      if (target && target.editable !== false) destination = target
    }
    const events = ["focusin", "keyup", "pointerup", "select"]
    for (const name of events) document.addEventListener(name, capture)
    return () => {
      for (const name of events) document.removeEventListener(name, capture)
      destination = null
    }
  }, [])
  return null
}

const shortcutLabel = (key: string) =>
  `${typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Command" : "Ctrl"}+Shift+${key.toUpperCase()}`

/** The actions an editor offers now: its whole text's, then its selection's while it has one. */
export const editorTextActions = (
  entries: ReadonlyArray<TextAction>,
  text: string,
  selection: string,
  source?: "snippet"
) =>
  entries.flatMap((action) => {
    const context = { text: action.editor === "selection" ? selection : text, ...(source ? { source } : {}) }
    if (action.editor === "selection" ? selection.length === 0 : action.editor !== "text") return []
    return action.available(context) ? [{ action, context }] : []
  })

/**
 * The editor's own text-action bar, under its box. The selection's actions come and go with
 * the selection; on a phone the OS's selection menu floats at the selection, never down here.
 */
export function EditorTextActions({
  text,
  selection,
  source,
  className = ""
}: {
  text: string
  selection: string
  source?: "snippet" | undefined
  className?: string
}) {
  const snapshot = useSyncExternalStore(textActions.subscribe, textActions.snapshot, textActions.snapshot)
  const offered = editorTextActions(snapshot.entries, text, selection, source)
  if (offered.length === 0) return null
  return (
    <div
      data-text-tool
      role="toolbar"
      aria-label="Text actions"
      className={`flex flex-wrap items-center justify-end gap-1 ${selection ? "" : "invisible group-focus-within/text:visible group-hover/text:visible"} ${className}`}
    >
      {offered.map(({ action, context }) => (
        <Tooltip
          key={action.id}
          label={action.shortcut ? `${action.label} (${shortcutLabel(action.shortcut)})` : action.label}
        >
          <button
            type="button"
            aria-label={action.label}
            // The editor keeps its focus and selection.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => action.run(context)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus max-sm:h-8"
          >
            {action.icon && (
              <span className="max-sm:hidden">
                <Icon name={action.icon} size={14} />
              </span>
            )}
            <span className={action.shortLabel ? "max-sm:hidden" : ""}>{action.label}</span>
            {action.shortLabel && <span className="sm:hidden">{action.shortLabel}</span>}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

/** An editor's Ctrl/Command+Shift shortcut for an action its bar shows now. */
export const runEditorShortcut = (event: KeyboardEvent, text: string, selection: string, source?: "snippet") => {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
  const key = event.key.toLowerCase()
  const hit = editorTextActions(textActions.snapshot().entries, text, selection, source).find(
    ({ action }) => action.shortcut?.toLowerCase() === key
  )
  if (!hit) return
  event.preventDefault()
  event.stopPropagation()
  hit.action.run(hit.context)
}
