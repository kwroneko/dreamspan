// The user's models as picker items, "connection · model", for the places that choose one.
import { resolveModel, type Connection, type Model } from "@rp/shared/providers.ts"
import { Cause, Effect, Exit } from "effect"
import { useEffect, useMemo, useState } from "react"
import { type ActionResult, useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { describeCause } from "../../errors.ts"
import type { AppClient } from "../../rpc.ts"

export interface ModelChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly connectionId?: string
  readonly connectionName?: string
  readonly modelKey?: string
  readonly name?: string
  readonly hidden?: boolean
  /** Its context window in tokens; `assumed` when nothing reports it (ASSUMED_CONTEXT). */
  readonly window?: { readonly tokens: number; readonly assumed: boolean }
}

export const modelValue = (connection: string, model: string) => `${connection} ${model}`
export const parseModelValue = (value: string) => {
  const [connection, model] = value.split(" ") as [Connection["id"], Model["id"]]
  return { connection, model }
}

/** A connection whose models couldn't be read: the others' are still listed. */
interface ModelListFailure {
  readonly connection: string
  readonly message: string
}

export interface ModelChoiceList {
  readonly choices: ReadonlyArray<ModelChoice>
  /** Read, whether or not every connection answered. */
  readonly loaded: boolean
  /** The connections that were read, so an empty list can say whether there are any. */
  readonly connections: number
  /** Connections whose models couldn't be read. */
  readonly failed: ReadonlyArray<ModelListFailure>
  /** Why the connections themselves couldn't be listed: nothing is, then. */
  readonly error: string | null
  /** Reads them all again. */
  readonly retry: () => void
}

/** One connection's read waits this long at most: a busy server mustn't keep a picker loading for good. */
const READ_TIMEOUT = "20 seconds"

const failureMessage = (cause: Cause.Cause<unknown>) =>
  Cause.isTimeoutError(Cause.squash(cause)) ? `It didn't answer within ${READ_TIMEOUT}.` : describeCause(cause).message

/**
 * Loaded once `enabled` turns true. Hidden models are left out, except `current` (a `modelValue`),
 * which is still in use and named as hidden.
 */
export function useModelChoices(
  enabled: boolean,
  current: string | ReadonlyArray<string> | null = null
): ReadonlyArray<ModelChoice> {
  return useModelChoiceList(enabled, current).choices
}

interface Read {
  readonly models: ReadonlyArray<ModelChoice & { readonly hidden: boolean }>
  readonly connections: number
  readonly failed: ReadonlyArray<ModelListFailure>
  readonly error: string | null
}

/**
 * Every connection's models, each connection read on its own (four at a time, each for
 * `READ_TIMEOUT` at most): one that fails leaves the others' listed and is named in `failed`.
 */
export const readModelChoices = (client: AppClient["Service"]) =>
  Effect.gen(function* () {
    // Connections that answer decision questions write no replies (spec/AGENTIC.md §7): not offered.
    const decisionKinds = new Set(
      (yield* client("ListProviderKinds", undefined)).flatMap((kind) => (kind.decisions ? [kind.id as string] : []))
    )
    const connections: ReadonlyArray<Connection> = (yield* client("ListConnections", undefined)).filter(
      (connection) => !decisionKinds.has(connection.kind)
    )
    const lists = yield* Effect.forEach(
      connections,
      (connection) =>
        Effect.exit(
          client("ListModels", { connectionId: connection.id, includeHidden: true }).pipe(Effect.timeout(READ_TIMEOUT))
        ).pipe(Effect.map((exit) => ({ connection, exit }))),
      { concurrency: 4 }
    )
    return {
      connections: connections.length,
      models: lists.flatMap(({ connection, exit }) =>
        Exit.isSuccess(exit)
          ? exit.value.map((model: Model) => ({
              value: modelValue(connection.id, model.id),
              label: `${connection.name} · ${model.key}`,
              connectionId: connection.id,
              connectionName: connection.name,
              modelKey: model.key,
              name: resolveModel(model.key, model.upstream, model.overrides).name.value,
              window: (() => {
                const { context } = resolveModel(model.key, model.upstream, model.overrides)
                return { tokens: context.value, assumed: context.source === "unknown" }
              })(),
              hidden: model.hidden
            }))
          : []
      ),
      failed: lists.flatMap(({ connection, exit }) =>
        Exit.isFailure(exit) ? [{ connection: connection.name, message: failureMessage(exit.cause) }] : []
      ),
      error: null
    } satisfies Read
  })

/**
 * The choices, and how reading them went: read once `enabled` turns true, again when
 * `current` turns out not to be among them (a model added since, in another tab, say), and
 * on `retry`. Each connection is read on its own, so one that fails (or times out) leaves
 * the others' models listed and is named in `failed`.
 */
/**
 * The last read, each user's, and the one under way: the composer's chip and the Model tab
 * mount together, and every chat opened mounts them again. Each shows the last read at once
 * and has it read again behind it, one read for all of them (night/tabperf: each mount read
 * every connection's models anew, the provider's list for each).
 */
const lastReads = new Map<string, Read>()
let reading: { readonly userId: string; readonly done: Promise<ActionResult<Read>> } | null = null

export function useModelChoiceList(
  enabled: boolean,
  current: string | ReadonlyArray<string> | null = null
): ModelChoiceList {
  const action = useAction()
  const userId = useSession().user.id
  const [ownRead, setRead] = useState<Read | null>(null)
  // Until this one's read lands, the last read, if there is one.
  const read = ownRead ?? (enabled ? (lastReads.get(userId) ?? null) : null)
  const currentKey = typeof current === "string" ? current : (current ?? []).join("\n")
  const currentValues = useMemo(() => (currentKey ? currentKey.split("\n") : []), [currentKey])
  const missing =
    read === null ? null : (currentValues.find((value) => !read.models.some((model) => model.value === value)) ?? null)
  // A model missing from the list is looked for once more, not on every render.
  const [lookedFor, setLookedFor] = useState<string | null>(null)
  if (missing && lookedFor !== missing) setLookedFor(missing)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    if (reading === null || reading.userId !== userId) {
      const done = action.run((client) => readModelChoices(client))
      reading = { userId, done }
      void done.then((result) => {
        if (reading?.done === done) reading = null
        if (result.ok) lastReads.set(userId, result.value)
      })
    }
    void reading.done.then((result) => {
      if (!live) return
      setRead(result.ok ? result.value : { models: [], connections: 0, failed: [], error: result.error.message })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once when enabled, once per missing model, and per retry
  }, [enabled, lookedFor, attempt])
  const choices = useMemo(
    () =>
      (read?.models ?? []).flatMap(({ hidden, ...choice }) =>
        !hidden
          ? [choice]
          : currentValues.includes(choice.value)
            ? [{ ...choice, hidden: true, label: `${choice.label} (hidden)`, name: `${choice.name} (hidden)` }]
            : []
      ),
    [read, currentValues]
  )
  return {
    loaded: read !== null,
    connections: read?.connections ?? 0,
    failed: read?.failed ?? [],
    error: read?.error ?? null,
    retry: () => {
      setRead(null)
      setAttempt((n) => n + 1)
    },
    choices
  }
}
