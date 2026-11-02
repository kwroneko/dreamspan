import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { mainPrompt, newestMessage, presetOrder } from "@rp/shared/presetOrder.ts"
import type { EditorStore } from "./store.ts"

/** Materialize Main and the newest-message marker when editing an older virtual order. */
const withMarkers = (store: Pick<EditorStore, "value" | "setValue">) => {
  const prompts = store.value(["prompts"]) as ReadonlyArray<PresetPrompt>
  if (!prompts.some((p) => p.identifier === newestMessage.identifier))
    store.setValue(["prompts", "identifier=newestMessage"], newestMessage)
  if (!prompts.some((p) => p.identifier === "main")) store.setValue(["prompts", "identifier=main"], mainPrompt)
  return prompts
}

export function writePresetOrder(
  store: Pick<EditorStore, "value" | "setValue">,
  order: ReadonlyArray<PromptOrderEntry>
) {
  store.setValue(["order"], presetOrder(withMarkers(store), order))
}

/** Adds `prompt` where `order` puts it, behind the unsaved bar (EditorStore.addPrompt). */
export function addPresetPrompt(
  store: Pick<EditorStore, "value" | "setValue" | "addPrompt">,
  prompt: PresetPrompt,
  order: ReadonlyArray<PromptOrderEntry>
) {
  const prompts = withMarkers(store).filter((p) => p.identifier !== prompt.identifier)
  store.addPrompt(prompt, presetOrder([...prompts, prompt], order))
}
