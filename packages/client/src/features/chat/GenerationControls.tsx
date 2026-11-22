import { Tooltip } from "../../ui/Tooltip.tsx"
// Account selections: the strip's model and preset chips, and their side panel tabs.
import { BUILTIN_PRESET_LABEL, type GenerationDefaults } from "@dreamspan/shared/generation.ts"
import type { Model } from "@dreamspan/shared/providers.ts"
import { Icon } from "../../ui/Icon.tsx"
import { Link } from "@tanstack/react-router"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import { ModelSettingsEditor } from "../connections/models.tsx"
import { Editor } from "../editor/EditorPage.tsx"
import type { ChatSession, ChatView } from "./session.ts"
import { useIsPanelTab } from "./panels.tsx"
import { ChipText, chipClass, LoadingChip, PopoverRow } from "./nextReplyStrip.tsx"
import { ModelPickerPopover } from "../pickers/ModelPicker.tsx"
import { PresetPickerPopover } from "../pickers/PresetPicker.tsx"
import { useModelSelection } from "../pickers/modelSelection.ts"
import { usePresetSelection } from "../pickers/presetSelection.ts"
import { defaultsAtom, useRefreshOnContext } from "../pickers/defaults.ts"

/** The account's selections, as the pickers read them (refreshed when the chat's context changes). */
function useSelections(session: ChatSession) {
  const action = useAction()
  const result = useAtomValue(defaultsAtom)
  useRefreshOnContext(session, defaultsAtom)
  const defaults: GenerationDefaults | null = AsyncResult.isSuccess(result) ? result.value : null
  return { action, defaults }
}

/**
 * The next-reply strip's model chip: the chat lock, or the account's model
 * (DESIGN §2.2: switched here, its settings in the side panel). "…" until both it and the
 * model list are read, so "Choose a model" never flashes before the real one. Its popover is
 * the shared model picker (`features/pickers`), as the Model tab's.
 */
export function ModelChip({
  session,
  view,
  onSettings
}: {
  /** Null in a chat not made yet: the model follows the account. */
  session: ChatSession | null
  view: ChatView
  onSettings: (tab: "model") => void
}) {
  const modelPanel = useIsPanelTab("model", view)
  const selection = useModelSelection(session)
  const { current: chosen, value: current, loaded } = selection
  if (view.loading || !loaded) return <LoadingChip label="Model" />
  // A model no list has (its connection gone, say) says so, and the chip still opens to choose one.
  const short = chosen
    ? chosen.label.slice(chosen.label.indexOf(" · ") + 3)
    : current !== null
      ? "Model not found"
      : "Choose a model"
  return (
    <ModelPickerPopover
      selection={selection}
      triggerLabel={chosen ? `Model: ${chosen.label}. Change the model` : "Choose a model"}
      hint={
        chosen
          ? `Model for the next reply: ${chosen.label}`
          : current !== null
            ? "Your model isn't in any connection's list now: choose another"
            : "No model chosen yet"
      }
      triggerClassName={chipClass()}
      trigger={
        <>
          {selection.lock?.locked && (
            <span role="img" aria-label="Model locked for this chat">
              <Icon name="lock" size={12} />
            </span>
          )}
          <ChipText>{short}</ChipText>
        </>
      }
      {...(modelPanel
        ? {
            footer: (close: () => void) => (
              <PopoverRow
                onClick={() => {
                  close()
                  onSettings("model")
                }}
              >
                Model settings…
              </PopoverRow>
            )
          }
        : {})}
    />
  )
}

/**
 * The next-reply strip's prompt preset chip, with "Edit preset…" opening it in the side panel.
 * Its popover is the shared preset picker (`features/pickers`), as the Prompt preset tab's.
 */
export function PresetChip({
  session,
  view,
  onSettings
}: {
  session: ChatSession | null
  view: ChatView
  onSettings: (tab: "preset") => void
}) {
  const presetPanel = useIsPanelTab("preset", view)
  const selection = usePresetSelection(session)
  const label = selection.label
  if (view.loading || label === null) return <LoadingChip label="Prompt preset" />
  return (
    <PresetPickerPopover
      place="composer"
      selection={selection}
      triggerLabel={`Prompt preset: ${label}. Change the preset`}
      hint={`Prompt preset for the next reply: ${label}`}
      triggerClassName={chipClass()}
      trigger={
        <>
          {selection.lock?.locked && (
            <span role="img" aria-label="Preset locked for this chat">
              <Icon name="lock" size={12} />
            </span>
          )}
          <ChipText>{label}</ChipText>
        </>
      }
      {...(presetPanel
        ? {
            footer: (close: () => void) => (
              <PopoverRow
                onClick={() => {
                  close()
                  onSettings("preset")
                }}
              >
                Edit preset…
              </PopoverRow>
            )
          }
        : {})}
    />
  )
}

/**
 * The Model tab edits the model the chat's next reply actually uses (the next-context estimate's
 * model, the same one the budget note and the refusal open), named at the top; before the
 * estimate arrives, the account's current model.
 */
export function GenerationSettingsPanel({
  session,
  view,
  kind
}: {
  session: ChatSession
  view: ChatView
  kind: "model" | "preset"
}) {
  const { action, defaults } = useSelections(session)
  const used = view.history?.model
  const target = used
    ? { connection: used.connection, model: used.model }
    : defaults?.model
      ? { connection: defaults.model.connection, model: defaults.model.model }
      : null
  // Undefined while it's read; null when its connection doesn't list it.
  const [model, setModel] = useState<Model | null | undefined>(undefined)
  // Bumped after a save, so the name above the form shows what was saved.
  const [saves, setSaves] = useState(0)
  useEffect(() => {
    let live = true
    if (kind === "model" && target)
      void action
        .run((client) =>
          client("ListModels", { connectionId: target.connection as Model["connectionId"], includeHidden: true })
        )
        .then((result) => {
          if (live && result.ok) setModel(result.value.find((entry) => entry.id === target.model) ?? null)
        })
    return () => {
      live = false
    }
  }, [target?.connection, target?.model, kind, saves]) // eslint-disable-line react-hooks/exhaustive-deps
  if (kind === "preset")
    return defaults?.preset ? (
      <Editor key={defaults.preset} refId={defaults.preset} />
    ) : (
      <p className="text-sm text-muted">
        {BUILTIN_PRESET_LABEL} is the built-in prompt preset. Import a prompt preset from the{" "}
        <Tooltip label="Opens the import page.">
          <Link to="/import" className="text-accent">
            Import page
          </Link>
        </Tooltip>{" "}
        to edit your own.
      </p>
    )
  // With none chosen, the picker above the tab is its content (pickers/PanelPickers.tsx).
  if (!target) return null
  if (model === null)
    return <p className="text-sm text-muted">This model isn't in its connection's list now: choose another above.</p>
  if (!model || model.id !== target.model)
    return (
      <p role="status" className="text-sm text-muted">
        Loading the model's settings…
      </p>
    )
  const connectionName = used?.connectionName ?? null
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-medium [overflow-wrap:anywhere]" data-testid="model-panel-name">
          {model.overrides.name ?? model.upstream.name ?? model.key}
          {connectionName && <span className="font-normal text-muted"> on {connectionName}</span>}
        </p>
        <p className="text-xs text-muted">
          {used?.scope === "chat"
            ? "This chat keeps this model when you change it elsewhere."
            : "Your current model for chats without a lock."}
        </p>
      </div>
      <ModelSettingsEditor key={model.id} model={model} onSaved={() => setSaves((n) => n + 1)} />
    </div>
  )
}
