// The composition scratchpad (DESIGN §3.1): the user's own version of a message, written while
// its other versions stay in view, from passages picked out of them and out of snippets. Its
// text is the slot's "Write your own version" draft (messageDraft.ts, `scratchpad`), so it
// persists like any draft and becomes a version with "Add as a new version".
//
// The compositions on screen, most recently used first: text added from outside a message (a
// snippet's editor) goes to the first of them still shown, as Send text to snippet goes to the
// snippet shown (features/snippets/workspace.ts).
import type { OwnVersionTarget } from "../../textActions.tsx"

interface Shown {
  readonly element: HTMLElement
  readonly target: OwnVersionTarget
}

/** The compositions shown, most recent first: opened, clicked or typed into. */
let used: ReadonlyArray<Shown> = []

/** A composition's element while it shows: made last, it's the one used last. */
export const registerComposition = (element: HTMLElement, target: OwnVersionTarget) => {
  const item = { element, target }
  used = [item, ...used]
  return {
    use: () => {
      if (used[0] !== item && used.includes(item)) used = [item, ...used.filter((other) => other !== item)]
    },
    forget: () => {
      used = used.filter((other) => other !== item)
    }
  }
}

const visible = (element: HTMLElement) =>
  element.isConnected && (typeof element.checkVisibility !== "function" || element.checkVisibility())

/** Where text added from outside a message goes: the composition used last that still shows. */
export const compositionTarget = (): OwnVersionTarget | null =>
  used.find((item) => visible(item.element))?.target ?? null

/** Text added to the end of a composition: a blank line after what's there, as Send text to snippet does. */
export const appended = (current: string, text: string) => {
  const kept = current.replace(/\n*$/, "")
  const next = kept === "" ? text : `${kept}\n\n${text}`
  return { next, at: next.length - text.length, length: text.length }
}
