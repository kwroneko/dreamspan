// Account selections and their small panel integration. Unit E can move the panel shell.
import { BUILTIN_PRESET_LABEL, type GenerationDefaults } from "@rp/shared/generation.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { Model } from "@rp/shared/providers.ts"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { ModelSettingsEditor } from "../connections/models.tsx"
import { Editor } from "../editor/EditorPage.tsx"
import { modelValue, parseModelValue, useModelChoices } from "./modelChoices.ts"
import type { ChatSession, ChatView } from "./session.ts"
import { useIsPanelTab } from "./panels.tsx"

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

export function GenerationControls({
  session,
  view,
  onSettings
}: {
  session: ChatSession
  view: ChatView
  onSettings: (tab: "model" | "preset") => void
}) {
  const modelPanel = useIsPanelTab("model", view)
  const presetPanel = useIsPanelTab("preset", view)
  const { action, defaults, presets } = useSelections(session)
  const current = defaults?.model ? modelValue(defaults.model.connection, defaults.model.model) : null
  const models = useModelChoices(true, current)
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2" aria-label="Current generation settings">
        <div className="flex min-w-0 items-end gap-1">
          <div className="min-w-0 flex-1">
            <Field label="Model">
              <Select
                items={models}
                value={current}
                placeholder="Choose a model"
                onValueChange={(value) =>
                  void action.run(
                    (client) => client("ChangeGenerationDefaults", { change: { model: parseModelValue(value) } }),
                    ["settings"]
                  )
                }
              />
            </Field>
          </div>
          {modelPanel && (
            <Button
              aria-label="Model settings"
              title={view.history?.model?.modelKey ? `Settings for ${view.history.model.modelKey}` : undefined}
              onClick={() => onSettings("model")}
            >
              ⚙
            </Button>
          )}
        </div>
        <div className="flex min-w-0 items-end gap-1">
          <div className="min-w-0 flex-1">
            <Field label="Prompt preset">
              <Select
                items={[
                  { value: "builtin", label: BUILTIN_PRESET_LABEL },
                  ...presets.map((preset) => ({ value: preset.id as string, label: preset.label }))
                ]}
                value={defaults?.preset ?? "builtin"}
                onValueChange={(value) =>
                  void action.run(
                    (client) =>
                      client("ChangeGenerationDefaults", {
                        change: { preset: value === "builtin" ? null : (value as LibraryRef["id"]) }
                      }),
                    ["settings"]
                  )
                }
              />
            </Field>
          </div>
          {presetPanel && (
            <Button aria-label="Prompt preset settings" onClick={() => onSettings("preset")}>
              ⚙
            </Button>
          )}
        </div>
      </div>
      <ErrorAlert error={action.error} />
    </div>
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
