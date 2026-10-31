import { notifyLibraryChange } from "./libraryChanges.ts"
// Calling the server from components: queries render through `AsyncView`, and actions
// (writes) run through `useAction`, which tracks their pending state and error. Both send
// the user back to login when the session has ended.
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause, Context, Effect, Exit } from "effect"
import { AsyncResult, Atom, AtomRegistry, Reactivity } from "effect/reactivity"
import { type ReactNode, useContext, useEffect, useState } from "react"
import { type AppError, describeCause } from "./errors.ts"
import { AppClient } from "./rpc.ts"
import { sessionAtom } from "./session.ts"
import { Button } from "./ui/Button.tsx"
import { Loading } from "./ui/Spinner.tsx"
import { Alert } from "./ui/Surface.tsx"

type ActionResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: AppError }

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

export function FailureView({ cause, onRetry }: { cause: Cause.Cause<unknown>; onRetry: () => void }) {
  const registry = useContext(RegistryContext)
  const error = describeCause(cause)
  const unauthorized = error.tag === "Unauthorized"
  useEffect(() => {
    if (unauthorized) registry.refresh(sessionAtom)
  }, [unauthorized, registry])
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
export function AsyncView<A, E>({
  atom,
  loading,
  children
}: {
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>
  loading?: string | undefined
  children: (value: A, waiting: boolean) => ReactNode
}) {
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  return AsyncResult.match(result, {
    onInitial: () => <Loading label={loading} onRetry={refresh} />,
    onFailure: (failure) => <FailureView cause={failure.cause} onRetry={refresh} />,
    onSuccess: (success) => children(success.value, success.waiting)
  })
}
