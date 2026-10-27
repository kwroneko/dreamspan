import { notifyLibraryChange } from "../../libraryChanges.ts"
// RPCs from the editor's store, outside a component: the same client and reactivity as
// `useAction`, without a component's pending state. A write invalidates the library's lists.
import { RegistryContext } from "@effect/atom-react"
import { Cause, Context, Effect, Exit } from "effect"
import { AtomRegistry, Reactivity } from "effect/reactivity"
import { useContext, useMemo } from "react"
import { type AppError, describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { sessionAtom } from "../../session.ts"

export type CallResult<A> =
  | { readonly ok: true; readonly value: A }
  /** `cause` is the error itself, for errors that carry data (an edit conflict's fields). */
  | { readonly ok: false; readonly error: AppError; readonly cause: unknown }

export type Caller = <A, E>(
  call: (client: AppClient["Service"]) => Effect.Effect<A, E>,
  invalidates?: ReadonlyArray<string>
) => Promise<CallResult<A>>

/** A caller that stays the same across renders, so effects can depend on it. */
export function useCaller(): Caller {
  const registry = useContext(RegistryContext)
  return useMemo(() => makeCaller(registry), [registry])
}

const makeCaller =
  (registry: AtomRegistry.AtomRegistry): Caller =>
  async (call, invalidates = []) => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const services = yield* AtomRegistry.getResult(registry, AppClient.runtime)
        const outcome = yield* Effect.exit(call(Context.get(services, AppClient)))
        const refused = Exit.isFailure(outcome) && describeCause(outcome.cause).tag === "EditRefused"
        if ((Exit.isSuccess(outcome) || refused) && invalidates.length > 0) {
          Context.get(
            services as unknown as Context.Context<Reactivity.Reactivity>,
            Reactivity.Reactivity
          ).invalidateUnsafe(invalidates)
          notifyLibraryChange(invalidates)
        }
        return yield* outcome
      })
    )
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
    const error = describeCause(exit.cause)
    if (error.tag === "Unauthorized") registry.refresh(sessionAtom)
    return { ok: false, error, cause: Cause.squash(exit.cause) }
  }
