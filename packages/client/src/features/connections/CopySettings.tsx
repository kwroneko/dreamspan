// "Copy settings from…": the app's model picker, across connections; choosing a model hands its
// stored overrides to the form, which fills itself from them without saving.
import type { Model } from "@dreamspan/shared/providers.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { modelValue, parseModelValue, useModelChoiceList } from "../chat/modelChoices.ts"
import { ModelPickerPopover } from "../pickers/ModelPicker.tsx"
import { type ModelSelection, useModelUse } from "../pickers/modelSelection.ts"

export function CopySettingsButton({
  model,
  label = "Copy settings from…",
  hint = "Fill this form with another model’s settings: reasoning, lengths, samplers, stop strings and extra parameters. Nothing is saved until you press Save.",
  onCopy
}: {
  /** The model being edited: not offered as a source. None: every model is. */
  model?: Model
  label?: string
  hint?: string
  /** The chosen model, as stored, and its name as the picker lists it. */
  onCopy: (source: Model, label: string) => void
}) {
  const load = useAction()
  const { used, refresh } = useModelUse()
  const { choices, loaded } = useModelChoiceList(true)
  const own = model ? modelValue(model.connectionId, model.id) : null
  const selection: ModelSelection = {
    loaded,
    value: null,
    current: undefined,
    models: choices.filter((choice) => choice.value !== own),
    used,
    choose: async (value) => {
      const { connection, model: id } = parseModelValue(value)
      const result = await load.run((client) => client("ListModels", { connectionId: connection, includeHidden: true }))
      const source = result.ok ? result.value.find((entry) => entry.id === id) : undefined
      if (!source) return false
      onCopy(source, choices.find((choice) => choice.value === value)?.label ?? source.key)
      return true
    },
    refresh,
    error: load.error
  }
  return (
    <div className="flex flex-col gap-2">
      <ModelPickerPopover
        selection={selection}
        trigger={
          <>
            <Icon name="copy" size={14} />
            {label}
          </>
        }
        triggerLabel="Copy settings from another model"
        hint={hint}
        side="bottom"
      />
      <ErrorAlert error={load.error} />
    </div>
  )
}
