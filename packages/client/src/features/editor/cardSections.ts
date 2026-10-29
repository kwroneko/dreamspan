import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"

/** Additional card document sections, sharing the card's draft and revision store. */
export const cardEditorSections = defineSlot<{ store: EditorStore }>("card.editor.sections")
