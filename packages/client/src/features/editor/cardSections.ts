import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"
import type { Caller } from "./caller.ts"

/** Additional card document sections, sharing the card's draft and revision store. */
export const cardEditorSections = defineSlot<{ store: EditorStore }>("card.editor.sections")

/** A standalone lorebook's sections, sharing its draft and revision store. */
export const lorebookEditorSections = defineSlot<{ store: EditorStore; call: Caller }>("lorebook.editor.sections")
