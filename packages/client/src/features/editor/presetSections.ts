import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"

/** Preset document sections after the prompt order, sharing the preset's draft and revision store. */
export const presetEditorSections = defineSlot<{ store: EditorStore }>("preset.editor.sections")
