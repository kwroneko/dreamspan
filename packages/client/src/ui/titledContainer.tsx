// A titled container's heading is never repeated right under it (owner, 2026-11-23: a "Created
// after" popover over a field labelled "Created after"). Popover, Dialog, ConfirmDialog, Sheet,
// InlinePanel, Disclosure and Fieldset give their title to what they hold; a Field, Fieldset,
// Checkbox, Switch, Slider, InlinePanel or Disclosure inside the nearest one whose visible label
// or heading says the same words is a mistake. In development and tests it throws, so it can't
// land; in production its label is for assistive technology only: the title names the control,
// and nothing shows twice. A single field in a titled popover passes `labelHidden`.
import { createContext, isValidElement, useContext, useMemo, type ReactNode } from "react"

const ContainerTitle = createContext<{ words: string; dedupeLabels: boolean } | null>(null)

/** Its words, lower case, punctuation and spacing aside: "Created after ?" is "created after". */
export const titleWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/** The text a node shows; text for screen readers only (`sr-only`, `aria-hidden`) doesn't count. */
export const shownText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(shownText).join(" ")
  if (isValidElement<{ children?: ReactNode; className?: unknown; "aria-hidden"?: unknown; hidden?: unknown }>(node)) {
    const props = node.props
    if (typeof props.className === "string" && /(^|\s)sr-only(\s|$)/.test(props.className)) return ""
    if (props["aria-hidden"] === true || props["aria-hidden"] === "true" || props.hidden === true) return ""
    return shownText(props.children)
  }
  return ""
}

/** Gives `title` to what it holds, as its container's name. */
export function TitledContainer({
  title,
  children,
  dedupeLabels = true
}: {
  title: ReactNode
  children: ReactNode
  dedupeLabels?: boolean
}) {
  const words = titleWords(shownText(title))
  const value = useMemo(() => (words ? { words, dedupeLabels } : null), [words, dedupeLabels])
  return <ContainerTitle.Provider value={value}>{children}</ContainerTitle.Provider>
}

/**
 * Whether the nearest titled container already shows these words as its title: for a heading
 * shown in one place (a wide side panel, with no title of its own) and repeated in another (the
 * phone's sheet, titled the same), which then names its section for assistive technology only.
 */
export function useTitledAbove(text: string): boolean {
  const title = useContext(ContainerTitle)
  return title !== null && titleWords(text) === title.words
}

/** The error a repeat raises in development and tests. */
export class TitleRepeated extends Error {
  constructor(what: string, text: string) {
    super(
      `${what} "${text}" repeats the title of the popover, dialog, sheet or panel it's in. The title names it already: pass labelHidden, or give it words of its own.`
    )
    this.name = "TitleRepeated"
  }
}

const strict = import.meta.env.DEV || import.meta.env.MODE === "test"

/**
 * Whether a visible label (or a sub-heading) repeats the nearest container's title. It throws
 * in development and tests; in production the caller shows it to assistive technology only.
 */
export function useRepeatsTitle(label: ReactNode, hidden: boolean, what: string): boolean {
  const title = useContext(ContainerTitle)
  if (hidden || !title?.dedupeLabels) return false
  const text = shownText(label)
  if (titleWords(text) !== title.words) return false
  if (strict) throw new TitleRepeated(what, text.trim())
  return true
}
