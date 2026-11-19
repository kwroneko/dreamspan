// Places in every library editor, full and side-panel alike, that features add to.
import type { Revision } from "@dreamspan/shared/library.ts"
import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"

/** Notices under an editor's actions: the full editor's and each side-panel editor's. */
export const editorNotices = defineSlot<{ store: EditorStore }>("editor.notices")

/** Document actions beside History in the full editor (the side panels use `panelEditorActions`). */
export const editorActions = defineSlot<{ store: EditorStore }>("editor.actions")

/** Actions beside a revision's Restore in History. */
export const revisionActions = defineSlot<{ store: EditorStore; revision: Revision }>("editor.revision.actions")
