// An editor shown for reading only (owner, 2026-11-23: a card on a card source opened in the
// full editor is for inspecting it): its fields show their text and scroll, and open in their
// own tabs, but nothing in them can be changed; adding the card is the way to edit it. The
// controls read this, and the store itself keeps no change (`EditorStore.readOnly`).
import { createContext, useContext } from "react"

export const EditorReadOnly = createContext(false)

/** Whether the editor around this is for reading only. */
export const useEditorReadOnly = () => useContext(EditorReadOnly)
