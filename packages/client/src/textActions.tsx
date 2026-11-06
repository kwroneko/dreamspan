// Generic text-command contributions. Editors offer them in their own chrome; features supply
// the behavior. The browser's own context menu stays everywhere: nothing here replaces it.
import {
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { makeRegistry } from "./registry.ts"
import { Icon, type IconName } from "./ui/Icon.tsx"
import { Menu } from "./ui/Menu.tsx"
import { Tooltip } from "./ui/Tooltip.tsx"

export interface TextActionContext {
  readonly text: string
  readonly source?: "snippet" | "note"
  readonly refId?: string
  /**
   * The message whose text this is, while the user writes their own version of it (the
   * composition, features/chat/composition.ts): text added there goes to that version.
   */
  readonly ownVersion?: OwnVersionTarget
}
/** A version the user is writing of a message, which text can be added to. */
export interface OwnVersionTarget {
  /** Says which message, for explanations: "message 12". */
  readonly name: string
  readonly add: (text: string) => void
}
export interface TextAction {
  readonly id: string
  readonly label: string
  /** What a phone's narrow editor bar shows, `label` remaining its accessible name. */
  readonly shortLabel?: string
  /**
   * What it does, in a sentence, when the label alone doesn't say: shown in its tooltip. A
   * function is read each time the tooltip shows, for an action whose effect depends on the screen.
   */
  readonly description?: string | ((context: TextActionContext) => string)
  readonly icon?: IconName
  /**
   * Where an editor offers it in its own chrome: on its whole text, or on its selection,
   * shown only while there is one. Without it, a feature offers the action itself.
   */
  readonly editor?: "text" | "selection"
  /** With Ctrl/Command+Shift, inside an editor that shows this action's control. */
  readonly shortcut?: string
  /** Constant applicability, independent of the text being edited. */
  readonly applies?: (context: TextActionContext) => boolean
  readonly unavailable?: (context: TextActionContext) => string
  readonly available: (context: TextActionContext) => boolean
  /** "choose": open `choices` at its button instead (there's no one obvious place for the text). */
  readonly run: (context: TextActionContext) => void | "choose"
  /**
   * The places it can go, as menu items (ui/Menu), in a menu at its button: a right-click or
   * long-press on the button opens it, and so does `run` returning "choose". `done` closes it.
   */
  readonly choices?: ComponentType<{ context: TextActionContext; done: () => void }>
}
export const textActions = makeRegistry<TextAction>()

const shortcutLabel = (key: string) =>
  `${typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Command" : "Ctrl"}+Shift+${key.toUpperCase()}`

/**
 * The actions an editor offers now: its selection's while it has one, then its whole text's. The
 * strip is end-aligned, so the selection's, which come and go, go first: nothing else moves.
 */
export const editorTextActions = (
  entries: ReadonlyArray<TextAction>,
  text: string,
  selection: string,
  source?: "snippet",
  keepUnavailable = false,
  scope: Partial<Pick<TextActionContext, "ownVersion">> = {}
) =>
  [...entries.filter((a) => a.editor === "selection"), ...entries.filter((a) => a.editor !== "selection")].flatMap(
    (action) => {
      const context = {
        text: action.editor === "selection" ? selection : text,
        ...(source ? { source } : {}),
        ...scope
      }
      if (action.editor === "selection" ? selection.length === 0 : action.editor !== "text") return []
      if (action.applies?.(context) === false) return []
      return action.available(context) || (keepUnavailable && action.editor === "text") ? [{ action, context }] : []
    }
  )

/**
 * The editor's own text actions, in the strip inside its box (ui/FieldFrame.tsx). Whole-text
 * actions keep their places, disabled when unavailable; the frame hides its idle strip by
 * opacity (owner, 2026-11-02). An action with an icon shows
 * only its icon, its name in its explanation. Only prose editors have them
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
  scope,
  className = ""
}: {
  text: string
  selection: string
  shown: boolean
  source?: "snippet" | undefined
  /** What the text belongs to, for actions on it: rendered message text being composed from. */
  scope?: Partial<Pick<TextActionContext, "ownVersion">> | undefined
  className?: string
}) {
  const snapshot = useSyncExternalStore(textActions.subscribe, textActions.snapshot, textActions.snapshot)
  const offered = editorTextActions(snapshot.entries, text, selection, source, true, scope)
  if (offered.length === 0) return null
  return (
    <div
      data-text-tool
      data-editor-active={shown || undefined}
      role="toolbar"
      aria-label="Text actions"
      className={`flex min-w-0 items-center justify-end gap-0.5 ${className}`}
    >
      {offered.map(({ action, context }) => (
        <ActionButton key={action.id} action={action} context={context} />
      ))}
    </div>
  )
}

const describe = (action: TextAction, context: TextActionContext) =>
  typeof action.description === "function" ? action.description(context) : action.description

/** Read as the tooltip shows, so it says what a click does now. */
function Explained({ action, context }: { action: TextAction; context: TextActionContext }) {
  "use no memo"
  const description = describe(action, context)
  return (
    <>
      {action.shortcut ? `${action.label} (${shortcutLabel(action.shortcut)})` : action.label}
      {description && <span className="block">{description}</span>}
    </>
  )
}

/** Asks an action's button in this editor to open its choices (its shortcut chose to). */
const CHOOSE = "rp-text-action-choose"

/** The focused element, inside a code editor's shadow root too. */
const focusedElement = () => {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active instanceof HTMLElement ? active : null
}

function ActionButton({ action, context }: { action: TextAction; context: TextActionContext }) {
  // Open with the text as it was when it opened; the editor to give focus back to.
  const [chosen, setChosen] = useState<TextActionContext | null>(null)
  const editor = useRef<HTMLElement | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const Choices = action.choices
  const choose = () => {
    editor.current = focusedElement()
    setChosen(context)
  }
  // Re-subscribed each render, so a shortcut chooses with the text as it is now.
  useEffect(() => {
    const node = button.current
    if (!node || !Choices) return
    const listener = () => choose()
    node.addEventListener(CHOOSE, listener)
    return () => node.removeEventListener(CHOOSE, listener)
  })
  const disabled = !action.available(context)
  const trigger = (
    <Tooltip
      label={
        disabled
          ? (action.unavailable?.(context) ?? "This action is unavailable for this text.")
          : describe(action, context)
      }
    >
      <button
        ref={button}
        type="button"
        data-text-action={action.id}
        aria-disabled={disabled || undefined}
        aria-label={action.label}
        aria-description={
          disabled
            ? (action.unavailable?.(context) ?? "This action is unavailable for this text.")
            : describe(action, context)
        }
        // The editor keeps its focus and selection.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!disabled && action.run(context) === "choose" && Choices) choose()
        }}
        // A context menu on a button, not over text: the browser's own stays over text.
        onContextMenu={
          Choices && !disabled
            ? (e) => {
                e.preventDefault()
                choose()
              }
            : undefined
        }
        className={`aria-disabled:opacity-40 inline-flex h-6 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus max-sm:h-8 ${
          action.icon ? "w-6 max-sm:w-8" : "px-2"
        }`}
      >
        {action.icon ? (
          <Icon name={action.icon} size={14} />
        ) : (
          <>
            <span className={action.shortLabel ? "max-sm:hidden" : ""}>{action.label}</span>
            {action.shortLabel && <span className="sm:hidden">{action.shortLabel}</span>}
          </>
        )}
      </button>
    </Tooltip>
  )
  const hint = disabled ? (
    (action.unavailable?.(context) ?? "This action is unavailable for this text.")
  ) : (
    <Explained action={action} context={context} />
  )
  if (!Choices || disabled) return <Tooltip label={hint}>{trigger}</Tooltip>
  return (
    <Menu
      trigger={trigger}
      hint={hint}
      label={action.label}
      marker="text-action"
      open={chosen !== null}
      // A click on the button is its own action, which opens the menu only when it chooses to.
      onOpenChange={(next, reason) => {
        if (!next) setChosen(null)
        else if (reason !== "trigger-press") choose()
      }}
      finalFocus={() => {
        const back = editor.current
        if (back?.isConnected) {
          back.focus()
          return false
        }
        return true
      }}
    >
      {chosen && <Choices context={chosen} done={() => setChosen(null)} />}
    </Menu>
  )
}

/** Whether focus is in an editor's own text-action menu, which counts as in the editor. */
const inActionMenu = (node: Node | null) =>
  node instanceof Element && node.closest('[data-menu="text-action"]') !== null

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
      const next = event.relatedTarget as Node | null
      if (event.currentTarget.contains(next) || inActionMenu(next)) return
      if (!pressed) return setFocused(false)
      const wrapper = event.currentTarget
      const release = () => {
        document.removeEventListener("pointerup", release, true)
        document.removeEventListener("pointercancel", release, true)
        // After the click the release makes, unless focus came back meanwhile.
        setTimeout(
          () => !wrapper.contains(document.activeElement) && !inActionMenu(document.activeElement) && setFocused(false)
        )
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
  if (hit.action.run(hit.context) === "choose")
    event.currentTarget.querySelector(`[data-text-action="${hit.action.id}"]`)?.dispatchEvent(new CustomEvent(CHOOSE))
}
