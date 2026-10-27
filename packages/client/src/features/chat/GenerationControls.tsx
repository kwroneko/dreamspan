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
import type { ChatSession } from "./session.ts"

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
  onSettings
}: {
  session: ChatSession
  onSettings: (tab: "model" | "preset") => void
}) {
  const { action, defaults, presets } = useSelections(session)
  const models = useModelChoices(true)
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2" aria-label="Current generation settings">
        <div className="flex min-w-0 items-end gap-1">
          <div className="min-w-0 flex-1">
            <Field label="Model">
              <Select
                items={models}
                value={defaults?.model ? modelValue(defaults.model.connection, defaults.model.model) : null}
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
          <Button aria-label="Model settings" onClick={() => onSettings("model")}>
            ⚙
          </Button>
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
          <Button aria-label="Prompt preset settings" onClick={() => onSettings("preset")}>
            ⚙
          </Button>
        </div>
      </div>
      <ErrorAlert error={action.error} />
    </div>
  )
}

export function GenerationSettingsPanel({ session, kind }: { session: ChatSession; kind: "model" | "preset" }) {
  const { action, defaults } = useSelections(session)
  const [model, setModel] = useState<Model | null>(null)
  useEffect(() => {
    let live = true
    if (kind === "model" && defaults?.model)
      void action
        .run((client) => client("ListModels", { connectionId: defaults.model!.connection, includeHidden: true }))
        .then((result) => {
          if (live && result.ok) setModel(result.value.find((entry) => entry.id === defaults?.model?.model) ?? null)
        })
    return () => {
      live = false
    }
  }, [defaults?.model?.connection, defaults?.model?.model, kind]) // eslint-disable-line react-hooks/exhaustive-deps
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
  return model && model.id === defaults?.model?.model ? (
    <ModelSettingsEditor key={model.id} model={model} />
  ) : (
    <p className="text-sm text-muted">Choose a model in the composer to edit its settings.</p>
  )
}
