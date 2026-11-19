import type { FieldPath } from "@dreamspan/shared/editing.ts"
import { createContext, useContext } from "react"

/** A fresh object for each visit, including repeated visits to the same match. */
export interface SearchMatch {
  readonly path: FieldPath
  readonly at: number
  readonly length: number
}

export const SearchNavigation = createContext<SearchMatch | null>(null)

export function useSearchMatch(path: FieldPath) {
  const match = useContext(SearchNavigation)
  return match && JSON.stringify(match.path) === JSON.stringify(path) ? match : undefined
}

/** Keep the field below the editor's measured sticky toolbar, also in the chat overlay. */
export function scrollToSearchField(target: HTMLElement, top = target.getBoundingClientRect().top) {
  target.style.scrollMarginTop = "var(--preset-toolbar-height, 1rem)"
  const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0
  const scroll = target.closest<HTMLElement>("[data-preset-scroll]")
  if (scroll) {
    scroll.scrollTop += top - scroll.getBoundingClientRect().top - margin
  } else {
    const scrollParent = target.closest<HTMLElement>("main")
    if (scrollParent && scrollParent.scrollHeight > scrollParent.clientHeight)
      scrollParent.scrollTop += top - scrollParent.getBoundingClientRect().top - margin
    else window.scrollBy(0, top - margin)
  }
}
