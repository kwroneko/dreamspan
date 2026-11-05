// What features show around an editor's text field (spec/NOTE-OVERRIDES.md §2): a view gets the
// field's store and path and renders the field through `render`, passing controls for its strip
// (`tools`), or something around it. The note-overrides feature registers one that shows a field
// a note replaces in the open chat; a plugin adds, overrides or disables views by id.
import type { FieldPath } from "@rp/shared/editing.ts"
import type { ComponentType, ReactNode } from "react"
import { makeRegistry } from "../../registry.ts"
import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"

/** What a view adds to the field it renders. */
export interface FieldViewExtra {
  /** Controls in the box's strip, before its own. */
  readonly tools?: ReactNode
  /** At the end of the label's row; a row of its own above the box when the label is hidden. */
  readonly labelEnd?: ReactNode
}

export interface FieldViewProps {
  readonly store: EditorStore
  readonly path: FieldPath
  readonly label: string
  /** The field's height in lines, for a view that shows other text in its place. */
  readonly rows?: number | undefined
  /** The field as it would be, with these added. */
  readonly render: (extra?: FieldViewExtra) => ReactNode
}

export interface FieldView {
  readonly id: string
  readonly component: ComponentType<FieldViewProps>
}

export const fieldViews = makeRegistry<FieldView>()

/**
 * A note's settings that features add, first in its settings (the note-overrides feature's
 * Replaces control, spec/NOTE-OVERRIDES.md §2.3).
 */
export const noteSettingSections = defineSlot<{
  readonly store: EditorStore
  readonly cards: ReadonlyArray<{ readonly entity: string; readonly name: string }>
}>("editor.note-settings")

/** Items features add to a note's ⋯ menu, before History (Copy its current text, say). */
export const noteMenuItems = defineSlot<{ readonly store: EditorStore; readonly title: string }>("editor.note-menu")
