// The model picker: the composer's model chip and the Model tab open this same list. A filter,
// Name or Used, when each model last wrote a reply under its name, and Manage connections… at
// the end, where models come from. The body is the registered `model.picker` entry.
import { Link } from "@tanstack/react-router"
import { type ReactNode, useId, useRef, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { type PickerBodyProps, PickerList, PickerPopover, PickerSearch, pickerRowClass } from "./PickerParts.tsx"
import { MODEL_SORTS, type ModelSort, modelDetail, modelTime, modelsInOrder } from "./modelList.ts"
import type { ModelSelection } from "./modelSelection.ts"

export interface ModelPickerProps extends PickerBodyProps {
  readonly selection: ModelSelection
}

/** The registered model picker body (`model.picker`); a plugin may replace or add to it. */
export const modelPickers = defineSlot<ModelPickerProps>("model.picker")

const CONNECTIONS_HINT = "Open Settings → Connections to add a connection or change one; Back returns to this chat"

/** Where models come from: Settings → Connections, in this tab, so Back returns to the chat. */
export function ConnectionsLink({ className, children }: { className: string; children: ReactNode }) {
  return (
    <Tooltip label={CONNECTIONS_HINT}>
      <Link to="/settings/connections" className={className}>
        {children}
      </Link>
    </Tooltip>
  )
}

export function ModelPicker({ selection, focusRef, focus, onChosen }: ModelPickerProps) {
  const { prefs, change } = useViewPrefs()
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const { models, used, value } = selection
  const q = query.trim()
  const shown = modelsInOrder(prefs.modelSort, query, models, used)
  return (
    <>
      {models.length > 0 && (
        <>
          <PickerSearch
            label="Find a model"
            placeholder="Find by connection or model"
            value={query}
            onChange={setQuery}
            inputRef={focus === "search" ? focusRef : search}
            controls={listId}
          />
          <Segmented<ModelSort>
            label="Sort models"
            value={prefs.modelSort}
            onValueChange={(modelSort) => void change({ modelSort })}
            options={MODEL_SORTS}
          />
        </>
      )}
      <PickerList
        id={listId}
        title="Model"
        items={shown.map((model) => ({
          value: model.value,
          label: model.label,
          detail: modelDetail(used.get(model.value)),
          tooltip: (
            <span className="flex flex-col">
              <span>
                {model.value === value
                  ? "In use for the next reply in every chat"
                  : "Use it for the next reply in every chat"}
              </span>
              <span>{modelTime(used.get(model.value))}</span>
            </span>
          )
        }))}
        value={value ?? ""}
        onChoose={(next) => {
          onChosen()
          if (next !== value) void selection.choose(next)
        }}
        focusRef={focus === "current" ? focusRef : undefined}
        fallbackFocus={search}
        empty={
          models.length === 0
            ? "No connection lists a model yet. Add a connection, and its models show here."
            : `Nothing is called “${q}”.`
        }
      />
      <ErrorAlert error={selection.error} />
      <ConnectionsLink className={pickerRowClass}>
        <Icon name={models.length === 0 ? "plus" : "sliders"} size={14} />
        {models.length === 0 ? "Add a connection…" : "Manage connections…"}
      </ConnectionsLink>
    </>
  )
}

/** The picker in its popover, opened by `trigger`: the registered body, then the host's `footer` rows. */
export function ModelPickerPopover({
  selection,
  trigger,
  triggerLabel,
  triggerClassName,
  hint,
  side,
  footer
}: {
  selection: ModelSelection
  trigger: ReactNode
  triggerLabel: string
  triggerClassName?: string
  hint?: ReactNode
  side?: "top" | "bottom"
  footer?: (close: () => void) => ReactNode
}) {
  return (
    <PickerPopover
      title="Model"
      trigger={trigger}
      triggerLabel={triggerLabel}
      {...(triggerClassName === undefined ? {} : { triggerClassName })}
      hint={hint}
      {...(side === undefined ? {} : { side })}
      onOpen={selection.refresh}
      {...(footer === undefined ? {} : { footer })}
    >
      {(body) => <SlotOutlet slot={modelPickers} props={{ ...body, selection }} />}
    </PickerPopover>
  )
}
