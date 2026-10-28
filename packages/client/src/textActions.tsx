// Generic text-command contributions. The host dispatches shortcuts and selection actions
// from inputs, code editors and rendered text; features supply the behavior.
import { useEffect, useState, useSyncExternalStore } from "react"
import { makeRegistry } from "./registry.ts"
import { Button } from "./ui/Button.tsx"
import { textSelection, type TextSelection } from "./ui/textTargets.ts"

interface TextActionContext {
  readonly text: string
  readonly source?: "snippet" | "note"
  readonly refId?: string
}
export const textActions = makeRegistry<{
  readonly id: string
  readonly label: string
  readonly shortcut?: string
  readonly available: (context: TextActionContext) => boolean
  readonly run: (context: TextActionContext) => void
}>()
let destination: TextSelection | null = null
export const hasTextDestination = () => destination !== null
export const insertText = (text: string) => {
  if (!destination) return false
  destination.insert(text)
  return true
}

export function TextActionHost() {
  const snapshot = useSyncExternalStore(textActions.subscribe, textActions.snapshot, textActions.snapshot)
  useEffect(
    () => () => {
      destination = null
    },
    []
  )
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  useEffect(() => {
    const isTool = (e: Event) =>
      e.composedPath().some((node) => node instanceof HTMLElement && node.hasAttribute("data-text-tool"))
    const capture = (e: Event) => {
      if (isTool(e)) return
      const target = textSelection(e)
      if (target && target.editable !== false) destination = target
    }
    const selected = (e: Event) => textSelection(e)?.text || window.getSelection()?.toString() || ""
    const keys = (e: KeyboardEvent) => {
      capture(e)
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
      const context = { text: selected(e) }
      const action = snapshot.entries.find(
        (a) => a.shortcut?.toLowerCase() === e.key.toLowerCase() && a.available(context)
      )
      if (action) {
        e.preventDefault()
        action.run(context)
      }
    }
    const context = (e: MouseEvent) => {
      capture(e)
      const text = selected(e)
      if (!snapshot.entries.some((a) => a.available({ text }))) return
      e.preventDefault()
      setMenu({ x: Math.min(e.clientX, innerWidth - 220), y: Math.min(e.clientY, innerHeight - 100), text })
    }
    const close = () => setMenu(null)
    for (const name of ["focusin", "keyup", "pointerup", "select"]) document.addEventListener(name, capture)
    document.addEventListener("keydown", keys)
    document.addEventListener("contextmenu", context)
    document.addEventListener("pointerdown", close)
    return () => {
      for (const name of ["focusin", "keyup", "pointerup", "select"]) document.removeEventListener(name, capture)
      document.removeEventListener("keydown", keys)
      document.removeEventListener("contextmenu", context)
      document.removeEventListener("pointerdown", close)
    }
  }, [snapshot])
  return (
    menu && (
      <div
        data-text-tool
        role="menu"
        aria-label="Selected text"
        style={{ left: menu.x, top: menu.y }}
        className="fixed z-[100] rounded-md border border-border bg-surface p-1 text-text shadow-lg"
      >
        {snapshot.entries
          .filter((a) => a.available(menu))
          .map((action) => (
            <Button
              key={action.id}
              role="menuitem"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                action.run(menu)
                setMenu(null)
              }}
            >
              {action.label}
            </Button>
          ))}
      </div>
    )
  )
}
