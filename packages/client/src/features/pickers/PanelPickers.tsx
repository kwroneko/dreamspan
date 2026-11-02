// The side panel's Model and Prompt preset tabs open with the composer's pickers: a dropdown
// at the very top, the current choice selected, choosing there exactly what choosing in the
// composer does (the account's selection, every chat's next reply). Mounted above each tab's
// own content, which stays the tab's.
import { Icon } from "../../ui/Icon.tsx"
import { Button } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { ChatSession } from "../chat/session.ts"
import { NEW_PRESET_HINT } from "../editor/NewPreset.tsx"
import { ConnectionsLink, ModelPickerPopover } from "./ModelPicker.tsx"
import { PresetPickerPopover, useNewPreset } from "./PresetPicker.tsx"
import { useModelSelection } from "./modelSelection.ts"
import { usePresetSelection } from "./presetSelection.ts"

/** A dropdown's trigger: the field look, the whole width up to a row of controls' (`max-w-controls`). */
const dropdown =
  "flex h-9 w-full max-w-controls min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-base text-text shadow-xs outline-none select-none hover:bg-surface-raised focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-60 sm:text-sm"

function Trigger({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <>
      <span className={`min-w-0 truncate ${muted ? "text-muted" : ""}`}>{text}</span>
      <Icon name="down" size={14} className="text-muted" />
    </>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <button type="button" disabled aria-label={`${label}: loading`} className={dropdown}>
      <Trigger text="…" muted />
    </button>
  )
}

const linkClass =
  "rounded-sm text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"

export function PresetTabPicker({ session }: { session: ChatSession }) {
  const selection = usePresetSelection(session)
  const created = useNewPreset(selection)
  const label = selection.label
  return (
    <section aria-label="Choose the prompt preset" className="mb-3 flex flex-col gap-1.5 border-b border-border pb-3">
      <div className="flex min-w-0 items-center gap-2">
        {label === null ? (
          <Loading label="Prompt preset for the next reply" />
        ) : (
          <PresetPickerPopover
            selection={selection}
            side="bottom"
            triggerClassName={dropdown}
            triggerLabel={`Prompt preset for the next reply: ${label}. Change it`}
            hint="Change the prompt preset every chat's next reply uses, as the composer's preset chip does"
            trigger={<Trigger text={selection.current?.archivedAt != null ? `${label} (archived)` : label} />}
          />
        )}
        <Tooltip label={`${NEW_PRESET_HINT}, chosen for the next reply and opened for editing`}>
          <Button onClick={created.start} aria-label="New preset">
            <Icon name="plus" size={14} />
            New
          </Button>
        </Tooltip>
      </div>
      {created.dialog}
    </section>
  )
}

export function ModelTabPicker({ session }: { session: ChatSession }) {
  const selection = useModelSelection(session)
  const { current, value, loaded, models } = selection
  const text = current ? current.label : value !== null ? "Model not found" : "Choose a model"
  return (
    <section aria-label="Choose the model" className="mb-3 flex flex-col gap-1.5 border-b border-border pb-3">
      {!loaded ? (
        <Loading label="Model for the next reply" />
      ) : (
        <ModelPickerPopover
          selection={selection}
          side="bottom"
          triggerClassName={dropdown}
          triggerLabel={current ? `Model for the next reply: ${current.label}. Change it` : "Choose a model"}
          hint="Change the model every chat's next reply uses, as the composer's model chip does"
          trigger={<Trigger text={text} muted={current === undefined} />}
        />
      )}
      {loaded && models.length === 0 ? (
        <p className="text-sm text-muted">
          No connection lists a model yet. <ConnectionsLink className={linkClass}>Add a connection…</ConnectionsLink>
        </p>
      ) : loaded && value === null ? (
        <p className="text-sm text-muted">
          No model is chosen: choose the one that writes replies. Its settings show below.
        </p>
      ) : null}
    </section>
  )
}
