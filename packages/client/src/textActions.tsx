// Generic text-command contributions. Editors offer them in their own chrome; features supply
// the behavior. The browser's own context menu stays everywhere: nothing here replaces it.
import { useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from "react"
import { makeRegistry } from "./registry.ts"
import { Icon, type IconName } from "./ui/Icon.tsx"
import { Tooltip } from "./ui/Tooltip.tsx"

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
  /** What it does, in a sentence, when the label alone doesn't say: shown in its tooltip. */
  readonly description?: string
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
 * The editor's own text-action bar, under its box, only while the editor has focus (`shown`)
 * or a selection: hidden, it takes no room. It takes the room below the box, so what moves when
 * it comes and goes is what's under the editor, never the text in it. Only prose editors have one
 * (the message editor, card text, prompts, notes, summaries; owner, 2026-11-01): a box of
 * settings, keys, tags, names, patterns, numbers or addresses doesn't. The selection's actions
 * come and go with the selection; on a phone the OS's selection menu floats at the selection,
 * never down here.
 */
export function EditorTextActions({
  text,
  selection,
  shown,
  source,
  className = ""
}: {
  text: string
  selection: string
  shown: boolean
  source?: "snippet" | undefined
  className?: string
}) {
  const snapshot = useSyncExternalStore(textActions.subscribe, textActions.snapshot, textActions.snapshot)
  const offered = editorTextActions(snapshot.entries, text, selection, source)
  if (offered.length === 0 || !(shown || selection)) return null
  return (
    <div
      data-text-tool
      role="toolbar"
      aria-label="Text actions"
      className={`flex flex-wrap items-center justify-end gap-1 ${className}`}
    >
      {offered.map(({ action, context }) => (
        <Tooltip
          key={action.id}
          label={
            <>
              {action.shortcut ? `${action.label} (${shortcutLabel(action.shortcut)})` : action.label}
              {action.description && <span className="block">{action.description}</span>}
            </>
          }
        >
          <button
            type="button"
            aria-label={action.label}
            aria-description={action.description}
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

/** Whether a pointer is pressed anywhere: a press that takes focus from an editor isn't over yet. */
let pressed = false
let tracking = false
const trackPresses = () => {
  if (tracking || typeof document === "undefined") return
  tracking = true
  document.addEventListener("pointerdown", () => (pressed = true), true)
  for (const name of ["pointerup", "pointercancel"])
    document.addEventListener(name, () => setTimeout(() => (pressed = false)), true)
}

/**
 * Whether focus is in an editor (its box or its bar), for the wrapper around both. Its selection
 * counts only then: a box left for elsewhere keeps its selection, unseen, until it's back. Left by
 * a press (a click on the editor's own Save or Cancel, under its bar), it counts as focused until
 * the press ends and its click has landed: the bar going away moves what's below it, which would
 * otherwise move the button out from under the pointer before the click.
 */
export const useEditorFocus = () => {
  const [focused, setFocused] = useState(false)
  trackPresses()
  return {
    focused,
    onFocus: () => setFocused(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      if (!pressed) return setFocused(false)
      const wrapper = event.currentTarget
      const release = () => {
        document.removeEventListener("pointerup", release, true)
        document.removeEventListener("pointercancel", release, true)
        // After the click the release makes, unless focus came back meanwhile.
        setTimeout(() => !wrapper.contains(document.activeElement) && setFocused(false))
      }
      document.addEventListener("pointerup", release, true)
      document.addEventListener("pointercancel", release, true)
    }
  }
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
