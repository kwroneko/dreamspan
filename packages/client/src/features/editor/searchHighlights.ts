import { useSyncExternalStore } from "react"
import type { FieldPath } from "@dreamspan/shared/editing.ts"
import type { EditorStore } from "./store.ts"
import type { SearchMatch } from "./searchNavigation.ts"

const empty: ReadonlyArray<SearchMatch> = []
const states = new WeakMap<EditorStore, ReturnType<typeof create>>()
function create() {
  let matches = empty
  const listeners = new Set<() => void>()
  return {
    read: () => matches,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next: ReadonlyArray<SearchMatch>) => {
      matches = next
      for (const listener of listeners) listener()
    }
  }
}
function state(store: EditorStore) {
  let value = states.get(store)
  if (!value) {
    value = create()
    states.set(store, value)
  }
  return value
}
export function setSearchHighlights(store: EditorStore, matches: ReadonlyArray<SearchMatch>) {
  state(store).set(matches)
}
export function useSearchHighlights(store: EditorStore, path: FieldPath, lines?: ReadonlyArray<string>) {
  const source = state(store)
  const matches = useSyncExternalStore(source.subscribe, source.read)
  return matches
    .flatMap((match) => {
      if (JSON.stringify(match.path) === JSON.stringify(path)) return [match]
      if (lines && JSON.stringify(match.path.slice(0, -1)) === JSON.stringify(path)) {
        const index = Number(match.path.at(-1))
        return [
          { ...match, at: match.at + lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0) }
        ]
      }
      return []
    })
    .sort((a, b) => a.at - b.at)
}
