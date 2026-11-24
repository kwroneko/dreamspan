// "Edit N…" on a connection's model list (owner, 2026-11-23): the model settings form for the
// selected models at once, modelled on the lorebook's mass edit. Each field has a tick: only the
// ticked fields are saved, on every selected model, in one change. Editing a field ticks it;
// unticking leaves it as each model has it. Copy settings from a model fills and ticks every
// field that model sets. A toast offers Undo, which puts back what the changed models had.
import { type ModelPatches, type ModelPatchResult } from "@dreamspan/shared/modelPatch.ts"
import { type Model, type ModelId, ModelOverrides } from "@dreamspan/shared/providers.ts"
import { Schema } from "effect"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDurableForm } from "../editor/durable.tsx"
import { MassRow, MixedMarker } from "../editor/LorebookMassEdit.tsx"
import { CopySettingsButton } from "./CopySettings.tsx"
import {
  biasRowProblem,
  commonOf,
  copyFields,
  draftProblems,
  FIELD_IDS,
  type FieldId,
  fieldsChanged,
  fieldsSet,
  massPatches,
  MODEL_FIELDS,
  wholeText,
  wouldChange
} from "./modelFields.ts"
import { type Draft, readDraft } from "./modelForm.ts"
import { effectiveLimits, ModelFields } from "./ModelSettingsEditor.tsx"

const modelsLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? "model" : "models"}`

/** A short name for a selection of models: the dialog's place in the URL and its draft's key. */
export const selectionDigest = (ids: ReadonlyArray<string>) => {
  let hash = 0x811c9dc5
  for (const char of [...ids].sort().join(",")) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${ids.length}-${hash.toString(36)}`
}

/** What the dialog keeps as typed: the models it edits, the ticked fields, and the form's draft. */
interface MassForm {
  readonly ids: ReadonlyArray<ModelId>
  readonly ticked: ReadonlyArray<FieldId>
  /**
   * The form's draft, once edited; until then, what the models share. Kept as an object, so a
   * save from another tab merges field by field (text: a draft kept before that change).
   */
  readonly draft: Draft | string | null
}

/** A field beside its tick, and the mark that says the models differ in it. */
function Ticked({
  field,
  ticked,
  mixed,
  onTick,
  children
}: {
  field: FieldId
  ticked: boolean
  mixed: string | undefined
  onTick: (ticked: boolean) => void
  children: ReactNode
}) {
  return (
    <MassRow
      data-mass-field={field}
      data-ticked={ticked ? "" : undefined}
      marker={mixed && <MixedMarker items="models" breakdown={mixed} />}
      tick={
        <Tooltip
          label={
            ticked
              ? "Saved on every selected model. Untick to leave it as each model has it."
              : "Left as each model has it. Tick it, or change it, to save it on every selected model."
          }
        >
          <span className="inline-flex">
            <Checkbox labelHidden checked={ticked} onCheckedChange={onTick}>
              {`Change ${MODEL_FIELDS[field].label}`}
            </Checkbox>
          </span>
        </Tooltip>
      }
    >
      {children}
    </MassRow>
  )
}

export function ModelMassEditDialog({
  place,
  ids,
  models,
  onClose
}: {
  /** The dialog's place (`selectionDigest`): its draft's key. */
  place: string
  /** The models chosen, when the table knows them; after a reload, they come from the draft. */
  ids: ReadonlyArray<ModelId> | null
  /** Every model on the connection, as listed. */
  models: ReadonlyArray<Model>
  onClose: () => void
}) {
  const form = useDurableForm<MassForm>(`model-mass-edit:${place}`, "Edit models", {
    ids: ids ?? [],
    ticked: [],
    draft: null
  })
  const chosen = ids ?? form.values.ids
  const selected = useMemo(() => {
    const wanted = new Set(chosen)
    return models.filter((model) => wanted.has(model.id))
  }, [models, chosen])
  // What the models share: the fields they differ in say so.
  const common = useMemo(() => commonOf(selected), [selected])
  const kept = form.values.draft
  const values =
    kept === null ? common.draft : readDraft(typeof kept === "string" ? kept : JSON.stringify(kept), common.draft)
  const ticked = new Set(form.values.ticked)
  const [submitted, setSubmitted] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const save = useAction()
  const undo = useAction()

  // After a reload, a dialog nobody typed into has no models left to edit: it closes.
  const empty = form.ready && selected.length === 0
  useEffect(() => {
    if (empty) onClose()
  }, [empty, onClose])

  const change = (next: Draft, extra: ReadonlyArray<FieldId> = []) => {
    const edited = new Set([...extra, ...fieldsChanged(values, next)])
    form.edit({
      ids: chosen,
      draft: next,
      ticked: FIELD_IDS.filter((id) => ticked.has(id) || edited.has(id))
    })
  }
  const tick = (field: FieldId, on: boolean) =>
    form.edit({
      ids: chosen,
      ticked: FIELD_IDS.filter((id) => (id === field ? on : ticked.has(id)))
    })

  // Each model's limits as Context and Reply length keep within, with the new ones when ticked.
  const ownContext = ticked.has("context") ? wholeText(values.context).value : undefined
  const ownOutput = ticked.has("maxOutput") ? wholeText(values.maxOutput).value : undefined
  const targets = selected.map((model) => {
    const limits = effectiveLimits(model)
    return {
      id: model.id,
      limits: {
        context: (ownContext === undefined ? model.overrides.context : ownContext) ?? limits.context.value,
        maxOutput: (ownOutput === undefined ? model.overrides.maxOutput : ownOutput) ?? limits.maxOutput.value
      }
    }
  })
  const tickedList = FIELD_IDS.filter((id) => ticked.has(id))
  const patches = tickedList.length > 0 ? massPatches(values, tickedList, targets) : []
  const changes = wouldChange(selected, patches)

  const close = () => {
    void form.discard()
    onClose()
  }

  const submit = async () => {
    setSubmitted(true)
    setProblem(null)
    const typed = draftProblems(values)
    const fieldOf = (key: string) =>
      tickedList.some((id) =>
        MODEL_FIELDS[id].paths.some((path) => key === path.join(".") || key === `overrides.${path.join(".")}`)
      )
    const limitProblem =
      (ticked.has("context") && wholeText(values.context).problem) ||
      (ticked.has("maxOutput") && wholeText(values.maxOutput).problem)
    const biasProblem = ticked.has("logit_bias") && (values.rows["settings.logit_bias"] ?? []).some(biasRowProblem)
    if (Object.keys(typed).some(fieldOf) || limitProblem || biasProblem) {
      setProblem("Check the fields marked below.")
      return
    }
    let checked: ModelPatches
    try {
      checked = patches.map((patch) => ({
        modelIds: patch.modelIds,
        paths: patch.paths,
        values: Schema.decodeUnknownSync(ModelOverrides)(patch.values)
      })) as unknown as ModelPatches
    } catch {
      setProblem("A ticked setting has a value these models can’t take. Check its rows.")
      return
    }
    const names = tickedList.map((id) => MODEL_FIELDS[id].label)
    let done: ModelPatchResult | null = null
    const ok = await form.commit(async () => {
      const result = await save.run((client) => client("EditModels", { patches: checked }), ["models"])
      if (result.ok) done = result.value
      return result.ok
    })
    if (!ok || done === null) return
    const changed = (done as ModelPatchResult).changed
    onClose()
    if (changed.length === 0) {
      showToast({ title: "Nothing changed", description: "The selected models already had these settings." })
      return
    }
    showToast({
      title: `${modelsLabel(changed.length)} changed`,
      description: names.join(", "),
      actions: [
        {
          label: "Undo",
          hint: "Puts back the settings these models had before.",
          onClick: () =>
            void undo
              .run(
                (client) =>
                  client("EditModels", {
                    patches: changed.map((entry) => ({
                      modelIds: [entry.modelId],
                      paths: entry.paths,
                      values: entry.values
                    })) as unknown as ModelPatches
                  }),
                ["models"]
              )
              .then((result) => {
                if (!result.ok) showToast({ title: "Couldn’t undo", description: result.error.message })
              })
        }
      ]
    })
  }

  if (selected.length === 0) return null
  return (
    <Dialog open size="wide" onOpenChange={(open) => !open && close()} title={`Edit ${modelsLabel(selected.length)}`}>
      <div className="@container flex min-w-0 flex-col gap-5 [overflow-wrap:anywhere]" data-model-mass-edit="">
        <ModelFields
          models={selected}
          many
          values={values}
          update={(next) => change(next)}
          submitted={submitted}
          top={
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted">
                Ticked settings are saved on all {modelsLabel(selected.length)}; the rest stay as each model has them.
              </p>
              <CopySettingsButton
                label="Copy settings from a model…"
                hint="Fills in every setting that model has and ticks each one. Untick any you don’t want before saving."
                onCopy={(source) => {
                  const fields = fieldsSet(source.overrides)
                  change(copyFields(values, source.overrides, fields), fields)
                }}
              />
            </div>
          }
          wrap={(field, node) => (
            <Ticked
              field={field}
              ticked={ticked.has(field)}
              mixed={common.mixed[field]}
              onTick={(on) => tick(field, on)}
            >
              {node}
            </Ticked>
          )}
        />
        {problem && (
          <Alert tone="danger" title="Not saved">
            {problem}
          </Alert>
        )}
        <ErrorAlert error={save.error} title="Not saved" />
      </div>
      <DialogActions>
        <Button variant="ghost" hint="Closes this without changing any model." onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={tickedList.length === 0}
          pending={save.pending}
          hint={
            tickedList.length === 0
              ? "Tick or change a setting to save it on the selected models."
              : `Saves the ${tickedList.length === 1 ? "ticked setting" : `${tickedList.length} ticked settings`} on the selected models: ${changes === 0 ? "none of them would change" : `${modelsLabel(changes)} change`}.`
          }
          onClick={() => void submit()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}
