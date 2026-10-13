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

/** Loaded once `enabled` turns true. */
export function useModelChoices(enabled: boolean) {
  const action = useAction()
  const [models, setModels] = useState<ReadonlyArray<ModelChoice>>([])
  useEffect(() => {
    if (!enabled) return
    void action
      .run((client) =>
        Effect.gen(function* () {
          const connections: ReadonlyArray<Connection> = yield* client("ListConnections", undefined)
          const lists = yield* Effect.forEach(connections, (connection) =>
            Effect.map(
              client("ListModels", { connectionId: connection.id, includeHidden: false }),
              (list: ReadonlyArray<Model>) =>
                list.map((model) => ({
                  value: modelValue(connection.id, model.id),
                  label: `${connection.name} · ${model.key}`
                }))
            )
          )
          return lists.flat()
        })
      )
      .then((result) => result.ok && setModels(result.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when enabled
  }, [enabled])
  return models
}
