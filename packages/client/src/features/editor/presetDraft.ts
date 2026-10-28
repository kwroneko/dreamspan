import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { mainPrompt, newestMessage, presetOrder } from "@rp/shared/presetOrder.ts"
import type { EditorStore } from "./store.ts"

/** Materialize Main and the newest-message marker when editing an older virtual order. */
export function writePresetOrder(
  store: Pick<EditorStore, "value" | "setValue">,
  order: ReadonlyArray<PromptOrderEntry>
) {
  const prompts = store.value(["prompts"]) as ReadonlyArray<PresetPrompt>
  if (!prompts.some((p) => p.identifier === newestMessage.identifier))
    store.setValue(["prompts", "identifier=newestMessage"], newestMessage)
  if (!prompts.some((p) => p.identifier === "main")) store.setValue(["prompts", "identifier=main"], mainPrompt)
  store.setValue(["order"], presetOrder(prompts, order))
}
