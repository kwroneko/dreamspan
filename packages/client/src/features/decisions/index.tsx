// Decision models (spec/AGENTIC.md §7; DESIGN §7.6 [D]: optional, a fallback at each point).
// Two parts, each registered like a plugin's: the Decisions section of a decision connection's
// page, where the user picks its model and turns points on (owner rule: nothing is sent to a
// provider without the user's opt-in per connection), and a lorebook entry's question for the
// decision model.
import { useAtomValue } from "@effect/atom-react"
import type { ConnectionDecisions, DecisionPointInfo, DecisionPointSetting } from "@rp/shared/decisions.ts"
import { type Model, resolveModel } from "@rp/shared/providers.ts"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { ModelSelect } from "../pickers/ModelPicker.tsx"
import { modelValue, parseModelValue, type ModelChoice } from "../chat/modelChoices.ts"
import { Slider } from "../../ui/Slider.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { modelsAtom } from "../connections/data.ts"
import { connectionSections, type ConnectionSectionProps } from "../connections/detail.tsx"
import { TextField } from "../editor/controls.tsx"
import { lorebookEntrySettings } from "../editor/lorebookSettings.ts"

const pointsAtom = AppClient.query("ListDecisionPoints", undefined, { timeToLive: "5 minutes" })
const settingsAtom = AppClient.query("GetDecisionSettings", undefined, { reactivityKeys: ["decisions"] })

const NONE = "none"

/**
 * Whether a decision point may ask: registered, and on for a connection whose decision model is
 * chosen (what the server checks before it sends anything).
 */
export const useDecisionPointOn = (pointId: string): boolean => {
  const points = useAtomValue(pointsAtom)
  const settings = useAtomValue(settingsAtom)
  return (
    AsyncResult.isSuccess(points) &&
    AsyncResult.isSuccess(settings) &&
    points.value.some((point) => point.id === pointId) &&
    settings.value.some((entry) => entry.model !== null && entry.points[pointId]?.on === true)
  )
}

const modelName = (model: Model) => resolveModel(model.key, model.upstream, model.overrides).name.value

/** One point's switch and, while it's on, how sure the model must be. */
function PointRow({
  point,
  setting,
  disabled,
  onChange
}: {
  point: DecisionPointInfo
  setting: DecisionPointSetting
  disabled: boolean
  onChange: (next: DecisionPointSetting) => void
}) {
  // The slider shows its value as it moves and saves once it's let go.
  const [dragging, setDragging] = useState<number | null>(null)
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <Switch
        checked={setting.on}
        disabled={disabled}
        onCheckedChange={(on) => onChange({ ...setting, on })}
        hint={
          setting.on
            ? `Click to stop asking about ${point.label.toLowerCase()}`
            : `Click to ask about ${point.label.toLowerCase()}`
        }
        description={point.description}
      >
        {point.label}
      </Switch>
      {setting.on && (
        <div className="pl-12">
          <Slider
            label="Confidence needed"
            about="How sure the model must be before its answer is used. Below it, the app decides as it does without a model."
            value={dragging ?? setting.threshold}
            min={0.5}
            max={1}
            step={0.05}
            valueText={(value) => `${Math.round(value * 100)}%`}
            onValueChange={setDragging}
            onValueCommitted={(threshold) => {
              setDragging(null)
              onChange({ ...setting, threshold })
            }}
          />
        </div>
      )}
    </div>
  )
}

function DecisionsSection({ connection, kinds }: ConnectionSectionProps) {
  const points = useAtomValue(pointsAtom)
  const settings = useAtomValue(settingsAtom)
  const models = useAtomValue(modelsAtom(connection.id, true))
  const action = useAction()
  // Only a connection whose kind answers decision questions has decisions to make.
  if (!kinds.find((kind) => kind.id === connection.kind)?.decisions) return null
  if (!AsyncResult.isSuccess(points) || !AsyncResult.isSuccess(settings) || !AsyncResult.isSuccess(models)) return null
  const own: ConnectionDecisions = settings.value.find((entry) => entry.connectionId === connection.id) ?? {
    connectionId: connection.id,
    model: null,
    points: {}
  }
  const save = (next: Pick<ConnectionDecisions, "model" | "points">) =>
    void action.run((client) => client("SetDecisionSettings", { connectionId: connection.id, ...next }), ["decisions"])
  const items: Array<ModelChoice> = [
    { value: NONE, label: "None", description: "Nothing is asked." },
    ...models.value
      .filter((model) => !model.hidden || model.id === own.model)
      .map((model) => ({
        value: modelValue(connection.id, model.id),
        label: `${connection.name} · ${model.key}${model.hidden ? " (hidden)" : ""}`,
        connectionId: connection.id,
        connectionName: connection.name,
        modelKey: model.key,
        name: modelName(model)
      }))
  ]
  const chosen = own.model !== null && models.value.some((model) => model.id === own.model) ? own.model : null
  return (
    <Card>
      <CardHeader
        title="Decisions"
        about="Choose what this connection's decision model decides. Nothing is sent to it until you turn a decision on."
      />
      <div className="flex flex-col gap-4">
        <Field
          label="Decision model"
          description={models.value.length === 0 ? "Add the model by its id under Models first." : undefined}
        >
          <ModelSelect
            ariaLabel="Decision model"
            items={items}
            value={chosen ? modelValue(connection.id, chosen) : NONE}
            onValueChange={(next) =>
              save({ model: next === NONE ? null : parseModelValue(next).model, points: own.points })
            }
          />
        </Field>
        <div className="flex flex-col gap-3">
          {points.value.map((point) => (
            <PointRow
              key={point.id}
              point={point}
              setting={own.points[point.id] ?? { on: false, threshold: point.defaultThreshold }}
              disabled={chosen === null}
              onChange={(next) => save({ model: chosen, points: { ...own.points, [point.id]: next } })}
            />
          ))}
        </div>
        {chosen === null && <p className="text-sm text-muted">Choose the decision model to turn decisions on.</p>}
      </div>
      <ErrorAlert error={action.error} title="Couldn't change it" />
    </Card>
  )
}

const QUESTION_ABOUT =
  "A statement about the story, such as “The airship is near the characters.” When the entry's keys don't match, a decision model you've turned on for lorebook entries judges it before each reply, and the entry is included when it holds."

export const register = () => {
  connectionSections.register({ id: "decisions", order: 45, component: DecisionsSection })
  lorebookEntrySettings.register({
    id: "decision_hint",
    order: 1000,
    section: "matching",
    label: "Question for the decision model",
    description: QUESTION_ABOUT,
    input: { kind: "text" },
    current: (entry) => entry.decision_hint ?? "",
    patch: (value) => ({ decision_hint: String(value ?? "") }),
    many: false,
    single: ({ store, path }) => (
      <TextField
        store={store}
        path={[...path, "decision_hint"]}
        label="Question for the decision model"
        about={QUESTION_ABOUT}
      />
    )
  })
}
