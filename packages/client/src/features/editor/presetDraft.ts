import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { newestMessage } from "@rp/shared/presetOrder.ts"
import type { EditorStore } from "./store.ts"

/** Materialize the marker when an older revision first edits its virtual order. */
export function writePresetOrder(store: EditorStore, order: ReadonlyArray<PromptOrderEntry>) {
  const prompts = store.value(["prompts"]) as ReadonlyArray<PresetPrompt>
  if (!prompts.some((p) => p.identifier === newestMessage.identifier))
    store.setValue(["prompts", "identifier=newestMessage"], newestMessage)
  store.setValue(["order"], order)
}
