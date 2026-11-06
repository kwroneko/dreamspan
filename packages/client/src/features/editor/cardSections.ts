import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"
import type { Caller } from "./caller.ts"

/** Sections at the end of the card's Definition tab, about its prompt fields, sharing its store. */
export const cardDefinitionSections = defineSlot<{ store: EditorStore }>("card.editor.definition-sections")

/** Additional card document sections, sharing the card's draft and revision store. */
export const cardEditorSections = defineSlot<{ store: EditorStore; call: Caller }>("card.editor.sections")

/**
 * The card's own lorebook section in `cardEditorSections`. A card's book is part of the card
 * document (`character_book`), saved and exported with it, so opening the book is the card's
 * editor with `focus: CARD_LOREBOOK_FOCUS`, which shows this section alone.
 */
export const CARD_LOREBOOK_SECTION = "card.embedded-lorebook"
/** The editor focus that opens a card on its own lorebook (`Editor`'s `focus`, `?focus=` on its page). */
export const CARD_LOREBOOK_FOCUS = "lorebook"

/** A standalone lorebook's sections, sharing its draft and revision store. */
export const lorebookEditorSections = defineSlot<{ store: EditorStore; call: Caller }>("lorebook.editor.sections")
