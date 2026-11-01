// The preset and model pickers' bodies, registered as a plugin would register them: replacing
// `preset.picker` or `model.picker` changes the composer's chip popover and the side panel
// tab's dropdown together.
import { ModelPicker, modelPickers } from "./ModelPicker.tsx"
import { PresetPicker, presetPickers } from "./PresetPicker.tsx"

export const register = () => [
  presetPickers.register({ id: "preset.picker", order: 10, component: PresetPicker }),
  modelPickers.register({ id: "model.picker", order: 10, component: ModelPicker })
]
