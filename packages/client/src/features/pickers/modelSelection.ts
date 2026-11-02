// The account's model and the models to choose from, as every model picker reads them: the
// composer's chip and the Model tab.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { type ModelChoice, modelValue, parseModelValue, useModelChoiceList } from "../chat/modelChoices.ts"
import type { ChatSession } from "../chat/session.ts"
import { defaultsAtom, useRefreshOnContext } from "./defaults.ts"

const modelUseAtom = AppClient.query("ListModelUse", undefined, { reactivityKeys: ["models", "settings"] })

export interface ModelSelection {
  /** False until the account's choice and the model lists are read. */
  readonly loaded: boolean
  /** The chosen model's `modelValue`, or null with none chosen. */
  readonly value: string | null
  /** The chosen model as listed; undefined when none is chosen or no list has it. */
  readonly current: ModelChoice | undefined
  /** Hidden models are left out, except the current one, named as hidden. */
  readonly models: ReadonlyArray<ModelChoice>
  /** A model's last reply for the user, by its `modelValue`. */
  readonly used: ReadonlyMap<string, number>
  /** Exactly what choosing in the composer does: the account's model, for every chat's next reply. */
  readonly choose: (value: string) => Promise<boolean>
  readonly refresh: () => void
  readonly error: ReturnType<typeof useAction>["error"]
}

export function useModelSelection(session: ChatSession | null): ModelSelection {
  const action = useAction()
  const defaults = useAtomValue(defaultsAtom)
  const use = useAtomValue(modelUseAtom)
  const refreshUse = useAtomRefresh(modelUseAtom)
  useRefreshOnContext(session, defaultsAtom)
  const chosen = AsyncResult.isSuccess(defaults) ? defaults.value.model : undefined
  const value = chosen ? modelValue(chosen.connection, chosen.model) : null
  const { choices, loaded } = useModelChoiceList(true, value)
  const used = new Map(
    AsyncResult.isSuccess(use)
      ? use.value.map((row) => [modelValue(row.connectionId, row.modelId), row.lastUsedAt])
      : []
  )
  return {
    loaded: loaded && chosen !== undefined,
    value,
    current: choices.find((model) => model.value === value),
    models: choices,
    used,
    choose: (next) =>
      action
        .run((client) => client("ChangeGenerationDefaults", { change: { model: parseModelValue(next) } }), ["settings"])
        .then((result) => result.ok),
    refresh: refreshUse,
    error: action.error
  }
}
