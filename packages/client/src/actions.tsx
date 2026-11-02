import { notifyLibraryChange } from "./libraryChanges.ts"
// Calling the server from components: queries render through `AsyncView`, and actions
// (writes) run through `useAction`, which tracks their pending state and error. Both send
// the user back to login when the session has ended.
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause, Context, Effect, Exit } from "effect"
import { AsyncResult, Atom, AtomRegistry, Reactivity } from "effect/reactivity"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { type AppError, describeCause } from "./errors.ts"
import { AppClient } from "./rpc.ts"
import { sessionAtom } from "./session.ts"
import { Button } from "./ui/Button.tsx"
import { Loading } from "./ui/Spinner.tsx"
import { Alert } from "./ui/Surface.tsx"

export type ActionResult<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: AppError }

/**
 * Runs RPCs as the user. Calls don't cancel each other, unlike a shared mutation atom.
 * `invalidates` names the reactivity keys of the queries the write changes. They're
 * reloaded after a success, and after a StaleWrite, which means they're out of date.
 */
export function useAction() {
  const registry = useContext(RegistryContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const run = async <A, E>(
    call: (client: AppClient["Service"]) => Effect.Effect<A, E>,
    invalidates: ReadonlyArray<string> = []
  ): Promise<ActionResult<A>> => {
    setPending(true)
    setError(null)
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const services = yield* AtomRegistry.getResult(registry, AppClient.runtime)
        // The runtime holds the same Reactivity instance the queries subscribe to.
        const reactivity = Context.get(
          services as unknown as Context.Context<Reactivity.Reactivity>,
          Reactivity.Reactivity
        )
        const outcome = yield* Effect.exit(call(Context.get(services, AppClient)))
        const stale =
          Exit.isFailure(outcome) && ["StaleWrite", "EditRefused"].includes(describeCause(outcome.cause).tag)
        if ((Exit.isSuccess(outcome) || stale) && invalidates.length > 0) {
          reactivity.invalidateUnsafe(invalidates)
          notifyLibraryChange(invalidates)
        }
        return yield* outcome
      })
    )
    setPending(false)
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
    const described = describeCause(exit.cause)
    setError(described)
    if (described.tag === "Unauthorized") registry.refresh(sessionAtom)
    return { ok: false, error: described }
  }

  return { run, pending, error, clearError: () => setError(null) }
}

/**
 * Reloads the queries of these reactivity keys in this tab, as a write's `invalidates`
 * does, for a change the server announced (a notice) rather than one this tab made.
 */
export const invalidateKeys = (registry: AtomRegistry.AtomRegistry, keys: ReadonlyArray<string>) =>
  Effect.runFork(
    Effect.map(AtomRegistry.getResult(registry, AppClient.runtime), (services) =>
      Context.get(
        services as unknown as Context.Context<Reactivity.Reactivity>,
        Reactivity.Reactivity
      ).invalidateUnsafe(keys)
    )
  )

/** An error from the server, as an alert. */
export function ErrorAlert({ error, title, actions }: { error: AppError | null; title?: string; actions?: ReactNode }) {
  if (error === null) return null
  return (
    <Alert tone="danger" title={title} actions={actions}>
      <p>{error.message}</p>
      {error.problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {error.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </Alert>
  )
}

/** When reads were last asked again by themselves after the connection dropped (see FailureView). */
const autoRetries: Array<number> = []
const AUTO_RETRIES = 5
const AUTO_RETRY_WINDOW_MS = 60_000

/** Whether the server answers its health check, over plain HTTP, within a few seconds. */
const serverAnswers = async () => {
  try {
    const response = await fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(5_000) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * A query's failure, with a retry. A read lost with the connection isn't a dead server: the
 * socket drops when the server's answers are slow to arrive (a missed ping), and reconnects.
 * While the server answers its health check, the read is asked again by itself and this says
 * `still` with a spinner; "Can't reach the server" shows only when the server doesn't answer,
 * or when the connection keeps dropping (more than five times a minute).
 */
export function FailureView({
  cause,
  onRetry,
  still = "Still loading…"
}: {
  cause: Cause.Cause<unknown>
  onRetry: () => void
  still?: string | undefined
}) {
  const registry = useContext(RegistryContext)
  const error = describeCause(cause)
  const unauthorized = error.tag === "Unauthorized"
  const transport = error.tag === "RpcClientError"
  const [reachable, setReachable] = useState<boolean | null>(null)
  const retry = useRef(onRetry)
  useEffect(() => {
    retry.current = onRetry
  })
  useEffect(() => {
    if (unauthorized) registry.refresh(sessionAtom)
  }, [unauthorized, registry])
  useEffect(() => {
    if (!transport) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    void serverAnswers().then((answers) => {
      if (!live) return
      const now = Date.now()
      while (autoRetries.length > 0 && autoRetries[0]! < now - AUTO_RETRY_WINDOW_MS) autoRetries.shift()
      const again = answers && autoRetries.length < AUTO_RETRIES
      setReachable(again)
      if (again) {
        autoRetries.push(now)
        timer = setTimeout(() => retry.current(), 1_000)
      }
    })
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [transport])
  if (transport && reachable !== false) return <Loading label={still} />
  return (
    <ErrorAlert
      error={error}
      actions={
        <Button variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  )
}

/**
 * Several queries as one result, all requested at once (nested `AsyncView`s would wait
 * for each before asking for the next). A retry refreshes each.
 */
export const allOf = <const Atoms extends Record<string, Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>>(
  atoms: Atoms
) =>
  Atom.readable(
    (get) =>
      AsyncResult.all(
        Object.fromEntries(Object.entries(atoms).map(([key, atom]) => [key, get(atom)])) as {
          [K in keyof Atoms]: Atom.Type<Atoms[K]>
        }
      ),
    (refresh) => {
      for (const atom of Object.values(atoms)) refresh(atom)
    }
  )

/** A query's result: loading, an error with a retry, or the value. */
/**
 * A query kept a while after its last reader left (`timeToLive`), read again behind what it
 * kept: what was read shows at once when a screen comes back (a tab, after another chat),
 * and the fresh read replaces it (night/tabperf).
 */
export function useAtomRevalidated<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  const registry = useContext(RegistryContext)
  const result = useAtomValue(atom)
  const [kept] = useState(() => AsyncResult.isSuccess(registry.get(atom)))
  useEffect(() => {
    let active = revalidatedReaders.get(registry)
    if (!active) revalidatedReaders.set(registry, (active = new WeakMap()))
    const readers = active.get(atom) ?? 0
    active.set(atom, readers + 1)
    // Joining another mounted reader needs no second refresh. Writes still invalidate
    // the query, and the first reader after an absence revalidates the retained result.
    if (readers === 0 && kept && !registry.get(atom).waiting) registry.refresh(atom)
    return () => {
      active.set(atom, (active.get(atom) ?? 1) - 1)
    }
  }, [kept, registry, atom])
  return result
}

const revalidatedReaders = new WeakMap<AtomRegistry.AtomRegistry, WeakMap<object, number>>()

export function AsyncView<A, E>({
  atom,
  loading,
  still,
  children
}: {
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>
  loading?: string | undefined
  /** What a read lost with the connection says while it's asked again (FailureView). */
  still?: string | undefined
  children: (value: A, waiting: boolean) => ReactNode
}) {
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  return AsyncResult.match(result, {
    onInitial: () => <Loading label={loading} onRetry={refresh} />,
    onFailure: (failure) => <FailureView cause={failure.cause} onRetry={refresh} still={still} />,
    onSuccess: (success) => children(success.value, success.waiting)
  })
}
