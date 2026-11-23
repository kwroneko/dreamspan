// The composition scratchpad's view (DESIGN §3.1; composition.ts): while the user writes their
// own version of a message, the version shown stays above the editor, in a box whose bar
// steps through the versions and adds the version's text, or the passage selected in it, to
// the end of their version (or to a snippet: the same registered text actions an editor's
// own strip has). The bar is above the text, so stepping to a longer or shorter version never
// moves it. The browser's own menu stays over the text.
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react"
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import { EditorTextActions, type OwnVersionTarget } from "../../textActions.tsx"
import { selectedSourceText } from "../../ui/messageCopy.tsx"
import { keepInPlace } from "../../ui/reveal.ts"
import { LET_GO, registerComposition } from "./composition.ts"
import type { MessageDraft } from "./messageDraft.ts"
import { positionOf } from "./position.ts"

/**
 * The stored text of what's selected in `body`, "" when nothing is. A press on the bar (one of
 * its buttons) keeps it: a tap can collapse the selection before the button's click lands.
 */
function useSelectedText(body: RefObject<HTMLElement | null>, bar: RefObject<HTMLElement | null>) {
  const [text, setText] = useState("")
  useEffect(() => {
    let onBar = false
    const down = (event: PointerEvent) => {
      onBar = event.target instanceof Node && (bar.current?.contains(event.target) ?? false)
    }
    const change = () => {
      const element = body.current
      const selection = document.getSelection()
      if (!element || !selection) return
      if (selection.rangeCount === 0 || selection.isCollapsed) {
        if (!onBar) setText("")
        return
      }
      setText(selectedSourceText(selection.getRangeAt(0), element) ?? "")
    }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("selectionchange", change)
    change()
    return () => {
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("selectionchange", change)
    }
  }, [body, bar])
  return text
}

export function Composition({
  entry,
  draft,
  text,
  versions,
  source,
  children
}: {
  entry: PathEntry
  /** The user's own version: the slot's "Write your own version" draft. */
  draft: MessageDraft
  /** The stored text of the version shown. */
  text: string
  /** The message's version controls, in the bar while composing. */
  versions: ReactNode
  /** The version shown, as the chat shows it. */
  source: ReactNode
  /** The editor of the user's own version. */
  children: ReactNode
}) {
  const around = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const selection = useSelectedText(body, bar)
  const n = positionOf(entry) + 1
  const target = useMemo<OwnVersionTarget>(
    () => ({ name: `message #${n}`, add: (added) => void draft.append(added) }),
    [draft, n]
  )
  // Where a snippet's Add to your version goes: the composition used last that still shows.
  const used = useRef<() => void>(() => {})
  useEffect(() => {
    if (!around.current) return
    const shown = registerComposition(around.current, target)
    used.current = shown.use
    return shown.forget
  }, [target])
  const keep = () => {
    const node = bar.current
    if (!node) return
    node.dispatchEvent(new CustomEvent(LET_GO, { bubbles: true }))
    keepInPlace(node)
  }
  return (
    <div
      ref={around}
      data-composition
      className="flex flex-col gap-2"
      onPointerDown={() => used.current()}
      onFocus={() => used.current()}
    >
      <section
        aria-label="Swipe shown"
        data-composition-source
        className="flex min-w-0 flex-col rounded-md border border-border"
      >
        <div
          ref={bar}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border p-2"
          // Another version shown is another length: the bar, and the arrow pressed, stay put.
          // The version picker's list is a portal; its presses reach here through React.
          onPointerDownCapture={keep}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" || event.key === " ") keep()
          }}
        >
          {versions}
          <span className="flex-1" />
          <EditorTextActions text={text} selection={selection} shown scope={{ ownVersion: target }} size="row" />
        </div>
        <div ref={body} className="min-w-0 px-3 py-2">
          {source}
        </div>
      </section>
      {children}
    </div>
  )
}
