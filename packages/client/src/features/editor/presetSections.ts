import { defineSlot } from "../../slots.tsx"
import type { EditorStore } from "./store.ts"

/** Preset document sections after the prompt order, sharing the preset's draft and revision store. */
export const presetEditorSections = defineSlot<{ store: EditorStore }>("preset.editor.sections")

/** Warnings above the prompt document; contributions can reveal a prompt through onGoTo. */
export const presetEditorWarnings = defineSlot<{
  store: EditorStore
  onGoTo: (identifier: string) => void
}>("preset.editor.warnings")
