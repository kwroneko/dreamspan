// Account selections: the strip's model and preset chips, and their side panel tabs.
import { BUILTIN_PRESET_LABEL, type GenerationDefaults } from "@rp/shared/generation.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { Model } from "@rp/shared/providers.ts"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { ModelSettingsEditor } from "../connections/models.tsx"
import { Editor } from "../editor/EditorPage.tsx"
import { modelValue, parseModelValue, useModelChoiceList } from "./modelChoices.ts"
import type { ChatSession, ChatView } from "./session.ts"
import { useIsPanelTab } from "./panels.tsx"
import { ChipText, ChoiceChip, LoadingChip, PopoverRow } from "./nextReplyStrip.tsx"

function useSelections(session: ChatSession) {
  const action = useAction()
  const [defaults, setDefaults] = useState<GenerationDefaults | null>(null)
  const [presets, setPresets] = useState<ReadonlyArray<LibraryRef>>([])
  useEffect(() => {
    let live = true
    const refresh = () => {
      void action
        .run((client) =>
          Effect.all({
            defaults: client("GetGenerationDefaults", undefined),
            presets: client("ListLibrary", { kind: "preset" })
          })
        )
        .then((result) => {
          if (live && result.ok) {
            setDefaults(result.value.defaults)
            setPresets(result.value.presets)
          }
        })
    }
    const unsubscribe = session.subscribeContext(refresh)
    refresh()
    return () => {
      live = false
      unsubscribe()
    }
  }, [session]) // eslint-disable-line react-hooks/exhaustive-deps
  return { action, defaults, presets }
}

/**
 * The next-reply strip's model chip: the account's model, which every chat's next reply uses
 * (DESIGN §2.2: switched here, its settings in the side panel). "…" until both it and the
 * model list are read, so "Choose a model" never flashes before the real one.
 */
export function ModelChip({
  session,
  view,
  onSettings
}: {
  session: ChatSession
  view: ChatView
  onSettings: (tab: "model") => void
}) {
  const modelPanel = useIsPanelTab("model", view)
  const { action, defaults } = useSelections(session)
  const current = defaults?.model ? modelValue(defaults.model.connection, defaults.model.model) : null
  const { choices: models, loaded } = useModelChoiceList(true, current)
  const chosen = models.find((model) => model.value === current)
  if (view.loading || defaults === null || !loaded) return <LoadingChip label="Model" />
  // A model no list has (its connection gone, say) says so, and the chip still opens to choose one.
  const short = chosen
    ? chosen.label.slice(chosen.label.indexOf(" · ") + 3)
    : current !== null
      ? "Model not found"
      : "Choose a model"
  return (
    <>
      <ChoiceChip
        label={chosen ? `Model: ${chosen.label}. Change the model` : "Choose a model"}
        hint={
          chosen
            ? `Model for the next reply: ${chosen.label}`
            : current !== null
              ? "Your model isn't in any connection's list now: choose another"
              : "No model chosen yet"
        }
        title="Model"
        chip={<ChipText>{short}</ChipText>}
        choices={models}
        value={current ?? ""}
        onChoose={(value) =>
          void action.run(
            (client) => client("ChangeGenerationDefaults", { change: { model: parseModelValue(value) } }),
            ["settings"]
          )
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
      <ErrorAlert error={action.error} />
    </>
  )
}

/** The next-reply strip's prompt preset chip, with "Edit preset…" opening it in the side panel. */
export function PresetChip({
  session,
  view,
  onSettings
}: {
  session: ChatSession
  view: ChatView
  onSettings: (tab: "preset") => void
}) {
  const presetPanel = useIsPanelTab("preset", view)
  const { action, defaults, presets } = useSelections(session)
  const value = defaults?.preset ?? "builtin"
  const choices = [
    { value: "builtin", label: BUILTIN_PRESET_LABEL },
    ...presets.map((preset) => ({ value: preset.id as string, label: preset.label }))
  ]
  const chosen = choices.find((choice) => choice.value === value)
  if (view.loading || defaults === null || chosen === undefined) return <LoadingChip label="Prompt preset" />
  return (
    <>
      <ChoiceChip
        label={`Prompt preset: ${chosen.label}. Change the preset`}
        hint={`Prompt preset for the next reply: ${chosen.label}`}
        title="Prompt preset"
        chip={<ChipText>{chosen.label}</ChipText>}
        choices={choices}
        value={value}
        onChoose={(next) =>
          void action.run(
            (client) =>
              client("ChangeGenerationDefaults", {
                change: { preset: next === "builtin" ? null : (next as LibraryRef["id"]) }
              }),
            ["settings"]
          )
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
      <ErrorAlert error={action.error} />
    </>
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
  const [model, setModel] = useState<Model | null>(null)
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
        <Link to="/import" className="text-accent">
          Import page
        </Link>{" "}
        to edit your own.
      </p>
    )
  if (!model || model.id !== target?.model)
    return <p className="text-sm text-muted">Choose a model in the composer to edit its settings.</p>
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
            ? "The model this chat is bound to. "
            : "The model this chat's next reply uses: your current model, shared by every chat. "}
          Its settings apply everywhere it is used.
        </p>
      </div>
      <ModelSettingsEditor key={model.id} model={model} onSaved={() => setSaves((n) => n + 1)} />
    </div>
  )
}
