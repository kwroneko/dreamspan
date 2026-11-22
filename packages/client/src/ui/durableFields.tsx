// What the UI's own text boxes keep across a reload (InlineRename): the text typed and whether
// the box is open. The app provides the durable versions (features/editor/durable.tsx, with
// the account's drafts and the URL); outside it (a test, a page without an account) both
// are ordinary component state.
import { createContext, useContext, useState } from "react"

export interface DurableText {
  readonly text: string
  /** Until the kept text is read, the box is read-only. */
  readonly ready: boolean
  readonly setText: (text: string) => void
  /** The text was saved: what was kept goes. */
  readonly commit: () => void
  /** The text was given up (Cancel): what was kept ends as discarded. */
  readonly discard: () => void
}

export interface DurableFields {
  /** The text typed under `key`, starting from `saved`. */
  readonly useText: (key: string, field: string, saved: string) => DurableText
  /** Whether `id` is open. */
  readonly useOpen: (id: string) => readonly [boolean, (open: boolean) => void]
}

function useLocalText(_key: string, _field: string, saved: string): DurableText {
  const [typed, setTyped] = useState<string | null>(null)
  return {
    text: typed ?? saved,
    ready: true,
    setText: setTyped,
    commit: () => setTyped(null),
    discard: () => setTyped(null)
  }
}

function useLocalOpen(_id: string) {
  return useState(false)
}

const local: DurableFields = { useText: useLocalText, useOpen: useLocalOpen }

export const DurableFieldsContext = createContext<DurableFields>(local)

export const useDurableFields = () => useContext(DurableFieldsContext)
