// The card editor's tabs (owner, 2026-11-01: "the fields divided into tabs instead of one
// linear page"), the same in the chat's character tab (sub-tabs, a narrow column) and the full
// editor (a wide page). Each tab is a registered part: a plugin can add one, replace one or
// disable one, as with every other slot (spec/PLUGINS.md §8). The built-ins register in
// `index.tsx`: Definition, Greetings, Metadata, Lorebook, Notes and Extra.
import type { ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import type { Caller } from "./caller.ts"
import type { EditorStore } from "./store.ts"

export interface CardTabProps {
  readonly store: EditorStore
  readonly call: Caller
  /** The chat's side panel (a narrow column) or the full editor (a wide page). */
  readonly layout: "panel" | "page"
  /** Opens the card's own lorebook in the large editor (the full editor's book view). */
  readonly onOpenBook?: (() => void) | undefined
}

export interface CardTab {
  readonly id: string
  readonly order: number
  readonly label: string
  /** What the tab holds, on hover and focus. */
  readonly description: string
  readonly component: ComponentType<CardTabProps>
}

export const cardEditorTabs = makeRegistry<CardTab>()

export const CARD_TAB_DEFINITION = "card.definition"
export const CARD_TAB_GREETINGS = "card.greetings"
export const CARD_TAB_METADATA = "card.metadata"
export const CARD_TAB_LOREBOOK = "card.lorebook"
export const CARD_TAB_NOTES = "card.notes"
export const CARD_TAB_EXTRA = "card.extra"
