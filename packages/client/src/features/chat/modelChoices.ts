// The user's models as picker items, "connection · model", for the places that choose one.
import type { Connection, Model } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"

export interface ModelChoice {
  readonly value: string
  readonly label: string
}

export const modelValue = (connection: string, model: string) => `${connection} ${model}`
export const parseModelValue = (value: string) => {
  const [connection, model] = value.split(" ") as [Connection["id"], Model["id"]]
  return { connection, model }
}

/**
 * Loaded once `enabled` turns true. Hidden models are left out, except `current` (a `modelValue`),
 * which is still in use and named as hidden.
 */
export function useModelChoices(enabled: boolean, current: string | null = null): ReadonlyArray<ModelChoice> {
  return useModelChoiceList(enabled, current).choices
}

/**
 * The choices, and whether they've been read: read once `enabled` turns true, and again when
 * `current` turns out not to be among them (a model added since, in another tab, say).
 */
export function useModelChoiceList(
  enabled: boolean,
  current: string | null = null
): { readonly choices: ReadonlyArray<ModelChoice>; readonly loaded: boolean } {
  const action = useAction()
  const [models, setModels] = useState<ReadonlyArray<ModelChoice & { readonly hidden: boolean }> | null>(null)
  const missing = models !== null && current !== null && !models.some((model) => model.value === current)
  // A model missing from the list is looked for once more, not on every render.
  const [lookedFor, setLookedFor] = useState<string | null>(null)
  if (missing && lookedFor !== current) setLookedFor(current)
  useEffect(() => {
    if (!enabled) return
    void action
      .run((client) =>
        Effect.gen(function* () {
          const connections: ReadonlyArray<Connection> = yield* client("ListConnections", undefined)
          const lists = yield* Effect.forEach(connections, (connection) =>
            Effect.map(
              client("ListModels", { connectionId: connection.id, includeHidden: true }),
              (list: ReadonlyArray<Model>) =>
                list.map((model) => ({
                  value: modelValue(connection.id, model.id),
                  label: `${connection.name} · ${model.key}`,
                  hidden: model.hidden
                }))
            )
          )
          return lists.flat()
        })
      )
      // A list that can't be read is an empty one, so nothing waits on it for good.
      .then((result) => setModels(result.ok ? result.value : []))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once when enabled, and once per missing model
  }, [enabled, lookedFor])
  return {
    loaded: models !== null,
    choices: (models ?? []).flatMap(({ hidden, ...choice }) =>
      !hidden ? [choice] : choice.value === current ? [{ ...choice, label: `${choice.label} (hidden)` }] : []
    )
  }
}
