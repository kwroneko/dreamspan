// The pickers' bodies, registered as a plugin would register them: replacing `preset.picker`
// or `model.picker` changes the composer's chip popover and the side panel tab's dropdown
// together (and `preset.picker` the preset editor's header switcher too); `card.picker` and
// `document.picker` are the other editors' header switchers.
import { CardPicker, DocumentPicker, cardPickers, documentPickers } from "./DocumentPickers.tsx"
import { ModelPicker, modelPickers } from "./ModelPicker.tsx"
import { PresetPicker, presetPickers } from "./PresetPicker.tsx"

export const register = () => [
  presetPickers.register({ id: "preset.picker", order: 10, component: PresetPicker }),
  modelPickers.register({ id: "model.picker", order: 10, component: ModelPicker }),
  cardPickers.register({ id: "card.picker", order: 10, component: CardPicker }),
  documentPickers.register({ id: "document.picker", order: 10, component: DocumentPicker })
]
